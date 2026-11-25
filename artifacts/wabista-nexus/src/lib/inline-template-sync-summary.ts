import type { WhatsAppTemplateSyncResult } from "@workspace/api-client-react"

export type InlineTemplateSyncSummary = {
  title: string
  description: string
  hasFailures: boolean
  failedAccounts: string[]
}

/** A sync can partially succeed. Never claim all WABAs synced when one failed. */
export function summarizeInlineTemplateSync(result: WhatsAppTemplateSyncResult): InlineTemplateSyncSummary {
  const synced = result.wabas.filter((row) => row.status === "synced")
  const failed = result.wabas.filter((row) => row.status === "failed")
  const superseded = result.wabas.filter((row) => row.status === "superseded")
  const totalTemplates = synced.reduce((sum, row) => sum + row.templatesSeen, 0)
  const failedAccounts = failed.map((row) => `${row.wabaDisplayName}: ${row.error?.message ?? "Sync failed"}`)

  if (!result.wabas.length) {
    return { title: "Nothing to sync", description: "Connect a WhatsApp number in this workspace first.", hasFailures: false, failedAccounts: [] }
  }
  if (failed.length) {
    return {
      title: synced.length ? "Templates partially synced" : "Some Meta accounts could not sync",
      description: `${synced.length} account(s) synced (${totalTemplates} template(s) seen); ${failed.length} failed${superseded.length ? `; ${superseded.length} refreshed by a newer sync` : ""}. Check the account errors below.`,
      hasFailures: true,
      failedAccounts,
    }
  }
  if (!synced.length && superseded.length) {
    return { title: "Already refreshed", description: "A newer sync for these business accounts completed first. The latest template list has been loaded.", hasFailures: false, failedAccounts: [] }
  }
  return {
    title: "Meta templates refreshed",
    description: `${totalTemplates} template(s) seen across ${synced.length} synced business account(s)${superseded.length ? `; ${superseded.length} already refreshed by a newer sync` : ""}. Only approved templates eligible for your selected numbers appear in this campaign.`,
    hasFailures: false,
    failedAccounts: [],
  }
}
