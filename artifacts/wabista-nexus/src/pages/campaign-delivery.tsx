import { useEffect, useState } from "react"
import { Link, useParams } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowLeft, CheckCircle2, Gauge, Loader2, Lock, Shuffle } from "lucide-react"
import {
  getGetCampaignPreflightQueryKey,
  getGetDeliverySetupQueryKey,
  saveDeliverySetup,
  useGetCampaign,
  useGetCampaignPreflight,
  useGetDeliverySetup,
  type Campaign,
  type DeliverySetup,
  type PreflightReport,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ErrorState, PageHeaderSkeleton, StatStripSkeleton, StatusChip, TechnicalDetails } from "@/components/app"
import { CampaignSteps } from "@/components/campaigns/campaign-steps"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { errorCodeOf, errorDetailsOf } from "@/lib/message-studio-model"
import {
  DISTRIBUTION_OPTIONS,
  SPEED_OPTIONS,
  deliveryDraftFrom,
  deliveryPayload,
  distributionSummary,
  estimateSeconds,
  formatDuration,
  plannedTotal,
  rateHint,
  sameDeliveryDraft,
  type DeliveryDraft,
  type DistributionChoice,
  type SpeedChoice,
} from "@/lib/delivery-model"
import { cn } from "@/lib/utils"

// V2-06B Delivery: Step 3 of the campaign builder. Distribution (how
// recipients are shared) and speed (messages per second per number) are
// chosen here and saved with the setup revision they were based on. Every
// rate shown is computed by the server; saving never plans, executes or
// sends. Review & Launch (V2-06C) will be the final step.

export default function CampaignDeliveryPage() {
  const params = useParams<{ campaignId: string }>()
  const campaignId = Number(params.campaignId)
  const { organization } = useActiveOrganization()
  const campaignQuery = useGetCampaign(campaignId)
  if (!Number.isInteger(campaignId) || campaignId < 1) return <MissingCampaign />
  if (campaignQuery.isLoading || !organization) return <div className="space-y-6"><PageHeaderSkeleton /><StatStripSkeleton /></div>
  if (campaignQuery.isError || !campaignQuery.data) {
    if ((campaignQuery.error as { status?: number } | null)?.status === 404) return <MissingCampaign />
    return <div className="space-y-6"><BackLink /><ErrorState title="Couldn't load this campaign." error={campaignQuery.error} onRetry={() => void campaignQuery.refetch()} /></div>
  }
  return <DeliveryWorkspace campaign={campaignQuery.data} organizationId={organization.id} />
}

export function DeliveryWorkspace({ campaign, organizationId }: { campaign: Campaign; organizationId: number }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const setupQuery = useGetDeliverySetup(organizationId, campaign.id)
  const preflightQuery = useGetCampaignPreflight(organizationId, campaign.id)
  const setup = setupQuery.data
  const [draft, setDraft] = useState<DeliveryDraft | null>(null)
  const [baseRevision, setBaseRevision] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedOnce, setSavedOnce] = useState(false)
  const [saveError, setSaveError] = useState<{ message: string; details: string[]; stale: boolean } | null>(null)

  // The draft starts from the server state once; afterwards only a save or
  // an explicit reload replaces it (a newer revision saved elsewhere is
  // refused by the server on save, never silently overwritten).
  useEffect(() => {
    if (setup && draft === null) {
      setDraft(deliveryDraftFrom(setup))
      setBaseRevision(setup.revision)
    }
  }, [setup, draft])

  if (setupQuery.isError) return <div className="space-y-6"><BackLink campaignId={campaign.id} /><ErrorState title="Couldn't load the delivery settings." error={setupQuery.error} onRetry={() => void setupQuery.refetch()} /></div>
  if (setupQuery.isLoading || !setup || !draft) return <div className="space-y-6"><BackLink campaignId={campaign.id} /><StatStripSkeleton /></div>

  const saved = deliveryDraftFrom(setup)
  const dirty = !sameDeliveryDraft(draft, saved)
  const editable = setup.editable
  const messageIncomplete = setup.senders.length === 0 || setup.templateCount === 0
  const advancedHints = draft.deliveryMode === "advanced"
    ? setup.senders.map((sender) => rateHint(draft.rates[String(sender.phoneNumberId)], sender.effectiveCeiling))
    : []
  const canSave = editable && dirty && !saving && !messageIncomplete && draft.distributionMode !== null && draft.deliveryMode !== null && advancedHints.every((hint) => hint === null)
  const total = plannedTotal(draft, setup, dirty)
  const duration = estimateSeconds(setup.recipients, total)

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const next = await saveDeliverySetup(organizationId, campaign.id, deliveryPayload(draft, setup, baseRevision ?? setup.revision))
      queryClient.setQueryData(getGetDeliverySetupQueryKey(organizationId, campaign.id), next)
      setDraft(deliveryDraftFrom(next))
      setBaseRevision(next.revision)
      setSavedOnce(true)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetCampaignPreflightQueryKey(organizationId, campaign.id) }),
        invalidateCampaignQueries(queryClient, organizationId, campaign.id),
      ])
      toast({ title: "Delivery settings saved" })
    } catch (error) {
      setSaveError({ message: messageFrom(error, "Couldn't save the delivery settings."), details: errorDetailsOf(error), stale: errorCodeOf(error) === "stale_revision" })
    } finally {
      setSaving(false)
    }
  }

  const reloadFromServer = async () => {
    setSaveError(null)
    const fresh = await setupQuery.refetch()
    if (fresh.data) {
      setDraft(deliveryDraftFrom(fresh.data))
      setBaseRevision(fresh.data.revision)
    }
    void preflightQuery.refetch()
  }

  return (
    <div className="space-y-6">
      <BackLink campaignId={campaign.id} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <CampaignSteps campaignId={campaign.id} current="delivery" />
          <h1 className="break-words text-2xl font-semibold">{campaign.name}</h1>
          <p className="text-sm text-muted-foreground">Decide how recipients are shared and how fast your numbers send.</p>
        </div>
        <div className="self-start"><StatusChip kind="campaign" value={setup.status as Campaign["status"]} /></div>
      </header>

      {!editable ? (
        <Alert data-testid="banner-delivery-locked">
          <Lock className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Delivery settings are locked.</AlertTitle>
          <AlertDescription>{setup.editBlockedReason}</AlertDescription>
        </Alert>
      ) : setup.status === "Ready" ? (
        <Alert data-testid="banner-delivery-reopen">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>This campaign is planned.</AlertTitle>
          <AlertDescription>Saving a change moves it back to draft and discards its frozen plan.</AlertDescription>
        </Alert>
      ) : null}

      {messageIncomplete ? (
        <Alert variant="destructive" data-testid="banner-message-incomplete">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Choose numbers and templates first.</AlertTitle>
          <AlertDescription>
            Delivery settings apply to the numbers and templates saved in the Message step. <Link href={`/campaigns/${campaign.id}/message`} className="underline">Go to Message</Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Shuffle className="h-4 w-4" aria-hidden="true" /> Distribution</CardTitle>
          <CardDescription>How recipients are shared between your numbers and templates.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={draft.distributionMode ?? ""}
            onValueChange={(value) => setDraft({ ...draft, distributionMode: value as DistributionChoice })}
            disabled={!editable}
            className="grid gap-3 sm:grid-cols-2"
            aria-label="Distribution"
            data-testid="distribution-options"
          >
            {DISTRIBUTION_OPTIONS.map((option) => (
              <ChoiceCard key={option.value} id={`distribution-${option.value}`} value={option.value} title={option.title} description={option.description} selected={draft.distributionMode === option.value} disabled={!editable} />
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4" aria-hidden="true" /> Speed</CardTitle>
          <CardDescription>How many messages per second each number sends. Never above what WhatsApp currently allows for that number.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={draft.deliveryMode ?? ""}
            onValueChange={(value) => setDraft({ ...draft, deliveryMode: value as SpeedChoice })}
            disabled={!editable}
            className="grid gap-3 sm:grid-cols-2"
            aria-label="Speed"
            data-testid="speed-options"
          >
            {SPEED_OPTIONS.map((option) => {
              const summary = setup.modeSummaries.find((entry) => entry.deliveryMode === option.value)
              return (
                <ChoiceCard
                  key={option.value}
                  id={`speed-${option.value}`}
                  value={option.value}
                  title={option.title}
                  description={option.description}
                  detail={summary?.totalMessagesPerSecond ? `${summary.totalMessagesPerSecond} messages/sec in total` : option.value === "advanced" ? "You choose per number" : undefined}
                  selected={draft.deliveryMode === option.value}
                  disabled={!editable}
                />
              )
            })}
          </RadioGroup>

          {draft.deliveryMode === "advanced" ? (
            <div className="space-y-2" data-testid="advanced-rates">
              <p className="text-sm font-medium">Speed per number</p>
              <ul className="divide-y rounded-md border">
                {setup.senders.map((sender, index) => {
                  const key = String(sender.phoneNumberId)
                  const hint = advancedHints[index]
                  return (
                    <li key={sender.phoneNumberId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto_9rem] sm:items-center" data-testid={`advanced-row-${sender.phoneNumberId}`}>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{sender.displayName || sender.phone}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{sender.phone}</p>
                      </div>
                      <p className="text-xs text-muted-foreground sm:text-right">
                        Available speed: {sender.effectiveCeiling === null ? "unknown" : `up to ${sender.effectiveCeiling} messages/sec`}
                      </p>
                      <div className="space-y-1">
                        <Label htmlFor={`rate-${key}`} className="sr-only">Your speed for {sender.displayName || sender.phone}</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`rate-${key}`}
                            inputMode="numeric"
                            value={draft.rates[key] ?? ""}
                            onChange={(event) => setDraft({ ...draft, rates: { ...draft.rates, [key]: event.target.value } })}
                            disabled={!editable}
                            aria-invalid={hint ? true : undefined}
                            className="w-24"
                            data-testid={`input-rate-${sender.phoneNumberId}`}
                          />
                          <span className="text-xs text-muted-foreground">messages/sec</span>
                        </div>
                        {hint ? <p className="text-xs text-destructive" data-testid={`rate-hint-${sender.phoneNumberId}`}>{hint}</p> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <SummaryCard setup={setup} draft={draft} total={total} duration={duration} dirty={dirty} />
      <CheckCard preflight={preflightQuery.data} loading={preflightQuery.isLoading} error={preflightQuery.isError} dirty={dirty} />

      <Card>
        <CardContent className="space-y-3 pt-6">
          {saveError ? (
            <Alert variant="destructive" data-testid="alert-delivery-save-error">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>{saveError.message}</AlertTitle>
              <AlertDescription className="space-y-2">
                {saveError.details.length ? <ul className="list-disc pl-5">{saveError.details.map((detail) => <li key={detail}>{detail}</li>)}</ul> : null}
                {saveError.stale ? <Button size="sm" variant="outline" onClick={() => void reloadFromServer()} data-testid="button-reload-delivery">Load the latest version (discards your unsaved changes)</Button> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" data-testid="text-delivery-save-state">
              {dirty ? "You have unsaved changes." : savedOnce || setup.deliveryMode ? "All changes are saved. Review & Launch will be the final step." : "Choose a distribution and a speed, then save."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="ghost"><Link href={`/campaigns/${campaign.id}/message`}>Back to message</Link></Button>
              <Button onClick={() => void save()} disabled={!canSave} className="gap-2" data-testid="button-save-delivery">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save delivery settings
              </Button>
            </div>
          </div>
          <TechnicalDetails fields={[
            { label: "Campaign ID", value: campaign.id, copyable: true },
            { label: "Setup revision", value: setup.revision },
            { label: "Distribution", value: setup.distributionMode ?? "none" },
            { label: "Speed mode", value: setup.deliveryMode ?? "none" },
            { label: "Platform maximum (TPS)", value: setup.platformMaxMessagesPerSecond },
            ...setup.senders.map((sender) => ({ label: `${sender.phone} provider TPS`, value: `${sender.providerApprovedRate} (planned ${sender.plannedRate ?? "—"})` })),
          ]} />
        </CardContent>
      </Card>
    </div>
  )
}

function ChoiceCard({ id, value, title, description, detail, selected, disabled }: { id: string; value: string; title: string; description: string; detail?: string; selected: boolean; disabled: boolean }) {
  return (
    <Label
      htmlFor={id}
      className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal", selected ? "border-primary bg-primary/5" : "hover:bg-muted/40", disabled && "cursor-not-allowed opacity-70")}
      data-testid={`choice-${value}`}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="min-w-0 space-y-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </Label>
  )
}

function SummaryCard({ setup, draft, total, duration, dirty }: { setup: DeliverySetup; draft: DeliveryDraft; total: number | null; duration: number | null; dirty: boolean }) {
  const rows = [
    { label: "Numbers", value: String(setup.senders.length) },
    { label: "Templates", value: String(setup.templateCount) },
    { label: "Distribution", value: distributionSummary(draft.distributionMode) },
    { label: "Total speed", value: total === null ? "—" : `${total} messages/sec` },
    { label: "Recipients", value: setup.recipients.toLocaleString() },
    { label: "Approximate sending time", value: formatDuration(duration) },
  ]
  return (
    <Card data-testid="delivery-summary">
      <CardHeader>
        <CardTitle className="text-base">Summary</CardTitle>
        <CardDescription>{dirty ? "Based on your unsaved choices." : "Based on the saved settings."} The sending time is a theoretical estimate, not a guarantee.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <div key={row.label} className="min-w-0 rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="break-words text-sm font-medium" data-testid={`summary-${row.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

function CheckCard({ preflight, loading, error, dirty }: { preflight: PreflightReport | undefined; loading: boolean; error: boolean; dirty: boolean }) {
  if (loading) return null
  if (error || !preflight) return <Alert data-testid="delivery-check-unavailable"><AlertTriangle className="h-4 w-4" aria-hidden="true" /><AlertTitle>The configuration check is unavailable right now.</AlertTitle></Alert>
  const count = preflight.blockers.length
  return (
    <Alert variant={count ? "destructive" : "default"} data-testid="delivery-check">
      {count ? <AlertTriangle className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
      <AlertTitle>{count ? `${count} ${count === 1 ? "thing needs" : "things need"} attention` : "Ready for review"}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-xs">{dirty ? "Checked against the saved settings; save to check your changes." : "Checked against the saved settings."}</p>
        {count ? (
          <ul className="space-y-1">
            {preflight.blockers.map((issue, index) => (
              <li key={`${issue.code}-${index}`} data-testid={`check-blocker-${issue.code}`}><span className="font-medium">{issue.message}</span> <span className="text-muted-foreground">{issue.action}</span></li>
            ))}
          </ul>
        ) : null}
        {preflight.warnings.length ? (
          <ul className="space-y-1 text-muted-foreground">
            {preflight.warnings.map((issue, index) => <li key={`${issue.code}-${index}`} data-testid={`check-warning-${issue.code}`}>{issue.message}</li>)}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

function BackLink({ campaignId }: { campaignId?: number }) {
  return (
    <Button asChild variant="ghost" size="sm" className="gap-1 px-2">
      <Link href={campaignId ? `/campaigns/${campaignId}?tab=setup` : "/campaigns"}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> {campaignId ? "Campaign overview" : "Campaigns"}</Link>
    </Button>
  )
}

function MissingCampaign() {
  return (
    <div className="space-y-6">
      <BackLink />
      <ErrorState title="This campaign doesn't exist or isn't in this workspace." />
    </div>
  )
}
