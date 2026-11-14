import assert from "node:assert/strict"
import { test } from "node:test"
import {
  CAMPAIGN_MODULES,
  campaignHref,
  hasStep,
  moduleOf,
  moduleRedirect,
  nextStep,
  previousStep,
  selectionLimit,
  stepsFor,
  toggleWithLimit,
} from "../../src/lib/campaign-module.ts"
import { NEW_CAMPAIGN_KEY_STORAGE, NEW_ROCKET_CAMPAIGN_KEY_STORAGE } from "../../src/lib/new-campaign-key.ts"

test("each module has its own list, new flow, key storage and steps", () => {
  assert.equal(CAMPAIGN_MODULES.standard.basePath, "/campaigns")
  assert.equal(CAMPAIGN_MODULES.rocket.basePath, "/rocket-campaigns")
  assert.equal(CAMPAIGN_MODULES.rocket.newPath, "/rocket-campaigns/new")
  assert.notEqual(NEW_CAMPAIGN_KEY_STORAGE, NEW_ROCKET_CAMPAIGN_KEY_STORAGE, "the stores the pages use keep separate pending keys")
  assert.deepEqual(CAMPAIGN_MODULES.standard.steps.map((step) => step.key), ["audience", "message", "review"], "no Delivery (Rocket) step for Normal")
  assert.deepEqual(CAMPAIGN_MODULES.rocket.steps.map((step) => step.key), ["audience", "message", "delivery", "review"])
  assert.equal(hasStep("standard", "delivery"), false)
  assert.equal(hasStep("rocket", "delivery"), true)
})

test("links stay inside the module", () => {
  assert.equal(campaignHref("standard", 7), "/campaigns/7")
  assert.equal(campaignHref("rocket", 7, "delivery"), "/rocket-campaigns/7/delivery")
  assert.equal(campaignHref("rocket", 7, null, "setup"), "/rocket-campaigns/7?tab=setup")
  assert.equal(nextStep("standard", "message")?.key, "review")
  assert.equal(nextStep("rocket", "message")?.key, "delivery")
  assert.equal(previousStep("standard", "review")?.key, "message")
  assert.equal(previousStep("rocket", "review")?.key, "delivery")
  assert.equal(nextStep("rocket", "review"), null)
  assert.equal(previousStep("standard", "audience"), null)
})

test("a campaign opened under the other module, or a step its module lacks, is redirected", () => {
  const normal = { id: 3, campaignType: "standard" }
  const rocket = { id: 4, campaignType: "rocket" }
  assert.equal(moduleRedirect("standard", normal, "message"), null)
  assert.equal(moduleRedirect("rocket", rocket, "delivery"), null)
  assert.equal(moduleRedirect("rocket", normal, "message"), "/campaigns/3/message")
  assert.equal(moduleRedirect("standard", rocket, null), "/rocket-campaigns/4")
  assert.equal(moduleRedirect("standard", normal, "delivery"), "/campaigns/3/review", "Normal speed lives on Review")
  assert.equal(moduleRedirect("rocket", normal, "delivery"), "/campaigns/3/review")
  assert.equal(moduleOf({ campaignType: "rocket" }), "rocket")
  assert.equal(moduleOf({ campaignType: "standard" }), "standard")
  assert.equal(moduleOf({}), "standard")
})

test("Normal selects one number and one template; Rocket selects many", () => {
  assert.deepEqual(selectionLimit("standard"), { senders: 1, templates: 1 })
  assert.deepEqual(selectionLimit("rocket"), { senders: null, templates: null })
  assert.deepEqual(toggleWithLimit([1], 2, true, 1), [2], "choosing another replaces")
  assert.deepEqual(toggleWithLimit([1], 1, false, 1), [])
  assert.deepEqual(toggleWithLimit([1], 2, true, null), [1, 2])
  assert.deepEqual(toggleWithLimit([1, 2], 3, true, 2), [1, 2], "a full selection is not exceeded")
  assert.deepEqual(toggleWithLimit([1, 2], 2, true, null), [1, 2], "no duplicates")
})

test("a campaign created before types keeps every step, renders where it was opened and is never bounced", () => {
  const legacy = { id: 9, campaignType: "standard", campaignTypeInferred: true }
  assert.deepEqual(stepsFor("standard", true).map((step) => step.key), ["audience", "message", "delivery", "review"])
  assert.deepEqual(stepsFor("rocket", true).map((step) => step.key), ["audience", "message", "delivery", "review"])
  assert.equal(hasStep("standard", "delivery", true), true)
  assert.equal(nextStep("standard", "message", true)?.key, "delivery")
  assert.equal(previousStep("standard", "review", true)?.key, "delivery")
  assert.equal(moduleRedirect("standard", legacy, "delivery"), null)
  assert.equal(moduleRedirect("rocket", legacy, null), null)
  assert.equal(moduleRedirect("rocket", { ...legacy, campaignType: "rocket" }, "message"), null)
})
