import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { threadId } from "node:worker_threads";
import { CampaignTransportShards } from "../src/services/campaign-transport-shards";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";

const testKeepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(testKeepAlive));

test("transport shards own stable phone dispatch and invoke providers off-thread", async () => {
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "campaign-shards-")), "provider.log");
  process.env.CAMPAIGN_TEST_PROVIDER_LOG = log;
  const shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(42, { fencingToken: 1, validUntilMs: Date.now() + 5_000 });
    shards.updatePhoneOwnership(43, { fencingToken: 1, validUntilMs: Date.now() + 5_000 });
    assert.equal(shards.shardForPhone(42), shards.shardForPhone(42));
    const controller = new AbortController();
    const payload = {
      kind: "whatsapp" as const,
      mode: "mock" as const,
      providerPhoneId: "test-phone",
      payload: { messaging_product: "whatsapp" },
      timeoutMs: 8_000,
    };
    const [first, second] = await Promise.all([
      shards.dispatch(42, 1, Date.now(), payload, controller.signal),
      // A second phone has a separate worker-local cursor/pump.
      shards.dispatch(43, 1, Date.now(), payload, controller.signal),
    ]);
    assert.ok(first.providerMessageId);
    assert.ok(second.providerMessageId);
    // Outcomes are retained by the worker until the consumer explicitly ACKs.
    first.acknowledge();
    second.acknowledge();
    const rows = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.threadId !== threadId), "provider send must execute in a shard worker");
  } finally {
    delete process.env.CAMPAIGN_TEST_PROVIDER_LOG;
    await shards.close();
  }
});

test("benchmark transport payload completes on the shard without a main-thread provider call", async () => {
  const shards = new CampaignTransportShards(1);
  try {
    shards.updatePhoneOwnership(77, { fencingToken: 1, validUntilMs: Date.now() + 5_000 });
    const started: number[] = [];
    const outcome = await shards.dispatch(
      77,
      1,
      Date.now(),
      {
        kind: "benchmark",
        delayMs: 10,
        providerMessageId: "benchmark-shard-result",
      },
      new AbortController().signal,
      (startedAt) => started.push(startedAt),
    );
    assert.equal(outcome.providerMessageId, "benchmark-shard-result");
    assert.equal(outcome.error, undefined);
    assert.equal(started.length, 1);
    assert.equal(outcome.startedAt, started[0]);
    assert.ok((outcome.completedAt ?? 0) >= started[0]!);
    outcome.acknowledge();
  } finally {
    await shards.close();
  }
});

test("an atomic cancellation fence prevents a queued shard send from reaching the provider", async () => {
  const shards = new CampaignTransportShards(1);
  try {
    shards.updatePhoneOwnership(88, { fencingToken: 1, validUntilMs: Date.now() + 5_000 });
    const controller = new AbortController();
    const outcomePromise = shards.dispatch(
      88,
      1,
      Date.now() + 100,
      {
        kind: "benchmark",
        delayMs: 1,
        providerMessageId: "must-not-be-delivered",
      },
      controller.signal,
    );
    controller.abort(new Error("STOP"));
    const outcome = await outcomePromise;
    assert.equal(outcome.providerMessageId, undefined);
    assert.equal(outcome.cancelledBeforeStart, true);
    assert.match(outcome.error?.message ?? "", /aborted before provider start/i);
    outcome.acknowledge();
  } finally {
    await shards.close();
  }
});

test("WhatsApp provider timeout is enforced inside the transport shard", async () => {
  process.env.CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS = "100";
  const shards = new CampaignTransportShards(1);
  try {
    shards.updatePhoneOwnership(99, { fencingToken: 1, validUntilMs: Date.now() + 5_000 });
    const outcome = await shards.dispatch(
      99,
      1,
      Date.now(),
      {
        kind: "whatsapp",
        mode: "mock",
        providerPhoneId: "timeout-phone",
        payload: { messaging_product: "whatsapp" },
        timeoutMs: 10,
      },
      new AbortController().signal,
    );
    assert.equal(outcome.providerMessageId, undefined);
    assert.match(outcome.error?.message ?? "", /timed out|timeout|aborted/i);
    outcome.acknowledge();
  } finally {
    delete process.env.CAMPAIGN_TEST_PROVIDER_DELAY_ONCE_MS;
    await shards.close();
  }
});

test("transport refuses dispatch without an active phone ownership lease", async () => {
  const shards = new CampaignTransportShards(1);
  try {
    // Phase 0 (D1b): the refusal is a not-started outcome, not a rejection, so the caller requeues the work
    // instead of recording delivery_unknown for a provider call that never happened.
    const refused = await shards.dispatch(
      100,
      1,
      Date.now(),
      { kind: "benchmark", delayMs: 0, providerMessageId: "forbidden" },
      new AbortController().signal,
    );
    assert.equal(refused.cancelledBeforeStart, true);
    assert.match(refused.error?.message ?? "", /ownership is unavailable/i);
    assert.equal(refused.providerMessageId, undefined, "nothing was started");
  } finally {
    await shards.close();
  }
});

test("transport fails fast when a shard cannot initialize", async () => {
  const missingWorker = pathToFileURL(
    path.join(
      os.tmpdir(),
      `missing-campaign-transport-worker-${process.pid}-${Date.now()}.mjs`,
    ),
  );

  const shards = new CampaignTransportShards(1, missingWorker);

  try {
    shards.updatePhoneOwnership(102, {
      fencingToken: 1,
      validUntilMs: Date.now() + 5_000,
    });

    const startedAt = Date.now();

    await assert.rejects(
      () => shards.dispatch(
        102,
        1,
        Date.now(),
        {
          kind: "benchmark",
          delayMs: 0,
          providerMessageId: "must-not-hang",
        },
        new AbortController().signal,
      ),
      /cannot find|transport shard|module/i,
    );

    assert.ok(
      Date.now() - startedAt < 4_000,
      "broken shard must fail before the 5-second readiness timeout",
    );
  } finally {
    await shards.close();
  }
});

test("each execution worker reports its own thread, ownership, queue, starts, and CPU", async () => {
  const shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(101, { fencingToken: 7, validUntilMs: Date.now() + 5_000 });
    const outcome = await shards.dispatch(
      101,
      1,
      Date.now(),
      { kind: "benchmark", delayMs: 0, providerMessageId: "observed" },
      new AbortController().signal,
    );
    outcome.acknowledge();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const snapshot = campaignDispatchMetrics.snapshot();
    const status = snapshot.workers[shards.shardForPhone(101)];
    assert.ok(status);
    assert.notEqual(status.threadId, threadId);
    assert.ok(status.ownedPhones.includes(101));
    assert.ok(status.providerStarts >= 1);
    assert.ok(Number.isFinite(status.cpuUtilizationPercent));
  } finally {
    await shards.close();
  }
});
/** Builds shards whose worker threads start with a test seam set (process.env is copied at Worker construction). */
function shardsWith(env: Record<string, string>): CampaignTransportShards {
  Object.assign(process.env, env);
  try {
    return new CampaignTransportShards(1);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

function settlesWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} never settled`)), ms).unref())]);
}

test("D2: ownership lapsing between the worker's two start checks posts a not-started outcome, so the dispatch settles", async () => {
  const shards = shardsWith({ CAMPAIGN_TEST_SHARD_STALL_BETWEEN_CHECKS_MS: "400" });
  try {
    // Warm the worker (and its cadence) up; this send also passes through the 400 ms stall.
    shards.updatePhoneOwnership(70, { fencingToken: 1, validUntilMs: Date.now() + 60_000 });
    const warm = await shards.dispatch(70, 1, Date.now(), { kind: "benchmark", delayMs: 0, providerMessageId: "warm" }, new AbortController().signal);
    assert.equal(warm.providerMessageId, "warm");
    warm.acknowledge();
    // Valid at the first check (within a few ms), lapsed by the second (after the stall).
    shards.updatePhoneOwnership(70, { fencingToken: 1, validUntilMs: Date.now() + 150 });
    const started: number[] = [];
    const dispatchedAt = Date.now();
    const outcome = await settlesWithin(
      shards.dispatch(70, 1, Date.now(), { kind: "benchmark", delayMs: 0, providerMessageId: "d2" }, new AbortController().signal, (at) => started.push(at)),
      5_000, "the D2 dispatch",
    );
    assert.ok(Date.now() - dispatchedAt >= 350, "the item passed the first check and reached the stall between the two checks");
    assert.equal(outcome.cancelledBeforeStart, true);
    assert.match(outcome.error?.message ?? "", /ownership lease expired before provider start/);
    assert.equal(outcome.providerMessageId, undefined);
    assert.deepEqual(started, [], "no start was posted");
    outcome.acknowledge();
  } finally {
    await shards.close();
  }
});

test("D3: a cancel seen in invoke, after the start message and before the provider call, is a not-started outcome, not a provider error", async () => {
  const shards = shardsWith({ CAMPAIGN_TEST_SHARD_PAUSE_BEFORE_INVOKE_MS: "300" });
  try {
    shards.updatePhoneOwnership(71, { fencingToken: 1, validUntilMs: Date.now() + 60_000 });
    const controller = new AbortController();
    let starts = 0;
    const outcome = await settlesWithin(
      shards.dispatch(71, 1, Date.now(), { kind: "benchmark", delayMs: 0, providerMessageId: "d3" }, controller.signal, () => {
        starts += 1;
        // The worker has posted `start` and is paused before invoke: cancel now.
        controller.abort(new Error("cancelled after start"));
      }),
      5_000, "the D3 dispatch",
    );
    assert.equal(starts, 1, "the start message was posted before the cancel");
    assert.equal(outcome.cancelledBeforeStart, true, "never recorded as a provider error (delivery_unknown)");
    assert.match(outcome.error?.message ?? "", /aborted before provider start/);
    assert.equal(outcome.providerMessageId, undefined);
    outcome.acknowledge();
  } finally {
    await shards.close();
  }
});

test("D4: a phone lease expiring after the start notification but before invoke cannot reach the provider", async () => {
  const shards = shardsWith({ CAMPAIGN_TEST_SHARD_PAUSE_BEFORE_INVOKE_MS: "500" });
  try {
    const phoneId = 72;
    const fencingToken = 1;
    shards.updatePhoneOwnership(phoneId, { fencingToken, validUntilMs: Date.now() + 60_000 });
    let starts = 0;
    const outcome = await settlesWithin(
      shards.dispatch(
        phoneId,
        1,
        Date.now(),
        { kind: "benchmark", delayMs: 0, providerMessageId: "must-not-reach-provider" },
        new AbortController().signal,
        () => {
          starts += 1;
          // The parent has received the start notification, but the worker is still paused before invoke.
          // A lease that expires without an explicit revoke must also prevent the provider call.
          shards.updatePhoneOwnership(phoneId, { fencingToken, validUntilMs: Date.now() - 1 });
        },
      ),
      5_000,
      "the D4 dispatch",
    );
    assert.equal(starts, 1, "the start notification preceded the lease expiry");
    assert.equal(outcome.cancelledBeforeStart, true, "expired ownership is not a provider failure");
    assert.equal(outcome.providerMessageId, undefined, "expired owner never sends");
    assert.match(outcome.error?.message ?? "", /ownership lease expired before provider start/i);
    outcome.acknowledge();
  } finally {
    await shards.close();
  }
});
