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
};

export function createPhoneCadence(): PhoneCadence {
  return { nextAt: 0, history: [] };
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

/** Computes when the head item of a phone may start. Prunes the rolling history. */
export function dueAt(cadence: PhoneCadence, notBeforeAt: number, intervalMs: number, nowMs: number): number {
  const history = cadence.history;
  while (history.length && history[0]! <= nowMs - ROLLING_WINDOW_MS) history.shift();
  const previousStartAt = history.length ? history[history.length - 1]! : undefined;
  let due = Math.max(
    cadence.nextAt || nowMs,
    notBeforeAt,
    previousStartAt === undefined ? 0 : previousStartAt + intervalMs * MINIMUM_HANDOFF_GAP_FRACTION,
  );
  if (history.length >= rollingLimitFor(intervalMs)) {
    due = Math.max(due, history[0]! + ROLLING_WINDOW_GUARD_MS);
  }
  return due;
}

/** Records an actual start and advances the cadence with bounded catch-up. */
export function recordStart(cadence: PhoneCadence, due: number, startedAt: number, intervalMs: number): void {
  cadence.history.push(startedAt);
  const latenessMs = Math.max(0, startedAt - due);
  const cadenceBase = latenessMs <= intervalMs * RECOVERABLE_LAG_INTERVALS ? due : startedAt;
  cadence.nextAt = Math.max(
    cadenceBase + intervalMs,
    startedAt + intervalMs * MINIMUM_HANDOFF_GAP_FRACTION,
  );
}
