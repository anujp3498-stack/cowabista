import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react"
import {
  useGetCampaignPlan,
  usePreviewCampaignPlanContact,
  useSearchCampaignPlanRecipients,
  type Campaign,
  type CampaignPlanPreviewResult,
  type CampaignPlanRecipient,
} from "@workspace/api-client-react"
import { messageFrom } from "@/lib/api-errors"
import { labelForRequirement } from "@/lib/template-variables"

const RECIPIENTS_PAGE_SIZE = 10

// Read-only "what will this plan actually send" view for support/ops. Every
// value shown here (routes, templates, mappings, and the per-contact
// preview) comes straight from GET .../plan and POST .../plan/preview, which
// read the campaign's frozen plan snapshot -- the exact same snapshot the
// campaign runtime resolves jobs against (see resolveJobTemplate). This
// dialog can never show something different from what will actually send,
// short of a bug in that shared resolution path itself.
export function CampaignPlanDialog({
  campaign,
  organizationId,
  open,
  onOpenChange,
}: {
  campaign: Campaign | null
  organizationId: number | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const campaignId = campaign?.id

  // Orval-generated get hooks type `options.query` as a full UseQueryOptions
  // (requires `queryKey`), so omit the options arg and rely on the hook's
  // own default `enabled` (id !== null/undefined) -- campaignId is only
  // defined here exactly while the dialog is open.
  const { data: plan, isLoading, isError, error } = useGetCampaignPlan(organizationId as number, campaignId as number)
  const previewMutation = usePreviewCampaignPlanContact()

  const [lookup, setLookup] = useState("")
  const [result, setResult] = useState<CampaignPlanPreviewResult | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)

  const runPreview = () => {
    if (!organizationId || !campaignId || !lookup.trim()) return
    setResult(null)
    setLookupError(null)
    const trimmed = lookup.trim()
    const asContactId = /^\d+$/.test(trimmed) ? Number(trimmed) : null
    const data = asContactId !== null ? { contactId: asContactId } : { phone: trimmed }
    previewMutation.mutate(
      { organizationId, campaignId, data },
      {
        onSuccess: (res) => setResult(res),
        onError: (err) => setLookupError(messageFrom(err, "Contact not found under the active plan")),
      },
    )
  }

  // "Preview one contact" above answers "what will THIS ONE recipient get";
  // this section answers "show me the whole frozen recipient list" -- the
  // other half of the support/ops ask, since a single lookup box can't
  // audit an entire plan without already knowing who to look for.
  const [recipientsSearch, setRecipientsSearch] = useState("")
  const [recipientsOffset, setRecipientsOffset] = useState(0)
  const recipientsMutation = useSearchCampaignPlanRecipients()
  const [recipientsPage, setRecipientsPage] = useState<{
    total: number
    limit: number
    offset: number
    recipients: CampaignPlanRecipient[]
  } | null>(null)

  const runRecipientsSearch = (search: string, offset: number) => {
    if (!organizationId || !campaignId) return
    recipientsMutation.mutate(
      { organizationId, campaignId, data: { search: search.trim() || undefined, limit: RECIPIENTS_PAGE_SIZE, offset } },
      { onSuccess: (res) => setRecipientsPage(res) },
    )
  }

  // Re-run whenever the dialog opens on a plan, or the search/page changes.
  // Debounced only on the search box; page changes fire immediately.
  useEffect(() => {
    if (!open || !plan) return
    const handle = setTimeout(() => runRecipientsSearch(recipientsSearch, recipientsOffset), recipientsSearch ? 300 : 0)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan?.planId, recipientsSearch, recipientsOffset])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setLookup("")
          setResult(null)
          setLookupError(null)
          setRecipientsSearch("")
          setRecipientsOffset(0)
          setRecipientsPage(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-2xl sm:max-w-3xl" data-testid="dialog-campaign-plan">
        <DialogHeader>
          <DialogTitle>What will send — {campaign?.name}</DialogTitle>
          <DialogDescription>
            Read-only view of the campaign's frozen plan: the routes, templates, and variable mappings locked in
            when it was planned, and exactly what any one contact will receive.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading plan...
          </div>
        )}
        {isError && (
          <div
            className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground"
            data-testid="text-no-active-plan"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{messageFrom(error, "This campaign has no active frozen plan yet — plan it first.")}</span>
          </div>
        )}

        {!isLoading && !isError && plan && (
          <ScrollArea className="max-h-[65vh] pr-3">
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-plan-meta">
                <Badge variant="outline">{plan.status}</Badge>
                <span>Plan v{plan.version}</span>
                <span>· frozen {new Date(plan.createdAt).toLocaleString()}</span>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground tracking-wide">Frozen routes</Label>
                <div className="space-y-2">
                  {plan.routes.map((route) => {
                    const template = plan.templates.find((t) => t.id === route.templateId)
                    return (
                      <div
                        key={route.routeId}
                        className="rounded-md border p-3 text-sm space-y-1"
                        data-testid={`row-plan-route-${route.routeId}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-medium">{route.phone ?? `#${route.phoneNumberId}`}</span>
                          <span className="text-xs text-muted-foreground">
                            TPS {route.configuredTps} / cap {route.providerTpsLimit}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {route.displayName ?? "—"} · Template: {template?.name ?? `#${route.templateId}`}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground tracking-wide">Frozen templates &amp; mappings</Label>
                <div className="space-y-3">
                  {plan.templates.map((template) => (
                    <div
                      key={template.id}
                      className="rounded-md border p-3 text-sm space-y-2"
                      data-testid={`row-plan-template-${template.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{template.name}</span>
                        <span className="text-xs text-muted-foreground">{template.language}</span>
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{template.body}</p>
                      {template.headerKind !== "none" && (
                        <Badge variant="outline" className="text-[10px] py-0 h-5">
                          {template.headerKind} header
                          {template.headerKind !== "text" ? " — this preview can't render live media yet" : ""}
                        </Badge>
                      )}
                      <div className="space-y-1">
                        {plan.mappings
                          .filter((m) => m.templateId === template.id)
                          .map((mapping) => (
                            <div
                              key={`${mapping.templateId}-${mapping.component}-${mapping.variable}`}
                              className="text-xs flex items-center justify-between gap-2"
                            >
                              <span>{labelForRequirement(`${mapping.component}:${mapping.variable}`)}</span>
                              <span className="font-mono text-muted-foreground truncate max-w-[55%]" title={mapping.sourceValue}>
                                {mapping.source === "csv" ? `CSV: ${mapping.sourceValue}` : `Fixed: ${mapping.sourceValue}`}
                                {mapping.optional && mapping.fallbackValue ? ` (fallback: ${mapping.fallbackValue})` : ""}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground tracking-wide">Preview one contact</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Contact ID or phone number"
                    value={lookup}
                    onChange={(e) => setLookup(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        runPreview()
                      }
                    }}
                    data-testid="input-preview-contact"
                  />
                  <Button
                    onClick={runPreview}
                    disabled={previewMutation.isPending || !lookup.trim()}
                    data-testid="button-run-preview"
                  >
                    {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
                {lookupError && (
                  <p className="text-xs text-destructive" data-testid="text-preview-error">
                    {lookupError}
                  </p>
                )}
                {result && (
                  <div className="rounded-md border p-3 text-sm space-y-2" data-testid="card-preview-result">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Route: {result.phone ?? `#${result.phoneNumberId}`}</span>
                      <span>Template: {result.templateName}</span>
                    </div>
                    {result.resolutionError ? (
                      <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-destructive text-xs" data-testid="text-preview-resolution-error">
                        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>{result.resolutionError}</span>
                      </div>
                    ) : (
                      <div className="rounded-md bg-muted p-3 space-y-1">
                        {result.renderedHeader && <p className="text-xs font-semibold">{result.renderedHeader}</p>}
                        <p className="text-sm whitespace-pre-wrap" data-testid="text-rendered-body">
                          {result.renderedBody}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs uppercase text-muted-foreground tracking-wide">
                    All recipients {recipientsPage ? `(${recipientsPage.total})` : ""}
                  </Label>
                  {recipientsMutation.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Search by phone or any imported field..."
                    value={recipientsSearch}
                    onChange={(e) => {
                      setRecipientsSearch(e.target.value)
                      setRecipientsOffset(0)
                    }}
                    data-testid="input-recipients-search"
                  />
                </div>
                <div className="space-y-2" data-testid="list-plan-recipients">
                  {recipientsPage?.recipients.length === 0 && (
                    <p className="text-xs text-muted-foreground py-2" data-testid="text-no-recipients">
                      No recipients match this search.
                    </p>
                  )}
                  {recipientsPage?.recipients.map((recipient) => (
                    <div
                      key={recipient.contactId}
                      className="rounded-md border p-3 text-sm space-y-1"
                      data-testid={`row-plan-recipient-${recipient.contactId}`}
                    >
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="font-mono">{recipient.phone ?? recipient.normalizedPhone ?? `#${recipient.contactId}`}</span>
                        <span>{recipient.templateName}</span>
                      </div>
                      {recipient.resolutionError ? (
                        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-destructive text-xs">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>{recipient.resolutionError}</span>
                        </div>
                      ) : (
                        <div className="rounded-md bg-muted p-2 space-y-1">
                          {recipient.renderedHeader && <p className="text-xs font-semibold">{recipient.renderedHeader}</p>}
                          <p className="text-xs whitespace-pre-wrap">{recipient.renderedBody}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {recipientsPage && recipientsPage.total > recipientsPage.limit && (
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-muted-foreground">
                      {recipientsPage.offset + 1}–{Math.min(recipientsPage.offset + recipientsPage.limit, recipientsPage.total)} of {recipientsPage.total}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-7 w-7"
                        disabled={recipientsOffset === 0 || recipientsMutation.isPending}
                        onClick={() => setRecipientsOffset(Math.max(0, recipientsOffset - RECIPIENTS_PAGE_SIZE))}
                        data-testid="button-recipients-prev-page"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-7 w-7"
                        disabled={recipientsOffset + recipientsPage.limit >= recipientsPage.total || recipientsMutation.isPending}
                        onClick={() => setRecipientsOffset(recipientsOffset + RECIPIENTS_PAGE_SIZE)}
                        data-testid="button-recipients-next-page"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-close-campaign-plan">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
