// V2-06C Review & Launch model: grouping of server issues, launch gating and
// the launch request (send now / schedule).
// Run: node --experimental-strip-types --test test/unit/review-model.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  CHECK_GROUPS,
  approxCount,
  approxPercent,
  blockersIn,
  canLaunch,
  doNotContact,
  groupBlockers,
  launchBody,
  launchOutcomeMessage,
  scheduledInstant,
} from "../../src/lib/review-model.ts"

test("server blockers are grouped for display; unknown codes are never hidden", () => {
  const blockers = [{ code: "mapping_missing" }, { code: "sender_unusable" }, { code: "credential_not_ready" }, { code: "brand_new_code" }]
  const counts = groupBlockers(blockers)
  assert.equal(counts.get("variables"), 1)
  assert.equal(counts.get("numbers"), 1)
  assert.equal(counts.get("connection"), 1)
  assert.equal(counts.get("setup"), 1, "an unknown code is shown under setup")
  assert.deepEqual(blockersIn(blockers, "setup").map((b) => b.code), ["brand_new_code"])
  const codes = CHECK_GROUPS.flatMap((group) => group.codes)
  assert.equal(new Set(codes).size, codes.length, "each code belongs to one group")
})

test("launch is enabled only when the server reports ready AND the campaign is Draft/Ready", () => {
  assert.equal(canLaunch(undefined), false)
  assert.equal(canLaunch({ ready: false, status: "Draft" }), false)
  assert.equal(canLaunch({ ready: true, status: "Draft" }), true)
  assert.equal(canLaunch({ ready: true, status: "Ready" }), true)
  for (const status of ["Running", "Scheduled", "Paused", "Completed", "Cancelled"]) assert.equal(canLaunch({ ready: true, status }), false, status)
})

test("send now has no time; schedule needs a future local time and carries the time zone", () => {
  const now = new Date("2026-10-05T10:00:00Z")
  assert.deepEqual(launchBody("now", "", "Europe/London", now), { action: "launch" })
  assert.equal(scheduledInstant("", now), null)
  assert.equal(scheduledInstant("not a date", now), null)
  assert.equal(scheduledInstant("2020-01-01T09:00", now), null, "a past time is refused")
  const future = new Date(now.getTime() + 3 * 86_400_000)
  const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T09:30`
  const body = launchBody("schedule", local, "Europe/London", now)
  assert.equal(body.action, "launch")
  assert.equal(body.timezone, "Europe/London")
  assert.equal(new Date(body.scheduledAt!).getTime(), new Date(local).getTime())
  assert.throws(() => launchBody("schedule", "2020-01-01T09:00", "Europe/London", now))
})

test("projections are always marked approximate; outcomes have business copy", () => {
  assert.equal(approxPercent(1 / 3), "~33%")
  assert.equal(approxCount(12345), "~12,345")
  assert.equal(doNotContact({ suppressed: 3, suppressedSinceImport: 2 }), 5)
  assert.equal(launchOutcomeMessage("launched"), "Your campaign is sending.")
  assert.equal(launchOutcomeMessage("already_running"), "This campaign was already launched and is sending.")
  assert.equal(launchOutcomeMessage("scheduled"), "Your campaign is scheduled.")
})
