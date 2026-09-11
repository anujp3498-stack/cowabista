/**
 * Per-phone cadence rule for transport shard workers.
 *
 * This is the same bounded-catch-up rule the phone dispatch scheduler already
 * uses (campaign-phone-dispatch-scheduler.ts), copied so both pacers honour
 * one contract:
 *
 * - The authoritative timeline is the reserved slot (scheduled_send_at). A
 *   slot that has already elapsed when it reaches the worker is due on
 *   arrival, never earlier, so elapsed slots are not replayed.
 * - Never more than floor(1000 / interval) starts in any rolling second: once
 *   the last second is full the next start waits for the oldest to age out.
 * - Ordinary wake latency (up to four intervals) stays on the absolute cadence
 *   instead of being re-anchored to the actual start, so it does not
 *   accumulate as permanent pacing debt. Larger stalls reset the cadence to
 *   the actual start and are not caught up.
 * - Two actual starts are never closer than a quarter interval.
 *
 * The quarter-interval floor is a constraint on the actual start, not a move
 * of the cadence: the grid position is kept apart from the floored due, so a
 * start that was late by more than the floor is caught up on the grid at the
 * floor spacing instead of the floored due becoming the new base. Measured on
 * a saturated 4-core host, the floored-due base leaked 0.75ms short of every
 * recoverable late wake into permanent debt: 55-63% of a 10-12% per-phone
 * cadence loss at 1,000 TPS.
 */
export const RECOVERABLE_LAG_INTERVALS = 4;
export const MINIMUM_HANDOFF_GAP_FRACTION = 0.25;
export const ROLLING_WINDOW_MS = 1_000;
export const ROLLING_WINDOW_GUARD_MS = 1_001;

export type PhoneCadence = {
  /** Earliest time the next start on this phone may be due. */
  nextAt: number;
  /** Actual start times inside the last rolling second, oldest first. */
  history: number[];
  /** Grid position of the head item from the last dueAt(): the due before the quarter-interval start floor. */
  gridDueAt: number;
};

export function createPhoneCadence(): PhoneCadence {
  return { nextAt: 0, history: [], gridDueAt: 0 };
}

/** Knuth multiplicative hash: adjacent phone ids get distinct, stable sub-interval phases. */
export function phaseFractionFor(phoneId: number): number {
  return (Math.imul(phoneId, 2_654_435_761) >>> 0) / 2 ** 32;
}

/**
 * Turns a reserved slot into the worker-clock time before which it must not
 * start. An elapsed slot becomes due now (arrival time), which is what keeps
 * a stale schedule from being replayed as a burst.
 */
export function arrivalNotBeforeAt(
  nowMs: number,
  slotRemainingMs: number,
  intervalMs: number,
  phaseFraction: number,
): number {
  return nowMs + Math.max(0, slotRemainingMs) + intervalMs * phaseFraction;
}

export function rollingLimitFor(intervalMs: number): number {
  return Math.max(1, Math.floor(ROLLING_WINDOW_MS / intervalMs));
}

/**
 * Computes when the head item of a phone may start. Prunes the rolling history.
 * The grid position (cadence, slot arrival, rolling guard) is remembered on
 * the cadence; the returned due additionally applies the quarter-interval
 * floor after the previous actual start.
 */
export function dueAt(cadence: PhoneCadence, notBeforeAt: number, intervalMs: number, nowMs: number): number {
  const history = cadence.history;
  while (history.length && history[0]! <= nowMs - ROLLING_WINDOW_MS) history.shift();
  const previousStartAt = history.length ? history[history.length - 1]! : undefined;
  let grid = Math.max(cadence.nextAt || nowMs, notBeforeAt);
  if (history.length >= rollingLimitFor(intervalMs)) {
    grid = Math.max(grid, history[0]! + ROLLING_WINDOW_GUARD_MS);
  }
  cadence.gridDueAt = grid;
  return Math.max(
    grid,
    previousStartAt === undefined ? 0 : previousStartAt + intervalMs * MINIMUM_HANDOFF_GAP_FRACTION,
  );
}

/**
 * Records an actual start and advances the cadence with bounded catch-up.
 * Lateness is measured against the grid position, so a start that only
 * waited for the quarter-interval floor is not treated as late, and the next
 * grid position follows the grid (recoverable) or the actual start (stall).
 * The floor itself is re-applied by the next dueAt() from the history.
 */
export function recordStart(cadence: PhoneCadence, due: number, startedAt: number, intervalMs: number): void {
  cadence.history.push(startedAt);
  const grid = Math.min(cadence.gridDueAt || due, due);
  const latenessMs = Math.max(0, startedAt - grid);
  const cadenceBase = latenessMs <= intervalMs * RECOVERABLE_LAG_INTERVALS ? grid : startedAt;
  cadence.nextAt = cadenceBase + intervalMs;
}
