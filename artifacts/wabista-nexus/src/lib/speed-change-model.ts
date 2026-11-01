// Live speed change for a Rocket campaign (pure, dependency-free; unit
// tested with node --experimental-strip-types). The engine changes speed
// only while a campaign is Paused (V2-06C adjust-speed: queued messages get
// the new per-number rate; plan, allocations, templates and in-flight
// messages are untouched). This composes the existing actions; it adds no
// engine behaviour:
//   pause (purpose speed_change) -> adjust-speed -> resume (only if this
//   flow's own pause changed the status). A campaign that was already
//   paused gets a pause that changes nothing (the server records it when
//   someone else's speed change holds the campaign, so that hold's resume is
//   refused), then the speed; it stays paused.
// It never resumes after a failed adjustment (a speed the engine refused
// must not be silently replaced by the old one), never resumes a campaign
// it did not pause itself (the pause answer says alreadySettled when the
// campaign was already paused, e.g. by another person), and says exactly
// what state the campaign is left in. The caller passes a freshly read
// status, never a cached one.

export type SpeedChangeAction = "pause" | "adjust-speed" | "resume"

export type SpeedChangeOutcome =
  | { ok: true; resumed: boolean; message: string }
  | { ok: false; failedAt: SpeedChangeAction; pausedByUs: boolean; message: string; error: unknown; notSent?: true }

export function speedChangeSteps(status: string): SpeedChangeAction[] | null {
  if (status === "Running" || status === "Paused") return ["pause", "adjust-speed", "resume"]
  return null
}

export function canChangeSpeedLive(status: string): boolean {
  return speedChangeSteps(status) !== null
}

const changedNothing = (result: unknown) =>
  typeof result === "object" && result !== null && (result as { alreadySettled?: unknown }).alreadySettled === true

/**
 * Runs the steps with `act` (one campaign action each; it resolves to the
 * action's response). `act` throws on a refused action; `messageOf` turns
 * that into the server's message.
 */
export async function runSpeedChange(
  status: string,
  act: (action: SpeedChangeAction) => Promise<unknown>,
  messageOf: (error: unknown) => string,
  codeOf: (error: unknown) => string | undefined = () => undefined,
): Promise<SpeedChangeOutcome> {
  const steps = speedChangeSteps(status)
  // Nothing is sent for a campaign that is no longer running or paused.
  if (!steps) return { ok: false, failedAt: "adjust-speed", pausedByUs: false, message: `The speed of a ${status.toLowerCase()} campaign cannot be changed.`, error: null, notSent: true }
  let pausedByUs = false
  let pausedByOthers = false
  for (const step of steps) {
    // Only a pause this flow made is undone.
    if (step === "resume" && !pausedByUs) continue
    let result: unknown
    try {
      result = await act(step)
    } catch (error) {
      const reason = messageOf(error)
      if (step === "pause") return { ok: false, failedAt: step, pausedByUs, message: `Couldn't pause the campaign to change its speed: ${reason} Nothing was changed.`, error }
      if (step === "adjust-speed") {
        return {
          ok: false, failedAt: step, pausedByUs, error,
          message: pausedByUs
            ? `The speed was not changed: ${reason} The campaign is paused; correct the speed and try again, or resume it at its previous speed.`
            : `The speed was not changed: ${reason}`,
        }
      }
      // The server refuses the speed-change resume when someone paused the
      // campaign while the speed was being changed: their pause stands.
      if (codeOf(error) === "paused_by_someone_else") return { ok: true, resumed: false, message: "New speed saved. Someone paused the campaign while the speed was being changed, so it stays paused; resume it when you are ready." }
      return { ok: false, failedAt: step, pausedByUs, message: `The new speed is saved, but the campaign could not be resumed: ${reason} It is paused; press Resume.`, error }
    }
    if (step === "pause") {
      if (changedNothing(result)) pausedByOthers = true
      else pausedByUs = true
    }
  }
  if (pausedByOthers) return { ok: true, resumed: false, message: "New speed saved. The campaign was already paused, so it stays paused; resume it when you are ready." }
  return { ok: true, resumed: true, message: "New speed applied; the campaign is sending again." }
}

type SpeedChangeFailure = Extract<SpeedChangeOutcome, { ok: false }>

/**
 * The message for a failed speed change, from the campaign's status read
 * AFTER the failure (null = it could not be read) and whether the failure
 * was a definite refusal (an HTTP 4xx answer) rather than a lost answer
 * (network error or 5xx), after which the step may still have happened.
 */
export function failureMessage(outcome: SpeedChangeFailure, statusNow: string | null, definiteRefusal: boolean): string {
  // Decided before any request: no answer was lost.
  if (outcome.notSent) return outcome.message
  const now = statusNow ? statusNow.toLowerCase() : null
  if (outcome.failedAt === "pause") {
    if (definiteRefusal) return outcome.message
    if (statusNow === "Paused") return "The connection failed, but the pause may have gone through: the campaign is paused now and its speed was not changed. Apply the speed again, or press Resume."
    if (now) return `The connection failed. The speed was not changed; the campaign is ${now}.`
    return "The connection failed, so it is not known whether the campaign was paused. Reload the page to see its state."
  }
  // A lost answer (not a refusal): the step may have happened.
  if (!definiteRefusal) {
    if (outcome.failedAt === "adjust-speed") {
      return now
        ? `The connection failed, so it is not known whether the new speed was saved; the campaign is ${now}. Apply the speed again (applying the same speed twice is safe).`
        : "The connection failed, so it is not known whether the new speed was saved. Reload the page and apply the speed again."
    }
    if (statusNow === "Running") return "The new speed is saved and the campaign is sending again."
    if (statusNow === "Paused") return outcome.message
    return now ? `The new speed is saved; the campaign is now ${now}.` : `${outcome.message} (Its current state could not be read; reload the page.)`
  }
  if (!outcome.pausedByUs || statusNow === "Paused") return outcome.message
  if (now) {
    return outcome.failedAt === "adjust-speed"
      ? `The speed was not changed. Meanwhile the campaign was changed by someone else and is now ${now}.`
      : `The new speed is saved. Meanwhile the campaign was changed by someone else and is now ${now}.`
  }
  return `${outcome.message} (Its current state could not be read; reload the page.)`
}
