import { useState } from "react"
import { Link, useLocation, useParams } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Eye, Loader2, Rocket, XCircle } from "lucide-react"
import {
  getGetCampaignPreflightQueryKey,
  getGetLaunchProjectionQueryKey,
  previewLaunchRecipient,
  transitionCampaign,
  useGetCampaign,
  useGetCampaignPreflight,
  useGetLaunchProjection,
  type Campaign,
  type LaunchProjection,
  type LaunchRecipientPreview,
  type PreflightIssue,
  type PreflightReport,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ErrorState, PageHeaderSkeleton, StatStripSkeleton, StatusChip, TechnicalDetails } from "@/components/app"
import { CampaignSteps } from "@/components/campaigns/campaign-steps"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { errorCodeOf } from "@/lib/message-studio-model"
import { formatDuration } from "@/lib/delivery-model"
import {
  CHECK_GROUPS,
  approxCount,
  approxPercent,
  blockersIn,
  canLaunch,
  doNotContact,
  launchBody,
  launchOutcomeMessage,
  scheduledInstant,
} from "@/lib/review-model"
import { cn } from "@/lib/utils"

// V2-06C Review & Launch: Step 4. Everything shown is the server's
// structured preflight (live validation) and an approximate projection; the
// exact allocation is frozen by Launch. One Launch action (send now or
// schedule) replaces Plan + Execute; it is enabled only when the server
// reports no blocker, and the server re-checks everything under its lock.

const DISTRIBUTION_LABEL: Record<string, string> = {
  equal_numbers: "Equal by numbers",
  equal_templates: "Equal by templates",
}
const SPEED_LABEL: Record<string, string> = {
  fastest_safe: "Fastest safe",
  balanced: "Balanced",
  conservative: "Conservative",
  advanced: "Advanced",
}

export default function CampaignReviewPage() {
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
  return <ReviewWorkspace campaign={campaignQuery.data} organizationId={organization.id} />
}

export function ReviewWorkspace({ campaign, organizationId }: { campaign: Campaign; organizationId: number }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [, navigate] = useLocation()
  const preflightQuery = useGetCampaignPreflight(organizationId, campaign.id)
  const projectionQuery = useGetLaunchProjection(organizationId, campaign.id)
  const report = preflightQuery.data
  const [intent, setIntent] = useState<"now" | "schedule">("now")
  const [when, setWhen] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<{ message: string; blockers: PreflightIssue[] } | null>(null)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  if (preflightQuery.isError) return <div className="space-y-6"><BackLink campaignId={campaign.id} /><ErrorState title="Couldn't check this campaign." error={preflightQuery.error} onRetry={() => void preflightQuery.refetch()} /></div>
  if (preflightQuery.isLoading || !report) return <div className="space-y-6"><BackLink campaignId={campaign.id} /><StatStripSkeleton /></div>

  const launchable = canLaunch(report)
  const scheduleTime = intent === "schedule" ? scheduledInstant(when) : null
  const scheduleInvalid = intent === "schedule" && !scheduleTime
  const launched = !["Draft", "Ready"].includes(report.status)

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetCampaignPreflightQueryKey(organizationId, campaign.id) }),
    queryClient.invalidateQueries({ queryKey: getGetLaunchProjectionQueryKey(organizationId, campaign.id) }),
    invalidateCampaignQueries(queryClient, organizationId, campaign.id),
  ])

  const launch = async () => {
    setLaunching(true)
    setLaunchError(null)
    try {
      const result = await transitionCampaign(organizationId, campaign.id, launchBody(intent, when, timezone))
      setConfirmOpen(false)
      toast({ title: launchOutcomeMessage(result.launch?.outcome) })
      await refresh()
      navigate(`/campaigns/${campaign.id}`)
    } catch (error) {
      const data = (error as { data?: { blockers?: PreflightIssue[] } } | null)?.data
      setLaunchError({ message: errorCodeOf(error) === "launch_blocked" ? "The campaign is not ready to launch." : messageFrom(error, "Couldn't launch the campaign."), blockers: Array.isArray(data?.blockers) ? data!.blockers : [] })
      setConfirmOpen(false)
      await refresh()
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="space-y-6">
      <BackLink campaignId={campaign.id} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <CampaignSteps campaignId={campaign.id} current="review" />
          <h1 className="break-words text-2xl font-semibold">{campaign.name}</h1>
          <p className="text-sm text-muted-foreground">Check everything once more, then send now or schedule.</p>
        </div>
        <div className="self-start"><StatusChip kind="campaign" value={report.status as Campaign["status"]} /></div>
      </header>

      {launched ? (
        <Alert data-testid="banner-launched">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>This campaign has already been launched.</AlertTitle>
          <AlertDescription>
            It is {report.status.toLowerCase()}. <Link href={`/campaigns/${campaign.id}`} className="underline">Open the campaign</Link> to follow it.
          </AlertDescription>
        </Alert>
      ) : null}

      <SummaryCard report={report} />
      <ChecksCard report={report} />
      <ProjectionCard projection={projectionQuery.data} loading={projectionQuery.isLoading} />
      <RecipientPreviewCard organizationId={organizationId} campaignId={campaign.id} />

      <Card data-testid="launch-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Rocket className="h-4 w-4" aria-hidden="true" /> Launch</CardTitle>
          <CardDescription>Launching freezes this exact setup; the numbers, templates, values and speed you see are what will be sent.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup value={intent} onValueChange={(value) => setIntent(value as "now" | "schedule")} className="grid gap-3 sm:grid-cols-2" aria-label="When to send" disabled={launched}>
            <Label htmlFor="intent-now" className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal", intent === "now" && "border-primary bg-primary/5")} data-testid="choice-now">
              <RadioGroupItem id="intent-now" value="now" className="mt-0.5" />
              <span><span className="block font-medium">Send now</span><span className="block text-sm text-muted-foreground">Start sending as soon as you launch.</span></span>
            </Label>
            <Label htmlFor="intent-schedule" className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal", intent === "schedule" && "border-primary bg-primary/5")} data-testid="choice-schedule">
              <RadioGroupItem id="intent-schedule" value="schedule" className="mt-0.5" />
              <span><span className="block font-medium">Schedule</span><span className="block text-sm text-muted-foreground">Start automatically at a time you choose.</span></span>
            </Label>
          </RadioGroup>
          {intent === "schedule" ? (
            <div className="space-y-1">
              <Label htmlFor="schedule-at">Start at</Label>
              <Input id="schedule-at" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} className="w-full sm:w-64" data-testid="input-schedule-at" />
              <p className="text-xs text-muted-foreground">Your time zone: {timezone}.{when && scheduleInvalid ? " Choose a time in the future." : ""}</p>
            </div>
          ) : null}

          {launchError ? (
            <Alert variant="destructive" data-testid="alert-launch-error">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>{launchError.message}</AlertTitle>
              {launchError.blockers.length ? (
                <AlertDescription><ul className="list-disc pl-5">{launchError.blockers.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message} {issue.action}</li>)}</ul></AlertDescription>
              ) : null}
            </Alert>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" data-testid="text-launch-state">
              {launched ? "Already launched." : launchable ? "Everything checks out." : `${report.blockers.length} ${report.blockers.length === 1 ? "thing needs" : "things need"} attention before you can launch.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="ghost"><Link href={`/campaigns/${campaign.id}/delivery`}>Back to delivery</Link></Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={!launchable || scheduleInvalid || launching} className="gap-2" data-testid="button-launch">
                {intent === "schedule" ? <CalendarClock className="h-4 w-4" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
                {intent === "schedule" ? "Schedule campaign" : "Launch campaign"}
              </Button>
            </div>
          </div>
          <TechnicalDetails fields={[
            { label: "Campaign ID", value: campaign.id, copyable: true },
            { label: "Allocator", value: report.technicalDetails.allocatorVersion },
            { label: "Platform maximum (TPS)", value: report.technicalDetails.platformMaxMessagesPerSecond },
            { label: "Blocker codes", value: report.blockers.map((issue) => issue.code).join(", ") || "none" },
            { label: "Readiness rules", value: report.technicalDetails.readinessErrors.join(" | ") || "all pass" },
          ]} />
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!launching) setConfirmOpen(open) }}>
        <DialogContent data-testid="dialog-launch">
          <DialogHeader>
            <DialogTitle>{intent === "schedule" ? "Schedule this campaign?" : "Launch this campaign now?"}</DialogTitle>
            <DialogDescription>
              {report.recipients.valid.toLocaleString("en-US")} recipients, {report.senders.length} {report.senders.length === 1 ? "number" : "numbers"}, about {report.delivery.totalMessagesPerSecond ?? "—"} messages/sec.
              {intent === "schedule" && scheduleTime ? ` Starts ${scheduleTime.toLocaleString()} (${timezone}).` : " Sending starts immediately."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={launching}>Cancel</Button>
            <Button onClick={() => void launch()} disabled={launching} className="gap-2" data-testid="button-confirm-launch">
              {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {intent === "schedule" ? "Schedule" : "Launch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SummaryCard({ report }: { report: PreflightReport }) {
  const tiles = [
    { label: "Recipients", value: report.recipients.total.toLocaleString("en-US") },
    { label: "Valid", value: report.recipients.valid.toLocaleString("en-US") },
    { label: "Invalid", value: report.recipients.invalid.toLocaleString("en-US") },
    { label: "Duplicate", value: report.recipients.duplicate.toLocaleString("en-US") },
    { label: "Do not contact", value: doNotContact(report.recipients).toLocaleString("en-US") },
    { label: "Sending numbers", value: String(report.senders.length) },
    { label: "Templates", value: String(report.templates.length) },
    { label: "Distribution", value: report.distribution.mode ? DISTRIBUTION_LABEL[report.distribution.mode] ?? report.distribution.mode : "Not chosen" },
    { label: "Planned speed", value: report.delivery.totalMessagesPerSecond === null ? "—" : `${report.delivery.totalMessagesPerSecond} messages/sec${report.delivery.mode ? ` (${SPEED_LABEL[report.delivery.mode] ?? report.delivery.mode})` : ""}` },
    { label: "Approximate duration", value: formatDuration(report.estimate.durationSeconds ?? null) },
  ]
  return (
    <Card data-testid="review-summary">
      <CardHeader>
        <CardTitle className="text-base">Preflight</CardTitle>
        <CardDescription>Live check of the saved setup. The duration is a theoretical estimate, not a guarantee.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {tiles.map((tile) => (
            <div key={tile.label} className="min-w-0 rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{tile.label}</dt>
              <dd className="break-words text-sm font-medium" data-testid={`review-${tile.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{tile.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

function ChecksCard({ report }: { report: PreflightReport }) {
  return (
    <Card data-testid="review-checks">
      <CardHeader>
        <CardTitle className="text-base">Checks</CardTitle>
        <CardDescription>{report.ready ? "Everything needed to launch is in place." : "These need attention before you can launch."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y rounded-md border">
          {CHECK_GROUPS.map((group) => {
            const issues = blockersIn(report.blockers, group.key)
            return (
              <li key={group.key} className="space-y-1 p-3" data-testid={`check-${group.key}`}>
                <div className="flex items-center gap-2">
                  {issues.length ? <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />}
                  <span className="font-medium">{group.title}</span>
                  <span className="text-xs text-muted-foreground">{issues.length ? `${issues.length} to fix` : "OK"}</span>
                </div>
                {issues.length ? (
                  <ul className="space-y-1 pl-6 text-sm">
                    {issues.map((issue, index) => <li key={`${issue.code}-${index}`} data-testid={`blocker-${issue.code}`}><span className="font-medium">{issue.message}</span> <span className="text-muted-foreground">{issue.action}</span></li>)}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
        {report.warnings.length ? (
          <Alert data-testid="review-warnings">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Good to know</AlertTitle>
            <AlertDescription><ul className="space-y-1">{report.warnings.map((issue, index) => <li key={`${issue.code}-${index}`} data-testid={`warning-${issue.code}`}>{issue.message}</li>)}</ul></AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ProjectionCard({ projection, loading }: { projection: LaunchProjection | undefined; loading: boolean }) {
  if (loading) return null
  return (
    <Card data-testid="review-projection">
      <CardHeader>
        <CardTitle className="text-base">What will be sent</CardTitle>
        <CardDescription>Approximate shares (~). The exact split is frozen when you launch.</CardDescription>
      </CardHeader>
      <CardContent>
        {!projection || !projection.available ? (
          <p className="text-sm text-muted-foreground" data-testid="projection-unavailable">{projection?.reason ?? "Not available yet."}</p>
        ) : (
          <div className="space-y-4">
            <ul className="divide-y rounded-md border">
              {projection.senders.map((sender) => (
                <li key={sender.phoneNumberId} className="space-y-2 p-3" data-testid={`projection-sender-${sender.phoneNumberId}`}>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{sender.displayName || sender.phone}</p>
                      <p className="text-xs text-muted-foreground">{sender.plannedRate === null ? "Speed not set" : `${sender.plannedRate} messages/sec`}</p>
                    </div>
                    <p className="text-sm">{approxPercent(sender.approxShare)} · {approxCount(sender.approxRecipients)} recipients</p>
                  </div>
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {sender.templates.map((template) => (
                      <li key={template.templateId} className="rounded-full border px-2 py-0.5">{template.name} {approxCount(template.approxRecipients)}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">By template</p>
              <ul className="flex flex-wrap gap-2 text-sm">
                {projection.templates.map((template) => (
                  <li key={template.templateId} className="rounded-md border px-2 py-1" data-testid={`projection-template-${template.templateId}`}>{template.name}: {approxPercent(template.approxShare)} ({approxCount(template.approxRecipients)})</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RecipientPreviewCard({ organizationId, campaignId }: { organizationId: number; campaignId: number }) {
  const [preview, setPreview] = useState<LaunchRecipientPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [contactId, setContactId] = useState("")
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const id = contactId.trim() ? Number(contactId) : undefined
      setPreview(await previewLaunchRecipient(organizationId, campaignId, id && Number.isInteger(id) ? { contactId: id } : {}))
    } catch (failure) {
      setPreview(null)
      setError(messageFrom(failure, "Couldn't preview a recipient."))
    } finally {
      setLoading(false)
    }
  }
  const body = preview?.message?.resolved.body ?? {}
  return (
    <Card data-testid="review-recipient-preview">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Eye className="h-4 w-4" aria-hidden="true" /> Preview a recipient</CardTitle>
        <CardDescription>See which number and template a recipient would get with the current setup, and the values filled in.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="preview-contact" className="text-xs">Recipient ID (optional)</Label>
            <Input id="preview-contact" inputMode="numeric" value={contactId} onChange={(event) => setContactId(event.target.value)} className="w-40" placeholder="First recipient" />
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading} className="gap-2" data-testid="button-preview-recipient">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Preview
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive" data-testid="preview-error">{error}</p> : null}
        {preview ? (
          preview.willSend && preview.decision ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-3" data-testid="preview-result">
              <div className="min-w-0"><dt className="text-xs text-muted-foreground">Recipient</dt><dd className="break-all font-mono">{preview.normalizedPhone}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-muted-foreground">Sent from</dt><dd className="break-words" data-testid="preview-sender">{preview.decision.sender.displayName || preview.decision.sender.phone}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-muted-foreground">Template</dt><dd className="break-words" data-testid="preview-template">{preview.decision.template.name}</dd></div>
              <div className="min-w-0 sm:col-span-3">
                <dt className="text-xs text-muted-foreground">Values</dt>
                <dd data-testid="preview-values">{Object.keys(body).length ? Object.entries(body).map(([key, value]) => `{{${key}}} = ${value}`).join(" · ") : "No body variables"}{preview.message?.headerMedia ? ` · header file ${preview.message.headerMedia.fileName}` : ""}</dd>
                {preview.message?.unresolved.length ? <p className="text-xs text-destructive">{preview.message.unresolved.length} value(s) missing for this recipient.</p> : null}
              </div>
            </dl>
          ) : <p className="text-sm text-muted-foreground" data-testid="preview-skipped">{preview.reason}</p>
        ) : null}
      </CardContent>
    </Card>
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
