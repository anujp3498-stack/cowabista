import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { threadId } from "node:worker_threads";
import { CampaignTransportShards } from "../src/services/campaign-transport-shards";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";

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
    await assert.rejects(
      () => shards.dispatch(
        100,
        1,
        Date.now(),
        { kind: "benchmark", delayMs: 0, providerMessageId: "forbidden" },
        new AbortController().signal,
      ),
      /ownership is unavailable/i,
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