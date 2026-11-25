import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import { getListTemplatesQueryKey, useSyncWhatsAppTemplates } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { messageFrom } from "@/lib/api-errors"
import { summarizeInlineTemplateSync, type InlineTemplateSyncSummary } from "@/lib/inline-template-sync-summary"

/** Reuses the existing owner/admin sync API. Never starts a campaign or sends messages. */
export function InlineMetaTemplateSync({ onSynced, disabled = false }: {
  onSynced?: () => Promise<void>
  disabled?: boolean
}) {
  const { organizationId, role } = useActiveOrganization()
  const canSync = role === "owner" || role === "admin"
  const sync = useSyncWhatsAppTemplates()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<InlineTemplateSyncSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runSync = async () => {
    if (!organizationId || !canSync || busy || disabled) return
    setBusy(true)
    setSummary(null)
    setError(null)
    try {
      const result = await sync.mutateAsync({ organizationId })
      setSummary(summarizeInlineTemplateSync(result))
      // The Message Studio embeds eligibility in its setup response; legacy
      // Rocket uses separately cached compatibility queries. Refresh both.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ["whatsapp-compatibility", organizationId] }),
      ])
      await onSynced?.()
    } catch (cause) {
      setError(messageFrom(cause, "Could not sync or refresh templates. Please retry."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="inline-meta-template-sync">
      <Button type="button" size="sm" variant="outline" onClick={() => void runSync()}
        disabled={!canSync || !organizationId || disabled || busy} data-testid="button-inline-sync-templates"
        className="gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
        {busy ? "Syncing Meta templates…" : "Sync all Meta templates"}
      </Button>
      {!canSync ? <p className="text-xs text-muted-foreground">Only the workspace owner or an admin can sync Meta templates.</p> : null}
      {summary ? (
        <Alert variant={summary.hasFailures ? "destructive" : "default"} data-testid="inline-template-sync-result">
          <AlertTitle>{summary.title}</AlertTitle>
          <AlertDescription>
            <p>{summary.description}</p>
            {summary.failedAccounts.length ? (
              <ul className="mt-2 list-disc pl-5">
                {summary.failedAccounts.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" data-testid="inline-template-sync-error">
          <AlertTitle>Template sync or refresh was not completed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
