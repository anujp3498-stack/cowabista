import assert from "node:assert/strict"
import { test } from "node:test"
import { eligibleTemplateIdsForSenders, keepEligibleTemplateSelection } from "../../src/lib/rocket-selection.ts"

const templates = [
  { templateId: 101, usable: true, compatibleSenderIds: [1, 2] },
  { templateId: 102, usable: true, compatibleSenderIds: [2] },
  { templateId: 103, usable: true, compatibleSenderIds: [3] },
  { templateId: 104, usable: false, compatibleSenderIds: [1, 2] },
]

test("no sender means no selectable templates", () => {
  assert.deepEqual([...eligibleTemplateIdsForSenders(templates, [])], [])
})
test("one sender only exposes its eligible templates", () => {
  assert.deepEqual([...eligibleTemplateIdsForSenders(templates, [1])], [101])
})
test("multiple senders get a deduplicated union of server-authorized templates", () => {
  assert.deepEqual([...eligibleTemplateIdsForSenders(templates, [1, 3])], [101, 103])
})
test("deselecting a sender removes templates with no remaining eligible sender", () => {
  const current = [101, 102, 103, 104]
  const remaining = eligibleTemplateIdsForSenders(templates, [2])
  assert.deepEqual(keepEligibleTemplateSelection(current, remaining), [101, 102])
})
