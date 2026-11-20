import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { createClient } from "redis";
import {
  RedisPreparedDispatchBroker,
  type BrokerEnvelope,
} from "../src/services/campaign-prepared-broker";

const port = 6395;
const url = `redis://127.0.0.1:${port}`;
let redis: ChildProcess;

function envelope(id: number, phoneNumberId = 101): BrokerEnvelope {
  return {
    job: {
      id,
      organizationId: 1,
      campaignId: 2,
      routeId: 3,
      contactId: 4,
      type: "ResolveTemplateAndSend",
      payload: {},
      status: "Processing",
      attempts: 1,
      maxAttempts: 3,
      availableAt: new Date(),
      lockedAt: new Date(),
      lockedBy: "publisher",
      leaseToken: `lease-${id}`,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      scheduledSendAt: new Date(),
      idempotencyKey: `job-${id}`,
      errorReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      dispatchPhoneNumberId: phoneNumberId,
    },
    preparedContext: { providerMessageRowId: id, payload: { to: String(id) } },
  } as BrokerEnvelope;
}

before(async () => {
  redis = spawn("redis-server", [
    "--port", String(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1",
  ], { stdio: "ignore" });
  // This suite needs a local Redis 7 `redis-server` binary (docs/DEVELOPMENT.md). Without one, or if it exits
  // before listening, fail at once with the reason: the Redis client otherwise keeps reconnecting and the
  // probe below never settles, so the suite hung instead of failing.
  await new Promise<void>((resolve, reject) => {
    redis.once("spawn", resolve);
    redis.once("error", (error) => reject(new Error(`redis-server could not be started (is Redis 7 installed?): ${error.message}`)));
  });
  let probing: RedisPreparedDispatchBroker | undefined;
  await new Promise<void>((resolve, reject) => {
    redis.once("exit", (code, signal) => {
      void probing?.close();
      reject(new Error(`redis-server exited before accepting connections (code ${code}, signal ${signal})`));
    });
    const deadline = Date.now() + 3_000;
    const probe = async () => {
      const broker = new RedisPreparedDispatchBroker(url);
      probing = broker;
      try {
        await broker.metrics(999_999);
        await broker.close();
        resolve();
      } catch {
        await broker.close();
        if (Date.now() >= deadline) reject(new Error("Redis test server did not start"));
        else setTimeout(probe, 25);
      }
    };
    void probe();
  });
  redis.removeAllListeners("exit");
});

after(() => {
  redis.kill("SIGTERM");
});

test("Redis Streams partitions prepared leased work by phone and reports depth, pending and lag", async () => {
  const broker = new RedisPreparedDispatchBroker(url);
  try {
    await broker.publish(101, 7, [envelope(1), envelope(2), envelope(3)]);
    await broker.publish(102, 11, [envelope(4, 102)]);
    assert.deepEqual(await broker.metrics(101), { depth: 3, pending: 0, consumerLag: 3 });
    assert.deepEqual(await broker.metrics(102), { depth: 1, pending: 0, consumerLag: 1 });

    const first = await broker.consume(101, "consumer-a", 2);
    assert.deepEqual(first.map((item) => item.envelope.job.id), [1, 2]);
    assert.ok(first.every((item) => item.fencingToken === 7));
    assert.deepEqual(await broker.metrics(101), { depth: 3, pending: 2, consumerLag: 1 });
    await broker.acknowledge(101, [first[0]!.id]);
    assert.deepEqual(await broker.metrics(101), { depth: 2, pending: 1, consumerLag: 1 });
  } finally {
    await broker.close();
  }
});

test("reclaim pages through the pending list from the returned cursor without ever holding more than a page", async () => {
  const broker = new RedisPreparedDispatchBroker(url);
  try {
    await broker.publish(301, 31, [1, 2, 3, 4, 5].map((id) => envelope(id, 301)));
    assert.equal((await broker.consume(301, "consumer-before-crash", 5)).length, 5);
    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    const seen: number[] = [];
    let cursor = "0-0";
    const pages: number[] = [];
    do {
      const page = await broker.reclaimAbandoned(301, "consumer-after-crash", 50, 2, cursor);
      pages.push(page.deliveries.length);
      seen.push(...page.deliveries.map((item) => item.envelope.job.id));
      await broker.acknowledge(301, page.deliveries.map((item) => item.id));
      cursor = page.cursor;
    } while (cursor !== "0-0" && pages.length < 10);
    assert.deepEqual(pages, [2, 2, 1], "a 5-entry pending list is visited in pages of at most 2");
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5], "every pending entry is reclaimed exactly once");
    assert.deepEqual(await broker.metrics(301), { depth: 0, pending: 0, consumerLag: 0 });
    const again = await broker.reclaimAbandoned(301, "consumer-after-crash", 0, 2);
    assert.deepEqual(again, { deliveries: [], cursor: "0-0" }, "an empty pending list ends the scan at once");
  } finally {
    await broker.close();
  }
});

test("a replacement consumer reclaims an abandoned lease fail-closed without replaying the provider", async () => {
  const broker = new RedisPreparedDispatchBroker(url);
  let providerCalls = 0;
  try {
    await broker.publish(201, 21, [envelope(10, 201)]);
    const [started] = await broker.consume(201, "consumer-before-crash", 1);
    assert.ok(started);
    providerCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    const { deliveries: reclaimed, cursor } = await broker.reclaimAbandoned(201, "consumer-after-crash", 50, 10);
    assert.equal(reclaimed.length, 1);
    assert.equal(cursor, "0-0", "a scan that reaches the end of the pending list reports the start cursor");
    assert.equal(reclaimed[0]!.envelope.job.leaseToken, "lease-10");
    // Recovery deliberately revokes/requeues the exact lease. It never calls
    // the provider because the old consumer may have crossed that boundary.
    await broker.acknowledge(201, reclaimed.map((item) => item.id));
    assert.equal(providerCalls, 1);
    assert.deepEqual(await broker.metrics(201), { depth: 0, pending: 0, consumerLag: 0 });
  } finally {
    await broker.close();
  }
});

// V2-372. Acknowledging an entry also removes its publish-dedupe field. Before, every message left a
// `jobId:leaseToken` field in campaign:prepared:{phone:N}:published, whose 24 h expiry each publish re-armed, so the
// hash of an active phone grew without bound (Redis runs maxmemory noeviction: the end state was every write failing).
test("acknowledging entries removes their publish-dedupe fields; dedupe still holds until then", async () => {
  const broker = new RedisPreparedDispatchBroker(url);
  const client = createClient({ url });
  await client.connect();
  const hash = "campaign:prepared:{phone:303}:published";
  try {
    await broker.publish(303, 5, [envelope(31, 303), envelope(32, 303), envelope(33, 303)]);
    await broker.publish(303, 5, [envelope(31, 303)]);
    assert.equal(await client.hLen(hash), 3, "one dedupe field per published (job, lease)");
    assert.deepEqual(await broker.metrics(303), { depth: 3, pending: 0, consumerLag: 3 }, "a re-publish before acknowledgement is deduplicated");
    const read = await broker.consume(303, "consumer-x", 3);
    await broker.acknowledge(303, read.slice(0, 2).map((item) => item.id));
    assert.equal(await client.hLen(hash), 1, "acknowledged entries' fields are gone");
    await broker.acknowledge(303, [read[2]!.id, read[0]!.id]);
    assert.equal(await client.hLen(hash), 0, "the hash is empty once everything is acknowledged (a repeated id is harmless)");
    assert.deepEqual(await broker.metrics(303), { depth: 0, pending: 0, consumerLag: 0 });
    // Many ids in one call are split into bounded script runs.
    const many = Array.from({ length: 600 }, (_, index) => envelope(1_000 + index, 303));
    await broker.publish(303, 5, many);
    const all = await broker.consume(303, "consumer-x", 600);
    await broker.acknowledge(303, all.map((item) => item.id));
    assert.equal(await client.hLen(hash), 0);
    assert.deepEqual(await broker.metrics(303), { depth: 0, pending: 0, consumerLag: 0 });
  } finally {
    await client.quit();
    await broker.close();
  }
});
