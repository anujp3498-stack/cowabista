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
    recovered.dues[1]! + INTERVAL,
    "a start exactly four intervals late keeps its due-anchored cadence",
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

test("B · minimum spacing: catch-up dues and actual starts are never closer than a quarter interval, and no interval holds more than one slot plus the recoverable catch-up", () => {
  const { dues, starts, cadence } = run([0, 0.9, 3.5, 0, 2, 0.1, 4, 0]);
  for (let index = 1; index < dues.length; index += 1) {
    assert.ok(dues[index]! - dues[index - 1]! >= INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION - 1e-9, "consecutive dues must keep the quarter-interval floor");
    assert.ok(starts[index]! - starts[index - 1]! >= INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION - 1e-9, "consecutive starts must keep the quarter-interval floor");
  }
  for (const from of starts) {
    const inside = starts.filter((at) => at >= from && at <= from + INTERVAL).length;
    assert.ok(inside <= 1 + RECOVERABLE_LAG_INTERVALS, "catch-up inside one interval is bounded by the recoverable lag");
  }
  // After a start that is late, the very next start may come sooner than one
  // interval after it, but never sooner than a quarter interval. The floor
  // applies to the start, not to the cadence, which stays on its grid.
  const late = createPhoneCadence();
  const due = dueAt(late, 0, INTERVAL, 1_000);
  recordStart(late, due, due + 3.9, INTERVAL);
  assert.equal(late.nextAt, due + INTERVAL, "the cadence stays on the grid after a recoverable late start");
  const next = dueAt(late, 0, INTERVAL, due + 3.95);
  assert.equal(next, due + 3.9 + INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION, "the next actual start is floored a quarter interval after the late start");
  assert.ok(next - (due + 3.9) >= INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION - 1e-9);
  assert.ok(cadence.history.length <= rollingLimitFor(INTERVAL));
});

test("F · a recoverable late wake beyond the handoff gap is caught up on the grid, not leaked into permanent debt", () => {
  // One wake 2ms late (below the four-interval bound), then punctual starts.
  const { dues, starts } = run([0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
  const grid0 = dues[0]!;
  // The late start is followed by starts at the quarter-interval floor until the grid is caught up ...
  assert.ok(starts[2]! - starts[1]! >= INTERVAL * MINIMUM_HANDOFF_GAP_FRACTION - 1e-9);
  assert.ok(starts[2]! - starts[1]! < INTERVAL, "the start after a late wake catches up sooner than a full interval");
  // ... and the cadence returns to the original grid: start k lands on grid0 + k intervals once caught up.
  const last = starts.length - 1;
  assert.equal(dues[last], grid0 + last * INTERVAL, "the schedule returns to the absolute grid with no permanent debt");
  assert.equal(starts[last], grid0 + last * INTERVAL);
  // Total elapsed time for the run is the grid span, not the grid span plus the leaked lateness.
  assert.equal(starts[last]! - starts[0]!, last * INTERVAL);
  // A stall beyond the bound is still forfeited, never replayed.
  const stalled = run([0, RECOVERABLE_LAG_INTERVALS * INTERVAL + 1, 0, 0]);
  assert.equal(stalled.dues[2], stalled.starts[1]! + INTERVAL, "a start later than four intervals re-anchors to the actual start");
  assert.equal(stalled.dues[3], stalled.starts[1]! + 2 * INTERVAL);
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
