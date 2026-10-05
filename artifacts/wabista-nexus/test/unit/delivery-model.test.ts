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

test("the Delivery route is registered before the dynamic campaign detail route; steps are Audience, Message, Delivery only", () => {
  const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8")
  const delivery = app.indexOf('path="/campaigns/:campaignId/delivery"')
  const detail = app.indexOf('path="/campaigns/:campaignId"')
  assert.ok(delivery > 0 && detail > 0 && delivery < detail)
  assert.ok(!app.includes("/review"), "no Review & Launch route yet")
  const steps = readFileSync(new URL("../../src/components/campaigns/campaign-steps.tsx", import.meta.url), "utf8")
  const keys = [...steps.matchAll(/\{ key: "([a-z]+)", label: "([A-Za-z ]+)"/g)].map((m) => `${m[1]}:${m[2]}`)
  assert.deepEqual(keys, ["audience:Audience", "message:Message", "delivery:Delivery"])
})
