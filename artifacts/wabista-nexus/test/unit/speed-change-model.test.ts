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
  assert.deepEqual(speedChangeSteps("Paused"), ["adjust-speed"])
  for (const status of ["Draft", "Ready", "Scheduled", "Completed", "Cancelled", "Failed"]) assert.equal(canChangeSpeedLive(status), false)
})

test("Running: pauses, adjusts and resumes", async () => {
  const r = recorder()
  const outcome = await runSpeedChange("Running", r.act, messageOf)
  assert.deepEqual(r.calls, ["pause", "adjust-speed", "resume"])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.resumed, true)
})

test("Paused: adjusts only and stays paused", async () => {
  const r = recorder()
  const outcome = await runSpeedChange("Paused", r.act, messageOf)
  assert.deepEqual(r.calls, ["adjust-speed"])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.resumed, false)
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
  assert.match(outcome.message, /already been paused/)
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
