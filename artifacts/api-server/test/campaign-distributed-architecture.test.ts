import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("two CampaignRuntime processes distribute and fence phones through Redis", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "campaign-distributed-"));
  const dist = path.join(artifactDir, ".test-dist", "distributed-runtime");
  const harness = path.join(dist, "runtime-architecture-harness.mjs");
  const providerLog = path.join(work, "provider.log");
  const redisPort = 6391;
  const redis = spawn("redis-server", ["--port", String(redisPort), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], { stdio: "ignore" });
  const children: ChildProcess[] = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(dist, { recursive: true, force: true });
    await build({
      entryPoints: [path.join(artifactDir, "test/runtime-architecture-harness.ts")],
      outfile: harness, bundle: true, platform: "node", format: "esm",
      external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
    });
    await build({
      entryPoints: [path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts")],
      outfile: path.join(dist, "campaign-transport-shard-worker.mjs"),
      bundle: true, platform: "node", format: "esm",
      external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
    });
    const start = () => new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, [harness], {
        cwd: artifactDir, stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, CAMPAIGN_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`, CAMPAIGN_TEST_PROVIDER_LOG: providerLog },
      });
      child.once("error", reject);
      child.on("message", (message: any) => { if (message.ready) resolve(child); });
    });
    const [a, b] = await Promise.all([start(), start()]);
    children.push(a, b);
    let nextId = 1;
    const rpc = (child: ChildProcess, command: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const listener = (message: any) => {
        if (message.id !== id) return;
        child.off("message", listener);
        message.ok ? resolve(message.result) : reject(new Error(message.error));
      };
      child.on("message", listener);
      child.send({ id, ...command });
    });
    const organizationId = Date.now();
    const phones = [101, 102, 103, 104];
    const [ownedA, ownedB] = await Promise.all([
      rpc(a, { command: "acquire", organizationId, phoneNumberIds: phones.slice(0, 2), ttlMs: 2_000 }),
      rpc(b, { command: "acquire", organizationId, phoneNumberIds: phones.slice(2), ttlMs: 2_000 }),
    ]);
    const conflictA = await rpc(a, { command: "acquire", organizationId, phoneNumberIds: phones.slice(2), ttlMs: 2_000 });
    const conflictB = await rpc(b, { command: "acquire", organizationId, phoneNumberIds: phones.slice(0, 2), ttlMs: 2_000 });
    assert.ok(ownedA.every((item: any) => item.owned));
    assert.ok(ownedB.every((item: any) => item.owned));
    assert.ok(conflictA.every((item: any) => !item.owned));
    assert.ok(conflictB.every((item: any) => !item.owned));
    const initial = await Promise.all(phones.map((phone, index) => rpc(index < 2 ? a : b, { command: "dispatch", phoneNumberId: phone })));
    assert.deepEqual(initial.map((item) => item.shardId), phones.map((phone) => ownedA.concat(ownedB).find((x: any) => x.phoneNumberId === phone).shardId));

    const oldToken = ownedA[0].fencingToken;
    await rpc(a, { command: "release", organizationId, phoneNumberId: 101, fencingToken: oldToken });
    const transferred = (await rpc(b, { command: "acquire", organizationId, phoneNumberIds: [101], ttlMs: 2_000 }))[0];
    assert.equal(transferred.owned, true);
    assert.ok(transferred.fencingToken > oldToken);
    await assert.rejects(() => rpc(a, { command: "dispatch", phoneNumberId: 101 }), /ownership is unavailable/i);
    await rpc(b, { command: "dispatch", phoneNumberId: 101 });

    const waitForMetrics = async (child: ChildProcess) => {
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline) {
        const metrics = await rpc(child, { command: "metrics" });
        if (Object.keys(metrics.dispatch.workers).length > 0) return metrics;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Timed out waiting for transport worker status");
    };
    const [metricsA, metricsB] = await Promise.all([waitForMetrics(a), waitForMetrics(b)]);
    assert.notEqual(metricsA.pid, metricsB.pid);
    for (const metrics of [metricsA, metricsB]) {
      assert.ok(Number.isFinite(metrics.cpuUtilizationPercent));
      assert.ok(Number.isFinite(metrics.eventLoopDelayMs.p99));
      assert.ok(Object.keys(metrics.dispatch.workers).length > 0);
    }
    const rows = (await readFile(providerLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.threadId !== 0), "provider execution must remain in worker threads");
    assert.equal(new Set(rows.map((row) => row.pid)).size, 2, "provider execution must be distributed across both runtime processes");
    console.log(JSON.stringify({
      processes: [metricsA, metricsB],
      ownership: { initialA: ownedA, initialB: ownedB, transferred },
      providerExecution: rows.map(({ pid, threadId, providerPhoneId }) => ({ pid, threadId, providerPhoneId })),
    }));
  } finally {
    for (const child of children) child.kill("SIGTERM");
    redis.kill("SIGTERM");
    await rm(work, { recursive: true, force: true });
    await rm(dist, { recursive: true, force: true });
  }
});