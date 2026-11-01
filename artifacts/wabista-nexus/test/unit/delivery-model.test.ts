// V2-06B Delivery step model, route order and step navigation.
// Run: node --experimental-strip-types --test test/unit/delivery-model.test.ts
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  deliveryDraftFrom,
  deliveryPayload,
  estimateSeconds,
  formatDuration,
  parseRate,
  plannedTotal,
  rateHint,
  sameDeliveryDraft,
} from "../../src/lib/delivery-model.ts"

const sender = (id: number, ceiling: number, advancedRate: number | null = null) => ({
  phoneNumberId: id, phone: `+1555000000${id}`, displayName: `N${id}`, usable: true, providerApprovedRate: ceiling, platformRate: 1000,
  effectiveCeiling: ceiling, plannedRate: null, advancedRate,
  presetRates: { fastest_safe: ceiling, balanced: Math.max(1, Math.floor(ceiling * 0.6)), conservative: Math.min(ceiling, Math.max(5, Math.floor(ceiling * 0.25))) },
})
const setup = {
  revision: 4, distributionMode: "equal_numbers" as const, deliveryMode: "balanced" as const, totalMessagesPerSecond: 60, recipients: 1000,
  senders: [sender(1, 80, 30), sender(2, 20)],
  modeSummaries: [
    { deliveryMode: "fastest_safe" as const, totalMessagesPerSecond: 100, estimatedDurationSeconds: 10 },
    { deliveryMode: "balanced" as const, totalMessagesPerSecond: 60, estimatedDurationSeconds: 17 },
    { deliveryMode: "conservative" as const, totalMessagesPerSecond: 25, estimatedDurationSeconds: 40 },
  ],
}

test("the draft hydrates from server values (saved advanced rate, else the number's fastest safe rate)", () => {
  const draft = deliveryDraftFrom(setup)
  assert.equal(draft.distributionMode, "equal_numbers")
  assert.equal(draft.deliveryMode, "balanced")
  assert.deepEqual(draft.rates, { "1": "30", "2": "20" })
  assert.ok(sameDeliveryDraft(draft, deliveryDraftFrom(setup)))
})

test("dirty state: choices always count; advanced rates only while Advanced is chosen", () => {
  const saved = deliveryDraftFrom(setup)
  assert.ok(sameDeliveryDraft({ ...saved, rates: { "1": "1", "2": "1" } }, saved), "hidden advanced inputs do not make a preset dirty")
  assert.ok(!sameDeliveryDraft({ ...saved, distributionMode: "equal_templates" }, saved))
  const advanced = { ...saved, deliveryMode: "advanced" as const }
  assert.ok(!sameDeliveryDraft({ ...advanced, rates: { "1": "31", "2": "20" } }, advanced))
})

test("rates: whole numbers >= 1 only; hints never clamp", () => {
  assert.equal(parseRate("12"), 12)
  for (const bad of ["0", "-3", "2.5", "abc", "", " ", "1e3"]) assert.equal(parseRate(bad), null, bad)
  assert.match(rateHint("2.5", 80)!, /whole number/)
  assert.match(rateHint("200", 80)!, /at most 80 messages\/sec/)
  assert.equal(rateHint("80", 80), null)
})

test("the save payload carries the base revision; advanced rates are sent as typed for every selected number", () => {
  const draft = { distributionMode: "equal_templates" as const, deliveryMode: "advanced" as const, rates: { "1": "40", "2": "2.5" } }
  assert.deepEqual(deliveryPayload(draft, setup, 4), {
    revision: 4, distributionMode: "equal_templates", deliveryMode: "advanced",
    deliverySettings: { perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 40 }, { phoneNumberId: 2, messagesPerSecond: 2.5 }] },
  })
  assert.deepEqual(deliveryPayload({ ...draft, rates: { "1": "40", "2": "" } }, setup, 4).deliverySettings, { perNumberRates: [{ phoneNumberId: 1, messagesPerSecond: 40 }] }, "an empty entry is left for the server to report as missing")
  assert.deepEqual(deliveryPayload({ ...draft, deliveryMode: "balanced" }, setup, 7), { revision: 7, distributionMode: "equal_templates", deliveryMode: "balanced" }, "presets keep the saved advanced values")
  assert.throws(() => deliveryPayload({ ...draft, distributionMode: null }, setup, 4))
})

test("totals come from the server for presets; Advanced sums valid typed rates", () => {
  const saved = deliveryDraftFrom(setup)
  assert.equal(plannedTotal(saved, setup, false), 60)
  assert.equal(plannedTotal({ ...saved, deliveryMode: "conservative" }, setup, true), 25)
  assert.equal(plannedTotal({ ...saved, deliveryMode: "advanced", rates: { "1": "40", "2": "15" } }, setup, true), 55)
  assert.equal(plannedTotal({ ...saved, deliveryMode: "advanced", rates: { "1": "400", "2": "15" } }, setup, true), null, "an over-ceiling rate has no total")
  assert.equal(estimateSeconds(1000, 60), 17)
  assert.equal(estimateSeconds(1000, null), null)
  assert.equal(formatDuration(17), "about 17 s")
  assert.equal(formatDuration(3_725), "about 1 h 3 min")
})

// Updated at V2-06C: Step 4 (Review & Launch) now exists (was "no Review route yet" in V2-06B).
// Updated for campaign modules: the steps are per module (src/lib/campaign-module.ts);
// Normal has no Delivery step, Rocket's Delivery step is "Speed & Distribution", and
// every Rocket route is registered before its own dynamic detail route too.
test("step routes are registered before each module's dynamic detail route; steps per module", async () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8")
  for (const base of ["/campaigns", "/rocket-campaigns"]) {
    const detail = app.indexOf(`path="${base}/:campaignId"`)
    assert.ok(detail > 0, `${base} detail route`)
    for (const step of ["audience", "message", "delivery", "review"]) {
      const at = app.indexOf(`path="${base}/:campaignId/${step}"`)
      assert.ok(at > 0 && at < detail, `${base}/:campaignId/${step} before the detail route`)
    }
    const created = app.indexOf(`path="${base}/new"`)
    assert.ok(created > 0 && created < detail, `${base}/new before the detail route`)
  }
  const { CAMPAIGN_MODULES } = await import("../../src/lib/campaign-module.ts")
  const keys = (module: "standard" | "rocket") => CAMPAIGN_MODULES[module].steps.map((step) => `${step.key}:${step.label}`)
  assert.deepEqual(keys("standard"), ["audience:Audience", "message:Message", "review:Review & Launch"])
  assert.deepEqual(keys("rocket"), ["audience:Audience", "message:Numbers & Templates", "delivery:Speed & Distribution", "review:Review & Launch"])
})

test("Rocket starts on per-number speed and automatic distribution, never replacing a saved choice", async () => {
  const { rocketDraftDefaults, NORMAL_SPEED_OPTIONS } = await import("../../src/lib/delivery-model.ts")
  assert.deepEqual(rocketDraftDefaults({ distributionMode: null, deliveryMode: null, rates: { "1": "80" } }), { distributionMode: "equal_numbers", deliveryMode: "advanced", rates: { "1": "80" } })
  assert.deepEqual(rocketDraftDefaults({ distributionMode: "equal_templates", deliveryMode: "balanced", rates: {} }), { distributionMode: "equal_templates", deliveryMode: "balanced", rates: {} })
  assert.deepEqual(NORMAL_SPEED_OPTIONS.map((option) => option.value), ["fastest_safe", "balanced", "conservative"])
})
