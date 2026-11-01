// Live speed change for a Rocket campaign (pure, dependency-free; unit
// tested with node --experimental-strip-types). The engine changes speed
// only while a campaign is Paused (V2-06C adjust-speed: queued messages get
// the new per-number rate; plan, allocations, templates and in-flight
// messages are untouched). This composes the existing actions; it adds no
// engine behaviour:
//   Running: pause -> adjust-speed -> resume
//   Paused:  adjust-speed (stays paused; the user resumes when ready)
// It never resumes after a failed adjustment (a speed the engine refused
// must not be silently replaced by the old one), and says exactly what
// state the campaign is left in.

export type SpeedChangeAction = "pause" | "adjust-speed" | "resume"

export type SpeedChangeOutcome =
  | { ok: true; resumed: boolean; message: string }
  | { ok: false; failedAt: SpeedChangeAction; pausedByUs: boolean; message: string; error: unknown }

export function speedChangeSteps(status: string): SpeedChangeAction[] | null {
  if (status === "Running") return ["pause", "adjust-speed", "resume"]
  if (status === "Paused") return ["adjust-speed"]
  return null
}

export function canChangeSpeedLive(status: string): boolean {
  return speedChangeSteps(status) !== null
}

/**
 * Runs the steps with `act` (one campaign action each). `act` throws on a
 * refused action; `messageOf` turns that into the server's message.
 */
export async function runSpeedChange(
  status: string,
  act: (action: SpeedChangeAction) => Promise<unknown>,
  messageOf: (error: unknown) => string,
): Promise<SpeedChangeOutcome> {
  const steps = speedChangeSteps(status)
  if (!steps) return { ok: false, failedAt: "adjust-speed", pausedByUs: false, message: `The speed of a ${status.toLowerCase()} campaign cannot be changed.`, error: null }
  let pausedByUs = false
  for (const step of steps) {
    try {
      await act(step)
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
      return { ok: false, failedAt: step, pausedByUs, message: `The new speed is saved, but the campaign could not be resumed: ${reason} It is paused; press Resume.`, error }
    }
    if (step === "pause") pausedByUs = true
  }
  return steps.includes("resume")
    ? { ok: true, resumed: true, message: "New speed applied; the campaign is sending again." }
    : { ok: true, resumed: false, message: "New speed saved. The campaign is still paused; resume it when you are ready." }
}
