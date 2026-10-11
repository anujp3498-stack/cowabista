// Template submit failures: a 409/502 answer that carries the UPDATED draft
// is recognised, adopted and explained; TemplateDraftError bodies are not.
// Run: node --experimental-strip-types --test test/unit/template-submit-outcome.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import type { TemplateDraft } from "@workspace/api-client-react"
import { isTemplateDraftBody, submitFailureDraft, submitOutcomeBanner } from "../../src/lib/template-submit-outcome.ts"

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  id: 12, wabaId: 3, wabaDisplayName: "Acme WABA", name: "promo_v1", language: "en_US", category: "MARKETING",
  content: { header: { kind: "none" }, body: { text: "Hello", examples: [] }, footer: null, buttons: [] },
  revision: 4, state: "draft", providerTemplateId: null, providerStatus: null, providerStatusCheckedAt: null, templateId: null,
  lastError: null, latestAttempt: null, validation: [], createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
  ...over,
})

/** What the generated client throws for a non-2xx answer: message "HTTP <status> <text>", parsed body in `data`. */
const apiError = (status: number, statusText: string, data: unknown) => Object.assign(new Error(`HTTP ${status} ${statusText}`), { name: "ApiError", status, statusText, data })

const HTTP_ONLY = /^HTTP \d{3}\b/

// lastError texts exactly as the server's classifyOutcome writes them (template-submission.ts).
const REFUSED = "Meta refused the template: Invalid parameter"
const RECONNECT = "The workspace credential for this business account is not active. Reconnect it in Number Center."
const UNCONFIRMED = "WhatsApp (Meta) did not confirm whether the template was created. Reconcile before anything else; nothing is retried automatically."
const INTERRUPTED = "The submission was interrupted before Meta's answer was recorded. Reconcile before anything else; nothing is retried automatically."

test("409 with the returned draft in state `failed`: the fresh draft is adopted and the stored reason is shown, never a bare HTTP 409", () => {
  const returned = draft({ state: "failed", revision: 4, lastError: REFUSED })
  const error = apiError(409, "Conflict", returned)
  const adopted = submitFailureDraft(error)
  assert.equal(adopted, returned, "the returned draft itself is adopted")
  assert.equal(adopted!.state, "failed")
  assert.equal(adopted!.revision, 4)
  const banner = submitOutcomeBanner(adopted!)
  assert.equal(banner.title, "The template was not submitted")
  assert.equal(banner.description, REFUSED)
  assert.equal(banner.variant, "destructive")
  // A failure recorded before any request reached Meta is not blamed on Meta.
  const credential = submitOutcomeBanner(draft({ state: "failed", lastError: RECONNECT }))
  assert.equal(credential.title, "The template was not submitted")
  assert.equal(credential.description, RECONNECT)
  assert.doesNotMatch(`${banner.title} ${banner.description}`, HTTP_ONLY)
  assert.doesNotMatch(`${banner.title} ${banner.description}`, /409|Conflict/)
})

test("`failed` without a stored reason still gets a clear provider-rejection message", () => {
  const banner = submitOutcomeBanner(draft({ state: "failed", lastError: "  " }))
  assert.equal(banner.title, "Meta did not accept the template")
  assert.match(banner.description!, /Meta refused the submission/)
})

test("502 with the returned draft in state `reconcile_required`: adopted; the banner says Meta did not confirm, reconciliation is needed and nothing is retried automatically", () => {
  const returned = draft({ state: "reconcile_required", revision: 4, lastError: UNCONFIRMED })
  const adopted = submitFailureDraft(apiError(502, "Bad Gateway", returned))
  assert.equal(adopted, returned)
  assert.equal(adopted!.state, "reconcile_required")
  const banner = submitOutcomeBanner(adopted!)
  assert.equal(banner.title, "Meta did not confirm the submission")
  assert.match(banner.description!, /did not confirm whether the template was created/)
  assert.match(banner.description!, /not resubmitted automatically/)
  assert.match(banner.description!, /stays locked until Meta confirms the outcome/)
  assert.ok(banner.description!.endsWith(` Details: ${UNCONFIRMED}`), "the safe lastError is included, labelled neutrally")
  assert.doesNotMatch(banner.description!, /Meta's answer:/, "Wabista's own text is not presented as Meta's reply")
  const interrupted = submitOutcomeBanner(draft({ state: "reconcile_required", lastError: INTERRUPTED }))
  assert.ok(interrupted.description!.endsWith(` Details: ${INTERRUPTED}`))
  assert.doesNotMatch(banner.description!, /\bwill (retry|resubmit)\b|retrying|automatically retr/i, "never implies an automatic retry")
  assert.doesNotMatch(`${banner.title} ${banner.description}`, /502|Bad Gateway/)
})

test("a returned draft still `submitting`: the banner says a submission is already in progress", () => {
  const banner = submitOutcomeBanner(draft({ state: "submitting" }))
  assert.equal(banner.title, "Submission already in progress")
  assert.match(banner.description!, /cannot be submitted again meanwhile/)
})

test("TemplateDraftError bodies are not drafts: they keep the existing error handling", () => {
  for (const code of ["stale_revision", "invalid_draft", "credential_inactive", "attempt_in_progress", "reconcile_required", "provider_unavailable", "provider_rejected"]) {
    const body = { error: "Something specific happened.", code, fields: [], attempt: null }
    assert.equal(isTemplateDraftBody(body), false, code)
    assert.equal(submitFailureDraft(apiError(409, "Conflict", body)), null, code)
  }
  // Even a TemplateDraftError that happens to carry draft-like fields is not adopted.
  assert.equal(submitFailureDraft(apiError(409, "Conflict", { ...draft({ state: "failed" }), code: "attempt_in_progress", error: "In progress" })), null)
})

test("anything that is not a complete draft body is not adopted", () => {
  for (const data of [null, undefined, "HTTP 502", 42, {}, { id: 12, state: "failed" }, { ...draft(), state: "approved" }, { ...draft(), revision: "4" }, { ...draft(), content: null }]) {
    assert.equal(submitFailureDraft(apiError(502, "Bad Gateway", data)), null, JSON.stringify(data))
  }
  assert.equal(submitFailureDraft(new Error("network down")), null)
  assert.equal(submitFailureDraft(null), null)
})

test("banners never carry provider ids, handles or tokens: only the server's own lastError text", () => {
  const returned = draft({ state: "failed", lastError: "Meta refused the template.", providerTemplateId: "tpl-998877", wabaExternalId: "waba-ext-123" })
  const banner = submitOutcomeBanner(returned)
  assert.ok(!JSON.stringify(banner).includes("tpl-998877") && !JSON.stringify(banner).includes("waba-ext-123"))
})
