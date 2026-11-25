import assert from "node:assert/strict"
import { test } from "node:test"
import type { WhatsAppTemplateSyncResult } from "@workspace/api-client-react"
import { summarizeInlineTemplateSync } from "../../src/lib/inline-template-sync-summary.ts"

const make = (rows: WhatsAppTemplateSyncResult["wabas"]): WhatsAppTemplateSyncResult => ({
  syncedAt: "2026-11-25T00:00:00Z", wabas: rows,
})
const row = (status: "synced" | "failed" | "superseded", id: number, count = 0): WhatsAppTemplateSyncResult["wabas"][number] => ({
  wabaId: id, wabaExternalId: String(id), wabaDisplayName: `WABA ${id}`,
  source: "workspace_credential", status, templatesSeen: count,
  templatesUpserted: count, templatesMarkedRemoved: 0,
})

test("empty workspace does not claim a successful template sync", () => {
  const result = summarizeInlineTemplateSync(make([]))
  assert.equal(result.title, "Nothing to sync")
  assert.equal(result.hasFailures, false)
})

test("all successful WABAs report exact template and account totals", () => {
  const result = summarizeInlineTemplateSync(make([row("synced", 1, 3), row("synced", 2, 7)]))
  assert.equal(result.title, "Meta templates refreshed")
  assert.match(result.description, /10 template\(s\) seen across 2 synced/)
  assert.equal(result.hasFailures, false)
})

test("partial Meta failures never pretend everything synced", () => {
  const failed = { ...row("failed", 2), error: { code: "provider_rejected" as const, message: "Missing permission" } }
  const result = summarizeInlineTemplateSync(make([row("synced", 1, 3), failed]))
  assert.equal(result.title, "Templates partially synced")
  assert.equal(result.hasFailures, true)
  assert.deepEqual(result.failedAccounts, ["WABA 2: Missing permission"])
})

test("superseded WABAs are not counted as newly synced", () => {
  const result = summarizeInlineTemplateSync(make([row("superseded", 1)]))
  assert.equal(result.title, "Already refreshed")
  assert.equal(result.hasFailures, false)
})
