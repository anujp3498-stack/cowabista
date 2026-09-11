import assert from "node:assert/strict";
import test from "node:test";
import { CampaignTransportShards } from "../src/services/campaign-transport-shards";

// Integration proof on the real transport shard worker: a stale schedule
// (every reserved slot already elapsed) is paced, not replayed; STOP and
// ownership fencing behave exactly as before the bounded catch-up change.

function rollingPeak(sorted: number[], windowMs: number): number {
  let start = 0;
  let peak = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end]! - sorted[start]! >= windowMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

/** Transport workers are unref'd; the runtime's own timers keep a real process alive, so the test holds the loop itself. */
function keepAlive(): () => void {
  const timer = setInterval(() => {}, 1_000);
  return () => clearInterval(timer);
}

async function dispatchStale(
  shards: CampaignTransportShards,
  phoneId: number,
  count: number,
  intervalMs: number,
  signal: AbortSignal,
  staleMs = 5_000,
) {
  const starts: number[] = [];
  const outcomes = Array.from({ length: count }, (_, index) => shards.dispatch(
    phoneId,
    intervalMs,
    Date.now() - staleMs + index * intervalMs, // every slot is already in the past
    { kind: "benchmark", delayMs: 0, providerMessageId: `stale-${index}` },
    signal,
    (startedAt) => starts.push(startedAt),
  ));
  return { starts, outcomes };
}

test("A/D · a stale schedule is paced at the configured rate: no burst above the rolling cap, no replay", async () => {
  const shards = new CampaignTransportShards(1);
  const release = keepAlive();
  try {
    const intervalMs = 5; // 200 TPS keeps the timing robust on a loaded host
    const count = 700;
    shards.updatePhoneOwnership(1, { fencingToken: 1, validUntilMs: Date.now() + 30_000 });
    const before = performance.now();
    const { starts, outcomes } = await dispatchStale(shards, 1, count, intervalMs, new AbortController().signal);
    const results = await Promise.all(outcomes);
    const wall = performance.now() - before;
    results.forEach((outcome) => outcome.acknowledge());
    assert.equal(results.filter((outcome) => outcome.providerMessageId).length, count);
    const sorted = [...starts].sort((a, b) => a - b);
    assert.equal(sorted.length, count);
    const cap = Math.floor(1_000 / intervalMs);
    assert.ok(rollingPeak(sorted, 1_000) <= cap, `rolling-second peak ${rollingPeak(sorted, 1_000)} exceeded the ${cap}/s cap`);
    assert.ok(wall >= (count / cap) * 1_000 * 0.97, `${count} stale slots at ${cap}/s must take ~${count / cap}s, took ${(wall / 1_000).toFixed(2)}s`);
    // Bounded catch-up recovers wake latency, so the cadence is close to nominal rather than 10-20% slower.
    assert.ok(wall <= (count / cap) * 1_000 * 1.12, `cadence must not lose more than 12%: took ${(wall / 1_000).toFixed(2)}s`);
  } finally {
    release();
    await shards.close();
  }
});

test("B/C · actual starts never come closer than a quarter interval, and catch-up is bounded to a few slots", async () => {
  const shards = new CampaignTransportShards(1);
  const release = keepAlive();
  try {
    const intervalMs = 2; // 500 TPS
    const count = 1_000;
    shards.updatePhoneOwnership(2, { fencingToken: 1, validUntilMs: Date.now() + 30_000 });
    const { starts, outcomes } = await dispatchStale(shards, 2, count, intervalMs, new AbortController().signal);
    (await Promise.all(outcomes)).forEach((outcome) => outcome.acknowledge());
    const sorted = [...starts].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((value, index) => value - sorted[index]!);
    const minimumGap = Math.min(...gaps);
    assert.ok(minimumGap >= intervalMs * 0.25 - 0.05, `minimum inter-start gap ${minimumGap.toFixed(3)}ms is below a quarter interval`);
    // At most four slots of lateness can be recovered, so no 10ms window holds more than the nominal five starts plus four.
    assert.ok(rollingPeak(sorted, 10) <= 10 / intervalMs + 4, `10ms window held ${rollingPeak(sorted, 10)} starts`);
    assert.ok(rollingPeak(sorted, 1_000) <= 500);
  } finally {
    release();
    await shards.close();
  }
});

test("F · STOP: aborting the signal cancels queued stale work before provider start and stops further starts", async () => {
  const shards = new CampaignTransportShards(1);
  const release = keepAlive();
  try {
    const intervalMs = 5;
    const controller = new AbortController();
    shards.updatePhoneOwnership(3, { fencingToken: 1, validUntilMs: Date.now() + 30_000 });
    const { starts, outcomes } = await dispatchStale(shards, 3, 400, intervalMs, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error("STOP"));
    const startsAtAbort = starts.length;
    const results = await Promise.all(outcomes.map((outcome) => outcome.catch((error: Error) => ({ rejected: error }))));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(startsAtAbort > 20 && startsAtAbort < 120, `expected ~60 starts before the STOP, saw ${startsAtAbort}`);
    assert.ok(starts.length <= startsAtAbort + 1, "no further provider starts after the STOP");
    const cancelled = results.filter((outcome) => "cancelledBeforeStart" in outcome && outcome.cancelledBeforeStart);
    assert.ok(cancelled.length >= 400 - startsAtAbort - 1, "every queued item is cancelled before provider start");
    for (const outcome of results) if ("acknowledge" in outcome) outcome.acknowledge();
  } finally {
    release();
    await shards.close();
  }
});

test("G · fencing: work carrying a superseded ownership token never starts; the new owner's work is paced normally", async () => {
  const shards = new CampaignTransportShards(1);
  const release = keepAlive();
  try {
    const intervalMs = 5;
    shards.updatePhoneOwnership(4, { fencingToken: 1, validUntilMs: Date.now() + 30_000 });
    const { starts: oldStarts, outcomes: oldOutcomes } = await dispatchStale(shards, 4, 300, intervalMs, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Another process takes the phone: the old token is revoked and a new one installed.
    shards.revokePhoneOwnership(4, 1);
    shards.updatePhoneOwnership(4, { fencingToken: 2, validUntilMs: Date.now() + 30_000 });
    const fencedAt = oldStarts.length;
    const oldResults = await Promise.all(oldOutcomes);
    assert.ok(oldStarts.length <= fencedAt + 1, "no start with the superseded token after revocation");
    const fenced = oldResults.filter((outcome) => outcome.cancelledBeforeStart);
    assert.ok(fenced.length >= 300 - fencedAt - 1, `expected the remaining ${300 - fencedAt} items fenced, got ${fenced.length}`);
    assert.ok(fenced.every((outcome) => /aborted|ownership/i.test(outcome.error?.message ?? "")));
    oldResults.forEach((outcome) => outcome.acknowledge());
    const { starts, outcomes } = await dispatchStale(shards, 4, 200, intervalMs, new AbortController().signal);
    const results = await Promise.all(outcomes);
    results.forEach((outcome) => outcome.acknowledge());
    assert.equal(results.filter((outcome) => outcome.providerMessageId).length, 200);
    assert.ok(rollingPeak([...starts].sort((a, b) => a - b), 1_000) <= 200);
    // An expired lease is still refused at dispatch time.
    shards.updatePhoneOwnership(4, { fencingToken: 3, validUntilMs: Date.now() - 1 });
    await assert.rejects(
      () => shards.dispatch(4, intervalMs, Date.now(), { kind: "benchmark", delayMs: 0, providerMessageId: "expired" }, new AbortController().signal),
      /ownership is unavailable/i,
    );
  } finally {
    release();
    await shards.close();
  }
});
