import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, FileUp, Loader2, Lock, Send, Trash2 } from "lucide-react"
import {
  applyMappingPreset,
  createMappingPreset,
  deleteCampaignMedia,
  getDownloadCampaignMediaUrl,
  getGetMessageSetupQueryKey,
  getListMappingPresetsQueryKey,
  previewCampaignMessage,
  saveMessageSetup,
  searchCampaignContacts,
  testSendCampaignMessage,
  useGetCampaign,
  useGetMessageSetup,
  useListMappingPresets,
  type Campaign,
  type CampaignMediaAsset,
  type MessageMapping,
  type MessageRequirement,
  type MessageSetup,
  type MessageTemplate,
  type TestSendResult,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ErrorState, PageHeaderSkeleton, StatStripSkeleton, StatusChip, TechnicalDetails } from "@/components/app"
import { TemplatePreview } from "@/components/templates/template-preview"
import { CampaignSteps } from "@/components/campaigns/campaign-steps"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { reasonLabel } from "@/lib/compatibility"
import {
  draftFrom,
  errorCodeOf,
  errorDetailsOf,
  formatBytes,
  MEDIA_ACCEPT,
  mappingFor,
  sameDraft,
  setMapping,
  shareMapping,
  toggle,
  unmappedCount,
  uploadCampaignMediaFile,
  type DraftSetup,
} from "@/lib/message-studio-model"

// V2-05B Message Studio: Step 2 of the campaign builder. Numbers and
// templates come from the server with the V2-04 decision attached; what the
// current engine can run, mapping validity and every previewed value are
// computed by the server. This page edits a draft and saves it with the
// revision it was based on. It never plans, executes or sends a campaign;
// the only provider action is the explicit, isolated test send.

export default function CampaignMessagePage() {
  const params = useParams<{ campaignId: string }>()
  const campaignId = Number(params.campaignId)
  const { organization } = useActiveOrganization()
  const campaignQuery = useGetCampaign(campaignId)
  if (!Number.isInteger(campaignId) || campaignId < 1) return <MissingCampaign />
  if (campaignQuery.isLoading || !organization) {
    return <div className="space-y-6"><PageHeaderSkeleton /><StatStripSkeleton /></div>
  }
  if (campaignQuery.isError || !campaignQuery.data) {
    if ((campaignQuery.error as { status?: number } | null)?.status === 404) return <MissingCampaign />
    return <div className="space-y-6"><BackLink /><ErrorState title="Couldn't load this campaign." error={campaignQuery.error} onRetry={() => void campaignQuery.refetch()} /></div>
  }
  return <MessageWorkspace campaign={campaignQuery.data} organizationId={organization.id} />
}

export function MessageWorkspace({ campaign, organizationId }: { campaign: Campaign; organizationId: number }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const setupQuery = useGetMessageSetup(organizationId, campaign.id)
  const setup = setupQuery.data
  const [draft, setDraft] = useState<DraftSetup | null>(null)
  const [baseRevision, setBaseRevision] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{ message: string; details: string[]; stale: boolean } | null>(null)

  // The draft starts from the server state once; afterwards only a save, an
  // applied preset or an explicit reload replaces it. A newer revision saved
  // elsewhere is detected by the server on save (stale_revision), never by
  // silently overwriting what the user is editing.
  useEffect(() => {
    if (setup && draft === null) {
      setDraft(draftFrom(setup))
      setBaseRevision(setup.revision)
    }
  }, [setup, draft])

  if (setupQuery.isLoading || !draft || !setup) return <div className="space-y-6"><BackLink /><StatStripSkeleton /></div>
  if (setupQuery.isError) return <div className="space-y-6"><BackLink /><ErrorState title="Couldn't load the message setup." error={setupQuery.error} onRetry={() => void setupQuery.refetch()} /></div>

  const saved = draftFrom(setup)
  const dirty = !sameDraft(draft, saved)
  const editable = setup.editable || setup.reopenRequired
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetMessageSetupQueryKey(organizationId, campaign.id) }),
    invalidateCampaignQueries(queryClient, organizationId, campaign.id),
  ])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const next = await saveMessageSetup(organizationId, campaign.id, {
        revision: baseRevision ?? setup.revision,
        senderPhoneNumberIds: draft.senderIds,
        templateIds: draft.templateIds,
        mappings: draft.mappings,
      })
      queryClient.setQueryData(getGetMessageSetupQueryKey(organizationId, campaign.id), next)
      setDraft(draftFrom(next))
      setBaseRevision(next.revision)
      await invalidateCampaignQueries(queryClient, organizationId, campaign.id)
      toast({ title: "Message setup saved" })
    } catch (error) {
      const stale = errorCodeOf(error) === "stale_revision"
      setSaveError({ message: messageFrom(error, "Couldn't save the message setup."), details: errorDetailsOf(error), stale })
    } finally {
      setSaving(false)
    }
  }

  const reloadFromServer = async () => {
    setSaveError(null)
    const fresh = await setupQuery.refetch()
    if (fresh.data) {
      setDraft(draftFrom(fresh.data))
      setBaseRevision(fresh.data.revision)
    }
  }

  return (
    <div className="space-y-6">
      <BackLink campaignId={campaign.id} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <CampaignSteps campaignId={campaign.id} current="message" />
          <h1 className="break-words text-2xl font-semibold">{campaign.name}</h1>
          <p className="text-sm text-muted-foreground">Choose who sends, which templates, and what goes into every variable.</p>
        </div>
        <div className="self-start"><StatusChip kind="campaign" value={campaign.status} /></div>
      </header>

      {!setup.editable ? (
        <Alert data-testid="banner-message-locked">
          <Lock className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>{setup.reopenRequired ? "This campaign is planned." : "The message setup is locked."}</AlertTitle>
          <AlertDescription>
            {setup.reopenRequired
              ? "Saving a change moves it back to draft and discards its frozen plan; plan it again afterwards."
              : setup.editBlockedReason}
          </AlertDescription>
        </Alert>
      ) : null}

      <SendersCard setup={setup} draft={draft} disabled={!editable} onChange={setDraft} />
      <TemplatesCard setup={setup} draft={draft} disabled={!editable} onChange={setDraft} />
      <ExecutionCard setup={setup} dirty={dirty} />
      <ContentCard setup={setup} draft={draft} disabled={!editable} onChange={setDraft} organizationId={organizationId} campaignId={campaign.id} onMediaChanged={refresh} dirty={dirty} baseRevision={baseRevision ?? setup.revision} onPresetApplied={(next) => { queryClient.setQueryData(getGetMessageSetupQueryKey(organizationId, campaign.id), next); setDraft(draftFrom(next)); setBaseRevision(next.revision) }} />
      <PreviewCard setup={setup} draft={draft} organizationId={organizationId} campaignId={campaign.id} dirty={dirty} />

      <Card>
        <CardContent className="space-y-3 pt-6">
          {saveError ? (
            <Alert variant="destructive" data-testid="alert-save-error">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>{saveError.message}</AlertTitle>
              <AlertDescription className="space-y-2">
                {saveError.details.length ? <ul className="list-disc pl-5">{saveError.details.map((detail) => <li key={detail}>{detail}</li>)}</ul> : null}
                {saveError.stale ? <Button size="sm" variant="outline" onClick={() => void reloadFromServer()} data-testid="button-reload-setup">Load the latest version (discards your unsaved changes)</Button> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" data-testid="text-save-state">
              {dirty ? "You have unsaved changes." : "All changes are saved."} Delivery settings and Review & Launch come in the next step, which is not available yet; nothing is sent from this page except an explicit test message.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="ghost"><Link href={`/campaigns/${campaign.id}/audience`}>Back to audience</Link></Button>
              <Button asChild variant="outline" data-testid="link-campaign-overview"><Link href={`/campaigns/${campaign.id}?tab=setup`}>Campaign overview</Link></Button>
              <Button onClick={() => void save()} disabled={!editable || !dirty || saving} className="gap-2" data-testid="button-save-message-setup">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save message setup
              </Button>
            </div>
          </div>
          <TechnicalDetails fields={[{ label: "Campaign ID", value: campaign.id, copyable: true }, { label: "Setup revision", value: setup.revision }]} />
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function SendersCard({ setup, draft, disabled, onChange }: { setup: MessageSetup; draft: DraftSetup; disabled: boolean; onChange: (d: DraftSetup) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sending numbers</CardTitle>
        <CardDescription>Only numbers that can send right now can be chosen.</CardDescription>
      </CardHeader>
      <CardContent>
        {setup.senders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No numbers in this workspace yet. Connect one in Number Center.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {setup.senders.map((sender) => {
              const checked = draft.senderIds.includes(sender.phoneNumberId)
              const selectable = sender.usable || checked
              const templatesHere = sender.compatibleTemplateIds.length
              return (
                <li key={sender.phoneNumberId} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`sender-${sender.phoneNumberId}`}>
                  <label className="flex min-w-0 items-start gap-3">
                    <Checkbox
                      checked={checked}
                      disabled={disabled || !selectable}
                      onCheckedChange={(value) => onChange({ ...draft, senderIds: toggle(draft.senderIds, sender.phoneNumberId, value === true) })}
                      aria-label={`Send from ${sender.displayName || sender.phone}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{sender.displayName || sender.phone}</span>
                      <span className="block text-xs text-muted-foreground">
                        <span className="font-mono">{sender.phone}</span>{sender.wabaLabel ? ` · ${sender.wabaLabel}` : ""} · up to {sender.tpsLimit} messages/s
                      </span>
                    </span>
                  </label>
                  <span className="text-xs sm:text-right">
                    {sender.usable ? (
                      checked && draft.templateIds.length
                        ? <span className={templatesHere ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}>{templatesHere ? `Can send ${templatesHere} of the saved templates` : "Cannot send any saved template"}</span>
                        : <Badge variant="outline">Ready</Badge>
                    ) : (
                      <span className="text-destructive" data-testid={`sender-reason-${sender.phoneNumberId}`}>{reasonLabel(sender.code)}</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {setup.sendersTruncated ? <p className="mt-2 text-xs text-muted-foreground">Showing the first 200 numbers.</p> : null}
      </CardContent>
    </Card>
  )
}

function TemplatesCard({ setup, draft, disabled, onChange }: { setup: MessageSetup; draft: DraftSetup; disabled: boolean; onChange: (d: DraftSetup) => void }) {
  const savedSenders = setup.selection.senderPhoneNumberIds
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Templates</CardTitle>
        <CardDescription>Templates approved at Meta. Which saved numbers can send each one is shown next to it.</CardDescription>
      </CardHeader>
      <CardContent>
        {setup.templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No approved Meta templates yet. Create or sync templates in Template Center.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {setup.templates.map((template) => {
              const checked = draft.templateIds.includes(template.templateId)
              const selectable = template.usable || checked
              const compatible = template.compatibleSenderIds.length
              return (
                <div key={template.templateId} className={`rounded-md border p-3 ${checked ? "border-primary/60" : ""}`} data-testid={`template-${template.templateId}`}>
                  <label className="flex items-start gap-3">
                    <Checkbox
                      checked={checked}
                      disabled={disabled || !selectable}
                      onCheckedChange={(value) => onChange({ ...draft, templateIds: toggle(draft.templateIds, template.templateId, value === true) })}
                      aria-label={`Use template ${template.name}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{template.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {template.language} · {template.category} · {template.status}{template.wabaLabel ? ` · ${template.wabaLabel}` : ""}{template.headerKind !== "none" && template.headerKind !== "text" ? ` · ${template.headerKind} header` : ""}
                      </span>
                    </span>
                  </label>
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{template.body}</p>
                  <p className="mt-2 text-xs" data-testid={`template-compat-${template.templateId}`}>
                    {!template.usable ? <span className="text-destructive">{template.message}</span>
                      : savedSenders.length === 0 ? <span className="text-muted-foreground">Save numbers to see which can send it.</span>
                        : compatible === savedSenders.length ? <span className="text-muted-foreground">All {compatible} saved numbers can send it.</span>
                          : compatible === 0 ? <span className="text-destructive">None of the saved numbers can send it.</span>
                            : <span className="text-amber-700 dark:text-amber-400">Only {compatible} of {savedSenders.length} saved numbers can send it.</span>}
                  </p>
                </div>
              )
            })}
          </div>
        )}
        {setup.templatesTruncated ? <p className="mt-2 text-xs text-muted-foreground">Showing the first 200 templates.</p> : null}
      </CardContent>
    </Card>
  )
}

function ExecutionCard({ setup, dirty }: { setup: MessageSetup; dirty: boolean }) {
  const { execution } = setup
  const label = (templateId: number) => setup.templates.find((t) => t.templateId === templateId)?.name ?? "template"
  const sender = (phoneNumberId: number) => setup.senders.find((s) => s.phoneNumberId === phoneNumberId)
  return (
    <Alert variant={execution.executable ? "default" : "destructive"} data-testid="execution-summary">
      {execution.executable ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
      <AlertTitle>{execution.executable ? "Ready to plan with this selection" : "This selection cannot be planned yet"}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{execution.message}{dirty ? " (as last saved)" : ""}</p>
        {execution.executable ? (
          <ul className="space-y-0.5 text-xs">
            {execution.assignments.map((a) => (
              <li key={`${a.phoneNumberId}:${a.templateId}`}>{sender(a.phoneNumberId)?.displayName || sender(a.phoneNumberId)?.phone} sends <span className="font-medium">{label(a.templateId)}</span></li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

/* ------------------------------------------------------------------ */

function ContentCard({ setup, draft, disabled, onChange, organizationId, campaignId, onMediaChanged, dirty, baseRevision, onPresetApplied }: {
  setup: MessageSetup; draft: DraftSetup; disabled: boolean; onChange: (d: DraftSetup) => void; organizationId: number; campaignId: number;
  onMediaChanged: () => Promise<unknown>; dirty: boolean; baseRevision: number; onPresetApplied: (next: MessageSetup) => void
}) {
  const selectedTemplates = setup.templates.filter((t) => draft.templateIds.includes(t.templateId))
  const { toast } = useToast()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Content</CardTitle>
        <CardDescription>Fill every variable of every selected template from a column of your audience or with fixed text. Each template keeps its own values.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MediaLibrary assets={setup.mediaAssets} disabled={disabled} organizationId={organizationId} campaignId={campaignId} onChanged={onMediaChanged} />
        <PresetsBar setup={setup} draft={draft} disabled={disabled} dirty={dirty} organizationId={organizationId} campaignId={campaignId} baseRevision={baseRevision} onApplied={onPresetApplied} />
        {selectedTemplates.length === 0 ? <p className="text-sm text-muted-foreground">Select a template to fill in its variables.</p> : null}
        {selectedTemplates.map((template) => (
          <TemplateMappings key={template.templateId} template={template} setup={setup} draft={draft} disabled={disabled} onChange={onChange}
            onShare={(requirement) => {
              const { draft: next, applied } = shareMapping(draft, setup.templates, template.templateId, requirement)
              onChange(next)
              toast({ title: applied ? `Copied to ${applied} other template${applied === 1 ? "" : "s"}` : "No other template has an empty slot like this one" })
            }} />
        ))}
      </CardContent>
    </Card>
  )
}

function TemplateMappings({ template, setup, draft, disabled, onChange, onShare }: { template: MessageTemplate; setup: MessageSetup; draft: DraftSetup; disabled: boolean; onChange: (d: DraftSetup) => void; onShare: (r: MessageRequirement) => void }) {
  const missing = unmappedCount(draft, template)
  const others = draft.templateIds.length > 1
  return (
    <section className="rounded-md border" data-testid={`mappings-${template.templateId}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <span className="font-medium">{template.name}</span>
        <span className={`text-xs ${missing ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`} data-testid={`unmapped-${template.templateId}`}>
          {template.requirements.length === 0 ? "No variables" : missing ? `${missing} of ${template.requirements.length} still empty` : "All variables filled"}
        </span>
      </header>
      <div className="space-y-3 p-3">
        {template.requirements.map((requirement) => {
          const mapping = mappingFor(draft, template.templateId, requirement)
          const set = (next: Omit<MessageMapping, "templateId" | "component" | "variable"> | null) => onChange(setMapping(draft, template.templateId, requirement, next))
          return (
            <div key={requirement.key} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-start" data-testid={`slot-${template.templateId}-${requirement.key}`}>
              <Label className="pt-2 text-sm">{requirement.label}</Label>
              {requirement.mediaKind ? (
                <MediaSlot requirement={requirement} mapping={mapping} assets={setup.mediaAssets} disabled={disabled} onSet={set} />
              ) : (
                <ValueSlot mapping={mapping} columns={setup.audienceColumns} disabled={disabled} onSet={set} testId={`${template.templateId}-${requirement.key}`} />
              )}
              {others ? (
                <Button type="button" size="sm" variant="ghost" className="gap-1 justify-self-start" disabled={disabled || !mapping} onClick={() => onShare(requirement)} title="Copy to other selected templates that have this slot empty" data-testid={`share-${template.templateId}-${requirement.key}`}>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Use for others
                </Button>
              ) : <span />}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ValueSlot({ mapping, columns, disabled, onSet, testId }: { mapping?: MessageMapping; columns: MessageSetup["audienceColumns"]; disabled: boolean; onSet: (next: Omit<MessageMapping, "templateId" | "component" | "variable"> | null) => void; testId: string }) {
  const source = mapping?.source === "static" ? "static" : "csv"
  const partial = mapping?.source === "csv" && columns.find((c) => c.name === mapping.sourceValue)?.availability === "some"
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={source} disabled={disabled} onValueChange={(value) => onSet({ source: value as "csv" | "static", sourceValue: "", optional: false, fallbackValue: null })}>
          <SelectTrigger className="sm:w-40" aria-label="Value source" data-testid={`source-${testId}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="csv">Audience column</SelectItem>
            <SelectItem value="static">Fixed text</SelectItem>
          </SelectContent>
        </Select>
        {source === "csv" ? (
          <Select value={mapping?.sourceValue || undefined} disabled={disabled || columns.length === 0} onValueChange={(value) => onSet({ source: "csv", sourceValue: value, optional: mapping?.optional ?? false, fallbackValue: mapping?.fallbackValue ?? null })}>
            <SelectTrigger className="min-w-0 flex-1" aria-label="Audience column" data-testid={`column-${testId}`}><SelectValue placeholder={columns.length ? "Choose a column" : "Upload an audience first"} /></SelectTrigger>
            <SelectContent>
              {columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}{column.availability === "some" ? " (only some uploads)" : ""}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <Input className="min-w-0 flex-1" value={mapping?.source === "static" ? mapping.sourceValue : ""} disabled={disabled} placeholder="Text every recipient gets" maxLength={1024}
            onChange={(event) => onSet(event.target.value ? { source: "static", sourceValue: event.target.value, optional: false, fallbackValue: null } : null)} data-testid={`static-${testId}`} />
        )}
      </div>
      {source === "csv" && mapping?.sourceValue ? (
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={mapping.optional ?? false} disabled={disabled} onCheckedChange={(value) => onSet({ ...mapping, optional: value === true, fallbackValue: value === true ? mapping.fallbackValue ?? "" : null })} />
          If a recipient has no value, use
          <Input className="h-7 w-40" value={mapping.fallbackValue ?? ""} disabled={disabled || !mapping.optional} onChange={(event) => onSet({ ...mapping, fallbackValue: event.target.value })} aria-label="Fallback text" />
        </label>
      ) : null}
      {partial ? <p className="text-xs text-amber-700 dark:text-amber-400">Only some of your uploads have this column. Add a fallback or recipients without it cannot be sent to.</p> : null}
    </div>
  )
}

function MediaSlot({ requirement, mapping, assets, disabled, onSet }: { requirement: MessageRequirement; mapping?: MessageMapping; assets: CampaignMediaAsset[]; disabled: boolean; onSet: (next: Omit<MessageMapping, "templateId" | "component" | "variable"> | null) => void }) {
  const matching = assets.filter((asset) => asset.kind === requirement.mediaKind)
  const current = mapping?.source === "media_asset" ? String(mapping.mediaAssetId ?? mapping.sourceValue) : undefined
  return (
    <div className="space-y-1">
      <Select value={current} disabled={disabled || matching.length === 0} onValueChange={(value) => onSet({ source: "media_asset", sourceValue: value, mediaAssetId: Number(value), optional: false, fallbackValue: null })}>
        <SelectTrigger aria-label={`${requirement.mediaKind} file`} data-testid={`media-select-${requirement.key}`}><SelectValue placeholder={matching.length ? `Choose a ${requirement.mediaKind}` : `Upload a ${requirement.mediaKind} below`} /></SelectTrigger>
        <SelectContent>
          {matching.map((asset) => <SelectItem key={asset.id} value={String(asset.id)}>{asset.fileName}</SelectItem>)}
        </SelectContent>
      </Select>
      {mapping && mapping.source !== "media_asset" ? <p className="text-xs text-muted-foreground">Currently a link set before Message Studio ({mapping.sourceValue}). Choose a file to replace it.</p> : null}
    </div>
  )
}

function MediaLibrary({ assets, disabled, organizationId, campaignId, onChanged }: { assets: CampaignMediaAsset[]; disabled: boolean; organizationId: number; campaignId: number; onChanged: () => Promise<unknown> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const upload = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await uploadCampaignMediaFile(organizationId, campaignId, file)
      await onChanged()
      toast({ title: `${file.name} uploaded` })
    } catch (failure) {
      setError(messageFrom(failure, "The upload didn't finish."))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (asset: CampaignMediaAsset) => {
    try {
      await deleteCampaignMedia(organizationId, campaignId, asset.id)
      await onChanged()
    } catch (failure) {
      toast({ title: messageFrom(failure, "Couldn't delete the file"), variant: "destructive" })
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3" data-testid="media-library">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Header files</p>
          <p className="text-xs text-muted-foreground">Upload a file once and use it in every template with a matching header (JPEG/PNG up to 5 MB, MP4/3GPP up to 16 MB, PDF up to 100 MB).</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="gap-2" disabled={disabled || busy} onClick={() => inputRef.current?.click()} data-testid="button-upload-media">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" aria-hidden="true" />} Upload file
        </Button>
        <input ref={inputRef} type="file" className="sr-only" accept={Object.values(MEDIA_ACCEPT).join(",")} tabIndex={-1} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = "" }} data-testid="input-upload-media" />
      </div>
      {error ? <p className="text-xs text-destructive" data-testid="media-upload-error">{error}</p> : null}
      {assets.length ? (
        <ul className="divide-y text-sm">
          {assets.map((asset) => (
            <li key={asset.id} className="flex items-center justify-between gap-2 py-1.5" data-testid={`media-asset-${asset.id}`}>
              <span className="min-w-0 truncate">{asset.fileName} <span className="text-xs text-muted-foreground">· {asset.kind} · {formatBytes(asset.byteLength)}</span></span>
              <Button type="button" size="icon" variant="ghost" aria-label={`Delete ${asset.fileName}`} disabled={disabled} onClick={() => void remove(asset)}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No files yet.</p>}
    </div>
  )
}

function PresetsBar({ setup, draft, disabled, dirty, organizationId, campaignId, baseRevision, onApplied }: { setup: MessageSetup; draft: DraftSetup; disabled: boolean; dirty: boolean; organizationId: number; campaignId: number; baseRevision: number; onApplied: (next: MessageSetup) => void }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const presets = useListMappingPresets(organizationId)
  const [presetId, setPresetId] = useState<string>("")
  const [name, setName] = useState("")
  const [savingPreset, setSavingPreset] = useState(false)
  const firstTemplate = setup.templates.find((t) => draft.templateIds.includes(t.templateId))
  const apply = async () => {
    try {
      onApplied(await applyMappingPreset(organizationId, campaignId, { revision: baseRevision, presetId: Number(presetId) }))
      toast({ title: "Preset applied to empty slots and saved" })
    } catch (failure) {
      toast({ title: messageFrom(failure, "Couldn't apply the preset"), variant: "destructive" })
    }
  }
  const saveAsPreset = async () => {
    if (!firstTemplate || !name.trim()) return
    setSavingPreset(true)
    try {
      const entries = draft.mappings
        .filter((m) => m.templateId === firstTemplate.templateId && (m.source === "csv" || m.source === "static") && m.sourceValue.trim())
        .map((m) => ({ component: m.component, variable: m.variable, source: m.source as "csv" | "static", sourceValue: m.sourceValue, optional: m.optional ?? false, fallbackValue: m.optional ? m.fallbackValue ?? null : null }))
      await createMappingPreset(organizationId, { name: name.trim(), entries })
      await queryClient.invalidateQueries({ queryKey: getListMappingPresetsQueryKey(organizationId) })
      setName("")
      toast({ title: "Preset saved for this workspace" })
    } catch (failure) {
      toast({ title: messageFrom(failure, "Couldn't save the preset"), variant: "destructive" })
    } finally {
      setSavingPreset(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 lg:flex-row lg:items-end" data-testid="presets-bar">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label className="text-xs">Mapping preset</Label>
        <div className="flex gap-2">
          <Select value={presetId || undefined} onValueChange={setPresetId} disabled={disabled || !(presets.data ?? []).length}>
            <SelectTrigger className="min-w-0 flex-1" data-testid="select-preset"><SelectValue placeholder={(presets.data ?? []).length ? "Choose a preset" : "No presets yet"} /></SelectTrigger>
            <SelectContent>{(presets.data ?? []).map((preset) => <SelectItem key={preset.id} value={String(preset.id)}>{preset.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={disabled || dirty || !presetId} onClick={() => void apply()} title={dirty ? "Save your changes first" : "Fill empty slots of the selected templates"} data-testid="button-apply-preset">Apply</Button>
        </div>
        {dirty && presetId ? <p className="text-xs text-muted-foreground">Save your changes before applying a preset.</p> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label className="text-xs" htmlFor="preset-name">Save {firstTemplate ? `${firstTemplate.name}'s` : "the first template's"} values as a preset</Label>
        <div className="flex gap-2">
          <Input id="preset-name" className="min-w-0 flex-1" placeholder="Preset name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} disabled={disabled || !firstTemplate} />
          <Button size="sm" variant="outline" disabled={disabled || !firstTemplate || !name.trim() || savingPreset} onClick={() => void saveAsPreset()} data-testid="button-save-preset">Save</Button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function PreviewCard({ setup, draft, organizationId, campaignId, dirty }: { setup: MessageSetup; draft: DraftSetup; organizationId: number; campaignId: number; dirty: boolean }) {
  const selected = setup.templates.filter((t) => draft.templateIds.includes(t.templateId))
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [contactId, setContactId] = useState<number | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const activeTemplate = selected.find((t) => t.templateId === templateId) ?? selected[0]
  const contacts = useQuery({
    queryKey: ["message-studio-contacts", organizationId, campaignId, setup.audienceGeneration],
    queryFn: () => searchCampaignContacts(organizationId, campaignId, { limit: 25 }),
    staleTime: 30_000,
  })
  const readyContacts = (contacts.data?.items ?? []).filter((c) => c.status === "Valid")
  const activeContactId = contactId ?? readyContacts[0]?.id
  const templateMappings = activeTemplate ? draft.mappings.filter((m) => m.templateId === activeTemplate.templateId) : []
  const [debounced, setDebounced] = useState(templateMappings)
  const mappingKey = JSON.stringify(templateMappings)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(JSON.parse(mappingKey)), 350)
    return () => clearTimeout(timer)
  }, [mappingKey])
  const preview = useQuery({
    queryKey: ["message-studio-preview", organizationId, campaignId, activeTemplate?.templateId, activeContactId, JSON.stringify(debounced)],
    queryFn: () => previewCampaignMessage(organizationId, campaignId, { templateId: activeTemplate!.templateId, ...(activeContactId ? { contactId: activeContactId } : {}), mappings: debounced }),
    enabled: Boolean(activeTemplate),
    placeholderData: (previous) => previous,
  })
  const asset = preview.data?.headerMedia ? setup.mediaAssets.find((a) => a.id === preview.data!.headerMedia!.mediaAssetId) : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Preview</CardTitle>
        <CardDescription>Exactly what a recipient receives, worked out by the same rules that prepare real sends.</CardDescription>
      </CardHeader>
      <CardContent>
        {!activeTemplate ? <p className="text-sm text-muted-foreground">Select a template to preview it.</p> : (
          <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Template</Label>
                <Select value={String(activeTemplate.templateId)} onValueChange={(value) => setTemplateId(Number(value))}>
                  <SelectTrigger data-testid="preview-template"><SelectValue /></SelectTrigger>
                  <SelectContent>{selected.map((t) => <SelectItem key={t.templateId} value={String(t.templateId)}>{t.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Recipient</Label>
                <Select value={activeContactId ? String(activeContactId) : undefined} onValueChange={(value) => setContactId(Number(value))} disabled={!readyContacts.length}>
                  <SelectTrigger data-testid="preview-contact"><SelectValue placeholder="No audience yet" /></SelectTrigger>
                  <SelectContent>{readyContacts.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.normalizedPhone} (row {c.rowNumber})</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button variant="outline" className="w-full gap-2" onClick={() => setTestOpen(true)} disabled={dirty || !setup.selection.templateIds.includes(activeTemplate.templateId)} data-testid="button-open-test-send">
                <Send className="h-4 w-4" aria-hidden="true" /> Send a test message
              </Button>
              {dirty ? <p className="text-xs text-muted-foreground">Save your changes to send a test of them.</p> : null}
            </div>
            <div className="min-w-0" data-testid="message-preview">
              {preview.isError ? <p className="text-sm text-destructive">{messageFrom(preview.error, "Couldn't build the preview.")}</p> : (
                <TemplatePreview
                  components={activeTemplate.components}
                  bodyFallback={activeTemplate.body}
                  resolved={preview.data ? {
                    values: preview.data.resolved,
                    unresolved: preview.data.unresolved.map((u) => u.key),
                    headerMedia: preview.data.headerMedia ? { label: preview.data.headerMedia.fileName, src: asset && asset.kind === "image" ? getDownloadCampaignMediaUrl(organizationId, campaignId, asset.id) : undefined } : null,
                  } : undefined}
                  data-testid="studio-preview"
                />
              )}
              {preview.data?.unresolved.length ? (
                <ul className="mt-2 space-y-0.5 text-xs text-destructive" data-testid="preview-unresolved">
                  {preview.data.unresolved.map((issue) => (
                    <li key={issue.key}>{activeTemplate.requirements.find((r) => r.key === issue.key)?.label ?? issue.key}: {issue.reason === "unmapped" ? "not filled in" : issue.reason === "empty_value" ? "this recipient has no value" : "the file is not available"}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
      {activeTemplate ? (
        <TestSendDialog open={testOpen} onOpenChange={setTestOpen} setup={setup} template={activeTemplate} contactId={activeContactId} organizationId={organizationId} campaignId={campaignId} />
      ) : null}
    </Card>
  )
}

function TestSendDialog({ open, onOpenChange, setup, template, contactId, organizationId, campaignId }: { open: boolean; onOpenChange: (open: boolean) => void; setup: MessageSetup; template: MessageTemplate; contactId?: number; organizationId: number; campaignId: number }) {
  const senders = setup.senders.filter((s) => setup.selection.senderPhoneNumberIds.includes(s.phoneNumberId) && template.compatibleSenderIds.includes(s.phoneNumberId))
  const [senderId, setSenderId] = useState<string>("")
  const [mode, setMode] = useState<"contact" | "phone">("contact")
  const [phone, setPhone] = useState("")
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<TestSendResult | { result: "refused"; message: string; details: string[] } | null>(null)
  useEffect(() => { if (open) { setOutcome(null); setSenderId(senders[0] ? String(senders[0].phoneNumberId) : "") } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    setSending(true)
    setOutcome(null)
    try {
      setOutcome(await testSendCampaignMessage(organizationId, campaignId, {
        phoneNumberId: Number(senderId), templateId: template.templateId,
        ...(mode === "phone" ? { recipientPhone: phone.trim(), ...(contactId ? { contactId } : {}) } : { contactId }),
      }))
    } catch (error) {
      setOutcome({ result: "refused", message: messageFrom(error, "The test message was not sent."), details: errorDetailsOf(error) })
    } finally {
      setSending(false)
    }
  }
  const ready = Boolean(senderId) && (mode === "contact" ? Boolean(contactId) : /^\+\d{8,15}$/.test(phone.trim()))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-test-send">
        <DialogHeader>
          <DialogTitle>Send a test of {template.name}</DialogTitle>
          <DialogDescription>One real WhatsApp message with the saved values. It is not part of the campaign: nothing is queued and no campaign numbers change.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Select value={senderId || undefined} onValueChange={setSenderId} disabled={!senders.length}>
              <SelectTrigger data-testid="test-send-sender"><SelectValue placeholder="No saved number can send this template" /></SelectTrigger>
              <SelectContent>{senders.map((s) => <SelectItem key={s.phoneNumberId} value={String(s.phoneNumberId)}>{s.displayName || s.phone} ({s.phone})</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "contact" | "phone")}>
              <SelectTrigger data-testid="test-send-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="contact">The previewed recipient</SelectItem>
                <SelectItem value="phone">Another number (values from the previewed recipient)</SelectItem>
              </SelectContent>
            </Select>
            {mode === "phone" ? <Input placeholder="+447700900123" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} data-testid="test-send-phone" /> : null}
          </div>
          {outcome ? (
            <Alert variant={outcome.result === "sent" ? "default" : "destructive"} data-testid="test-send-outcome">
              {outcome.result === "sent" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              <AlertTitle>{outcome.result === "sent" ? "Sent" : outcome.result === "unknown" ? "Outcome unknown" : "Not sent"}</AlertTitle>
              <AlertDescription>
                {outcome.message}
                {"details" in outcome && outcome.details.length ? <ul className="mt-1 list-disc pl-5">{outcome.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={() => void send()} disabled={!ready || sending} className="gap-2" data-testid="button-confirm-test-send">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BackLink({ campaignId }: { campaignId?: number }) {
  return (
    <Link href={campaignId ? `/campaigns/${campaignId}/audience` : "/campaigns"} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {campaignId ? "Audience" : "Campaigns"}
    </Link>
  )
}

function MissingCampaign() {
  return (
    <div className="space-y-6">
      <BackLink />
      <ErrorState title="Campaign not found." description="It may have been deleted, or it belongs to another workspace." />
    </div>
  )
}

