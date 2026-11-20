// Live speed change composition (Rocket): pause -> adjust-speed -> resume.
// Run: node --experimental-strip-types --test test/unit/speed-change-model.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { canChangeSpeedLive, runSpeedChange, speedChangeSteps } from "../../src/lib/speed-change-model.ts"

const recorder = (failAt?: string) => {
  const calls: string[] = []
  const act = async (action: string) => {
    calls.push(action)
    if (action === failAt) throw new Error(`${action} refused.`)
  }
  return { calls, act }
}
const messageOf = (error: unknown) => (error as Error).message

test("steps per status: only Running and Paused campaigns change speed live", () => {
  assert.deepEqual(speedChangeSteps("Running"), ["pause", "adjust-speed", "resume"])
  assert.deepEqual(speedChangeSteps("Paused"), ["pause", "adjust-speed", "resume"], "resume runs only if this flow's own pause changed the status")
  for (const status of ["Draft", "Ready", "Scheduled", "Completed", "Cancelled", "Failed"]) assert.equal(canChangeSpeedLive(status), false)
})

test("Running: pauses, adjusts and resumes", async () => {
  const r = recorder()
  const outcome = await runSpeedChange("Running", r.act, messageOf)
  assert.deepEqual(r.calls, ["pause", "adjust-speed", "resume"])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.resumed, true)
})

// Contract changed on purpose (round 4): a Paused campaign also gets the
// speed-change pause (a no-op the server answers alreadySettled, recorded
// when someone else's speed change holds it), so it is never resumed here.
test("Paused: the pause changes nothing, the speed is saved, it stays paused", async () => {
  const calls: string[] = []
  const act = async (action: string) => {
    calls.push(action)
    return action === "pause" ? { status: "Paused", alreadySettled: true } : { status: "Paused" }
  }
  const outcome = await runSpeedChange("Paused", act, messageOf)
  assert.deepEqual(calls, ["pause", "adjust-speed"])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.resumed, false)
  assert.match(outcome.message, /stays paused/)
})

test("a refused speed never resumes at the old speed; the campaign is reported paused", async () => {
  const r = recorder("adjust-speed")
  const outcome = await runSpeedChange("Running", r.act, messageOf)
  assert.deepEqual(r.calls, ["pause", "adjust-speed"], "no resume after a failed adjustment")
  assert.equal(outcome.ok, false)
  assert.ok(!outcome.ok && outcome.failedAt === "adjust-speed" && outcome.pausedByUs)
  assert.match(!outcome.ok ? outcome.message : "", /is paused/)
})

test("a failed pause changes nothing; a failed resume says to press Resume", async () => {
  const pause = recorder("pause")
  const first = await runSpeedChange("Running", pause.act, messageOf)
  assert.deepEqual(pause.calls, ["pause"])
  assert.match(!first.ok ? first.message : "", /Nothing was changed/)
  const resume = recorder("resume")
  const second = await runSpeedChange("Running", resume.act, messageOf)
  assert.deepEqual(resume.calls, ["pause", "adjust-speed", "resume"])
  assert.match(!second.ok ? second.message : "", /press Resume/)
})

test("an unsupported status calls nothing", async () => {
  const r = recorder()
  const outcome = await runSpeedChange("Completed", r.act, messageOf)
  assert.deepEqual(r.calls, [])
  assert.equal(outcome.ok, false)
})

test("a pause that changed nothing (someone else had paused) never ends in a resume", async () => {
  const calls: string[] = []
  const act = async (action: string) => {
    calls.push(action)
    return action === "pause" ? { status: "Paused", alreadySettled: true } : { status: "Paused" }
  }
  const outcome = await runSpeedChange("Running", act, messageOf)
  assert.deepEqual(calls, ["pause", "adjust-speed"], "the other person's pause is kept")
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.resumed, false)
  assert.match(outcome.message, /already paused/)
})

test("a pause this flow made is undone after the speed is saved", async () => {
  const calls: string[] = []
  const act = async (action: string) => {
    calls.push(action)
    return { status: action === "resume" ? "Running" : "Paused", alreadySettled: false }
  }
  const outcome = await runSpeedChange("Running", act, messageOf)
  assert.deepEqual(calls, ["pause", "adjust-speed", "resume"])
  assert.equal(outcome.ok && outcome.resumed, true)
})

test("a speed-change resume refused because someone paused meanwhile keeps their pause and reports it", async () => {
  const calls: string[] = []
  const act = async (action: string) => {
    calls.push(action)
    if (action === "resume") throw Object.assign(new Error("Someone paused this campaign."), { code: "paused_by_someone_else" })
    return { status: "Paused", alreadySettled: false }
  }
  const outcome = await runSpeedChange("Running", act, messageOf, (error) => (error as { code?: string }).code)
  assert.deepEqual(calls, ["pause", "adjust-speed", "resume"])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.resumed, false)
  assert.match(outcome.message, /stays paused/)
})

test("failure messages follow the campaign's real state after the failure", async () => {
  const { failureMessage } = await import("../../src/lib/speed-change-model.ts")
  const pauseFail = { ok: false as const, failedAt: "pause" as const, pausedByUs: false, message: "Couldn't pause the campaign to change its speed: x Nothing was changed.", error: null }
  assert.match(failureMessage(pauseFail, "Running", true), /Nothing was changed/, "a definite refusal changed nothing")
  assert.match(failureMessage(pauseFail, "Paused", false), /may have gone through: the campaign is paused now/, "a lost answer after a committed pause")
  assert.match(failureMessage(pauseFail, null, false), /not known whether/)
  const adjustFail = { ok: false as const, failedAt: "adjust-speed" as const, pausedByUs: true, message: "The speed was not changed: x The campaign is paused; ...", error: null }
  assert.equal(failureMessage(adjustFail, "Paused", true), adjustFail.message)
  assert.match(failureMessage(adjustFail, "Running", true), /changed by someone else and is now running/)
  assert.match(failureMessage(adjustFail, "Cancelled", true), /is now cancelled/)
  const resumeFail = { ok: false as const, failedAt: "resume" as const, pausedByUs: true, message: "The new speed is saved, but ... press Resume.", error: null }
  assert.match(failureMessage(resumeFail, "Cancelled", true), /new speed is saved\. Meanwhile .* now cancelled/)
})

test("a lost answer (not a refusal) to adjust or resume never claims nothing happened or blames someone else", async () => {
  const { failureMessage } = await import("../../src/lib/speed-change-model.ts")
  const adjustLost = { ok: false as const, failedAt: "adjust-speed" as const, pausedByUs: true, message: "The speed was not changed: x ...", error: null }
  assert.match(failureMessage(adjustLost, "Paused", false), /not known whether the new speed was saved; the campaign is paused/)
  const resumeLost = { ok: false as const, failedAt: "resume" as const, pausedByUs: true, message: "The new speed is saved, but ... press Resume.", error: null }
  assert.equal(failureMessage(resumeLost, "Running", false), "The new speed is saved and the campaign is sending again.")
  assert.equal(failureMessage(resumeLost, "Paused", false), resumeLost.message)
})

test("a campaign that stopped before Apply gets the plain 'cannot be changed' message, never 'connection failed'", async () => {
  const { failureMessage } = await import("../../src/lib/speed-change-model.ts")
  for (const status of ["Cancelled", "Completed", "Failed"]) {
    const calls: string[] = []
    const outcome = await runSpeedChange(status, async (action) => { calls.push(action) }, messageOf)
    assert.deepEqual(calls, [], "nothing is sent")
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(failureMessage(outcome, status, false), /cannot be changed/)
  }
})
