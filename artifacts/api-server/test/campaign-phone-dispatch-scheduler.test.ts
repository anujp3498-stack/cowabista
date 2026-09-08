import assert from "node:assert/strict";
import { test } from "node:test";
import { PhoneDispatchScheduler } from "../src/services/campaign-phone-dispatch-scheduler";

function rollingPeak(timestamps: readonly number[]): number {
  let start = 0;
  let peak = 0;
  for (let end = 0; end < timestamps.length; end += 1) {
    while (timestamps[end]! - timestamps[start]! >= 1_000) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

async function schedule(
  scheduler: PhoneDispatchScheduler,
  phoneNumberId: number,
  count: number,
  tps: number,
  firstSlotAt: number,
): Promise<number[]> {
  const controller = new AbortController();
  const timestamps: number[] = [];
  await Promise.all(Array.from({ length: count }, (_, index) =>
    scheduler.wait(
      phoneNumberId,
      1_000 / tps,
      controller.signal,
      new Date(firstSlotAt + index * (1_000 / tps)),
    ).then((permit) => {
      timestamps.push(performance.now());
      permit.acknowledgeDispatch();
    })));
  return timestamps.sort((left, right) => left - right);
}

test("a 1000 TPS phone lane is steady, ceiling-safe, and does not replay stale slots", { timeout: 15_000 }, async () => {
  const scheduler = new PhoneDispatchScheduler();
  try {
    const timestamps = await schedule(scheduler, 101, 2_500, 1_000, Date.now() - 10_000);
    const elapsedSeconds = (timestamps.at(-1)! - timestamps[0]!) / 1_000;
    const achievedTps = (timestamps.length - 1) / elapsedSeconds;
    const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]!);
    const burstPercent = intervals.filter((interval) => interval < 0.2).length / intervals.length * 100;
    const idleGapPercent = intervals.filter((interval) => interval > 5).length / intervals.length * 100;

    assert.ok(achievedTps >= 950, `expected at least 950 sustained TPS, got ${achievedTps.toFixed(2)}`);
    assert.ok(achievedTps <= 1_000, `must not exceed the 1000 TPS ceiling, got ${achievedTps.toFixed(2)}`);
    assert.ok(rollingPeak(timestamps) <= 1_000, "must not exceed 1000 sends in any rolling second");
    assert.equal(burstPercent, 0, "stale slots must not be replayed as sub-20%-interval bursts");
    assert.ok(idleGapPercent <= 0.5, `idle-gap percentage must stay bounded, got ${idleGapPercent.toFixed(2)}%`);
  } finally {
    await scheduler.close();
  }
});

test("different phone numbers have independent scheduler workers", { timeout: 10_000 }, async () => {
  const scheduler = new PhoneDispatchScheduler();
  try {
    const firstSlotAt = Date.now() + 100;
    const [left, right] = await Promise.all([
      schedule(scheduler, 201, 50, 100, firstSlotAt),
      schedule(scheduler, 202, 50, 100, firstSlotAt),
    ]);
    const combinedStart = Math.min(left[0]!, right[0]!);
    const combinedEnd = Math.max(left.at(-1)!, right.at(-1)!);

    assert.ok(combinedEnd - combinedStart < 700, "independent phones must run concurrently, not serially");
    assert.ok(Math.abs(left[0]! - right[0]!) < 100, "independent phone timelines should start together");
    assert.ok(rollingPeak(left) <= 100);
    assert.ok(rollingPeak(right) <= 100);
  } finally {
    await scheduler.close();
  }
});

test("two 1000 TPS phone lanes interleave without meaningful dispatch-start idle gaps", { timeout: 20_000 }, async () => {
  const scheduler = new PhoneDispatchScheduler();
  try {
    const firstSlotAt = Date.now() + 100;
    const [left, right] = await Promise.all([
      schedule(scheduler, 301, 3_000, 1_000, firstSlotAt),
      schedule(scheduler, 302, 3_000, 1_000, firstSlotAt),
    ]);
    for (const timestamps of [left, right]) {
      const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]!);
      const burstPercent = intervals.filter((interval) => interval < 0.2).length / intervals.length * 100;
      const idleGapPercent = intervals.filter((interval) => interval > 5).length / intervals.length * 100;
      const elapsedSeconds = (timestamps.at(-1)! - timestamps[0]!) / 1_000;
      const achievedTps = (timestamps.length - 1) / elapsedSeconds;

      assert.ok(achievedTps >= 900, `expected at least 900 TPS per lane, got ${achievedTps.toFixed(2)}`);
      assert.ok(rollingPeak(timestamps) <= 1_000, "each lane must preserve its rolling 1000 TPS ceiling");
      assert.ok(burstPercent <= 0.5, `burst percentage must stay bounded, got ${burstPercent.toFixed(2)}%`);
      assert.ok(idleGapPercent <= 0.5, `idle-gap percentage must stay bounded, got ${idleGapPercent.toFixed(2)}%`);
    }
  } finally {
    await scheduler.close();
  }
});