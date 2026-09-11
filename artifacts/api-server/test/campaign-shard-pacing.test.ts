import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_HANDOFF_GAP_FRACTION,
  RECOVERABLE_LAG_INTERVALS,
  ROLLING_WINDOW_GUARD_MS,
  arrivalNotBeforeAt,
  createPhoneCadence,
  dueAt,
  phaseFractionFor,
  recordStart,
  rollingLimitFor,
} from "../src/services/campaign-shard-pacing";

// Deterministic proof of the bounded-catch-up cadence rule that the transport
// shard worker now shares with the phone dispatch scheduler.

const INTERVAL = 1;

function run(latenessPerStartMs: number[], intervalMs = INTERVAL) {
  const cadence = createPhoneCadence();
  const dues: number[] = [];
  const starts: number[] = [];
  let now = 1_000;
  for (const lateness of latenessPerStartMs) {
    const due = dueAt(cadence, 0, intervalMs, now);
    const startedAt = due + lateness;
    recordStart(cadence, due, startedAt, intervalMs);
    dues.push(due);
    starts.push(startedAt);
    now = startedAt + 0.05; // loop overhead before the next decision
  }
  return { cadence, dues, starts };
}

test("C · lateness up to four intervals is recovered on the absolute cadence; more resets to the actual start", () => {
  const recovered = run([0, RECOVERABLE_LAG_INTERVALS * INTERVAL]);
  assert.equal(
    recovered.cadence.nextAt,
    Math.max(recovered.dues[1]! + INTERVAL, recovered.starts[1]! + INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION),
    "a start exactly four intervals late keeps its due-anchored cadence, floored by the handoff gap",
  );
  assert.ok(recovered.cadence.nextAt < recovered.starts[1]! + INTERVAL, "the recovered case starts again sooner than a full interval after the late start");
  const dropped = run([0, RECOVERABLE_LAG_INTERVALS * INTERVAL + 0.001]);
  assert.equal(dropped.cadence.nextAt, dropped.starts[1]! + INTERVAL, "a start later than four intervals re-anchors to the actual start");
  // A moderately late start recovers the whole lateness: the next due is exactly one interval after the previous due.
  const modest = run([0, 0.5]);
  assert.equal(modest.cadence.nextAt, modest.dues[1]! + INTERVAL);
  assert.ok(recovered.cadence.nextAt < dropped.cadence.nextAt);
});

test("E · a run of late wakes does not accumulate pacing debt: dues stay on the slot grid", () => {
  const wakeLatenessMs = 0.3;
  const { dues, starts } = run(Array.from({ length: 200 }, () => wakeLatenessMs));
  for (let index = 1; index < dues.length; index += 1) {
    assert.equal(dues[index], dues[0]! + index * INTERVAL, `due ${index} must stay on the absolute cadence`);
  }
  // With the previous actual-start-anchored rule the same wakes would have drifted by 200 * 0.3ms.
  const actualSpan = starts[starts.length - 1]! - starts[0]!;
  assert.ok(actualSpan < 199 * INTERVAL + 1, `199 intervals of work must take ~199ms, not ${actualSpan}ms`);
});

test("B · minimum spacing: cadence dues are at least one interval apart and actual starts at least a quarter interval apart", () => {
  const { dues, cadence } = run([0, 0.9, 3.5, 0, 2, 0.1, 4, 0]);
  for (let index = 1; index < dues.length; index += 1) {
    assert.ok(dues[index]! - dues[index - 1]! >= INTERVAL - 1e-9, "consecutive dues must keep the interval");
  }
  // After a start that is late, the very next start may come sooner than one
  // interval after it, but never sooner than a quarter interval.
  const late = createPhoneCadence();
  const due = dueAt(late, 0, INTERVAL, 1_000);
  recordStart(late, due, due + 3.9, INTERVAL);
  assert.equal(late.nextAt, Math.max(due + INTERVAL, due + 3.9 + INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION));
  assert.ok(late.nextAt - (due + 3.9) >= INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION - 1e-9);
  assert.ok(cadence.history.length <= rollingLimitFor(INTERVAL));
});

test("A · rolling guard: once the last second is full, the next start waits for the oldest start to age out", () => {
  const cadence = createPhoneCadence();
  const limit = rollingLimitFor(INTERVAL);
  assert.equal(limit, 1_000);
  // Simulate a full second of starts that were compressed to a quarter interval each (worst case allowed spacing).
  let now = 5_000;
  for (let index = 0; index < limit; index += 1) {
    const due = dueAt(cadence, 0, INTERVAL, now);
    recordStart(cadence, due, due, INTERVAL);
    now = due + INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION;
  }
  const oldest = cadence.history[0]!;
  const nextDue = dueAt(cadence, 0, INTERVAL, now);
  assert.ok(nextDue >= oldest + ROLLING_WINDOW_GUARD_MS, "the 1001st start must not land inside the rolling second of the first");
  // Once the oldest start is older than a second it is pruned and the guard lifts.
  const later = dueAt(cadence, 0, INTERVAL, oldest + 1_000.5);
  assert.ok(cadence.history.length < limit);
  assert.ok(later <= nextDue);
});

test("D · a stale schedule is never replayed: elapsed slots are due on arrival and a long stall resets the cadence", () => {
  const phase = phaseFractionFor(3);
  const now = 10_000;
  assert.equal(arrivalNotBeforeAt(now, -60_000, INTERVAL, phase), now + INTERVAL * phase, "a slot that elapsed a minute ago is due now, not in the past");
  assert.equal(arrivalNotBeforeAt(now, 250, INTERVAL, phase), now + 250 + INTERVAL * phase, "a future slot keeps its time");
  // Worker stalled for 10 seconds with a queue of stale work: only the first start is immediate.
  const cadence = createPhoneCadence();
  const first = dueAt(cadence, 0, INTERVAL, 20_000);
  recordStart(cadence, first, first + 10_000, INTERVAL);
  assert.equal(cadence.nextAt, first + 10_000 + INTERVAL, "the stall is not caught up: the next start is one interval after the actual start");
  const second = dueAt(cadence, 0, INTERVAL, first + 10_000.05);
  assert.equal(second, cadence.nextAt);
});

test("phases are stable per phone and inside one interval", () => {
  for (const phoneId of [1, 2, 3, 4, 101, 4_096]) {
    const phase = phaseFractionFor(phoneId);
    assert.equal(phase, phaseFractionFor(phoneId));
    assert.ok(phase >= 0 && phase < 1);
  }
  assert.notEqual(phaseFractionFor(1), phaseFractionFor(2));
});
