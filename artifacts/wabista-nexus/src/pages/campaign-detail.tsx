import { useState } from "react"
import { Link, useLocation, useParams, useSearch } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  PlayCircle,
  Rocket,
  Trash2,
  XCircle,
} from "lucide-react"
import {
  useDeleteCampaign,
  useGetCampaign,
  useListCampaignRoutes,
  type Campaign,
  type CampaignActionInputAction,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState, ErrorState, PageHeader, PageHeaderSkeleton, StatStripSkeleton, StatusChip, TechnicalDetails } from "@/components/app"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { useCampaignLifecycle } from "@/hooks/use-campaign-lifecycle"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { formatNumber } from "@/lib/utils"
import {
  canCancelCampaign,
  canExecuteCampaign,
  canPauseCampaign,
  canPlanCampaign,
  canResumeCampaign,
} from "@/lib/campaign-status"
import { CampaignNotReadyDialog } from "@/components/campaigns/campaign-not-ready-dialog"
import { CampaignReadinessChecklist } from "@/components/campaigns/campaign-readiness-checklist"
import { monitoringHasActivity, useCampaignMonitoring } from "@/components/campaigns/campaign-monitoring-panel"
import { CampaignMessagesPanel } from "@/components/campaigns/campaign-messages-panel"
import { CampaignPlanPanel } from "@/components/campaigns/campaign-plan-panel"
import { TemplateMappingDialog } from "@/components/campaigns/template-mapping-dialog"
import { ContactImportDialog } from "@/components/campaigns/contact-import-dialog"
import { CampaignEditDialog } from "@/components/campaigns/campaign-edit-dialog"

const TABS = ["overview", "messages", "setup", "details"] as const
type Tab = (typeof TABS)[number]

// Dedicated campaign page. Every section reuses an existing real endpoint:
// monitoring (polled while Running), messages search/export, template
// mappings, readiness, routes and the frozen plan. Lifecycle buttons call
// the same actions endpoint with the same guards as before; nothing here
// bypasses planning or execution checks.
export default function CampaignDetail() {
  const params = useParams<{ campaignId: string }>()
  const campaignId = Number(params.campaignId)
  const [, navigate] = useLocation()
  const searchString = useSearch()
  const initialTab = new URLSearchParams(searchString).get("tab")
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : "overview")

  const { organization } = useActiveOrganization()
  const organizationId = organization?.id
  const campaignQuery = useGetCampaign(campaignId)
  const campaign = campaignQuery.data

  if (!Number.isInteger(campaignId) || campaignId < 1) {
    return <NotFoundCampaign />
  }

  if (campaignQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatStripSkeleton />
      </div>
    )
  }

  if (campaignQuery.isError || !campaign) {
    const status = (campaignQuery.error as { status?: number } | null)?.status
    if (status === 404) return <NotFoundCampaign />
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorState title="Couldn't load this campaign." error={campaignQuery.error} onRetry={() => void campaignQuery.refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <BackLink />
      <CampaignHeader campaign={campaign} organizationId={organizationId} onDeleted={() => navigate("/campaigns")} />

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="overview" data-testid="tab-campaign-overview">Overview</TabsTrigger>
            <TabsTrigger value="messages" data-testid="tab-campaign-messages">Messages</TabsTrigger>
            <TabsTrigger value="setup" data-testid="tab-campaign-setup">Setup</TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-campaign-details">Details</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab campaign={campaign} organizationId={organizationId} />
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delivery log</CardTitle>
              <CardDescription>Per-recipient send status, retry attempts and provider errors, straight from the send queue.</CardDescription>
            </CardHeader>
            <CardContent>
              <CampaignMessagesPanel organizationId={organizationId} campaignId={campaign.id} active={tab === "messages"} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="setup" className="mt-4">
          <SetupTab campaign={campaign} organizationId={organizationId} />
        </TabsContent>
        <TabsContent value="details" className="mt-4">
          <DetailsTab campaign={campaign} organizationId={organizationId} active={tab === "details"} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function BackLink() {
  return (
    <Link href="/campaigns" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-to-campaigns">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Campaigns
    </Link>
  )
}

function NotFoundCampaign() {
  return (
    <div className="space-y-6">
      <BackLink />
      <EmptyState
        size="page"
        title="Campaign not found."
        description="It may have been deleted, or it belongs to another workspace."
        primaryAction={
          <Button asChild>
            <Link href="/campaigns">Back to campaigns</Link>
          </Button>
        }
        data-testid="empty-campaign-not-found"
      />
    </div>
  )
}

function CampaignHeader({ campaign, organizationId, onDeleted }: { campaign: Campaign; organizationId: number | undefined; onDeleted: () => void }) {
  const { handleAction, isPending, isActioningAs, notReady, setNotReady } = useCampaignLifecycle(organizationId)
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const deleteCampaign = useDeleteCampaign()
  const [cancelling, setCancelling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)

  const act = (action: CampaignActionInputAction) => handleAction(campaign, action)
  const spinner = (action: CampaignActionInputAction) =>
    isActioningAs(campaign.id, action) ? <Loader2 className="h-4 w-4 animate-spin" /> : null

  // Exactly one primary control per state, using the existing guards and
  // the existing action names. Plan stays Plan: Execute still requires a
  // planned (Ready) campaign, and the backend enforces it either way.
  let primary: React.ReactNode = null
  if (canPauseCampaign(campaign.status)) {
    primary = (
      <Button variant="outline" className="gap-2" disabled={isPending} onClick={() => act("pause")} data-testid="button-pause-campaign">
        {spinner("pause") ?? <PauseCircle className="h-4 w-4" />} Pause
      </Button>
    )
  } else if (canResumeCampaign(campaign.status)) {
    primary = (
      <Button className="gap-2" disabled={isPending} onClick={() => act("resume")} data-testid="button-resume-campaign">
        {spinner("resume") ?? <PlayCircle className="h-4 w-4" />} Resume
      </Button>
    )
  } else if (canExecuteCampaign(campaign.status)) {
    primary = (
      <Button className="gap-2" disabled={isPending} onClick={() => act("execute")} data-testid="button-execute-campaign">
        {spinner("execute") ?? <PlayCircle className="h-4 w-4" />} Execute
      </Button>
    )
  } else if (canPlanCampaign(campaign.status)) {
    primary = (
      <Button className="gap-2" disabled={isPending} onClick={() => act("plan")} data-testid="button-plan-campaign">
        {spinner("plan") ?? <Rocket className="h-4 w-4" />} Plan
      </Button>
    )
  }

  const summary = [
    `${formatNumber(campaign.audienceSize)} recipients`,
    `${campaign.routesCount} sender${campaign.routesCount === 1 ? "" : "s"}`,
    campaign.schedule && campaign.schedule !== "Unscheduled" ? campaign.schedule : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <PageHeader
        title={campaign.name}
        status={<StatusChip kind="campaign" value={campaign.status} data-testid="chip-campaign-status" />}
        description={summary}
        primaryAction={primary ?? undefined}
        secondaryActions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions" data-testid="button-campaign-more">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canPlanCampaign(campaign.status) && campaign.status === "Ready" && (
                <DropdownMenuItem disabled={isPending} onClick={() => act("plan")} data-testid="button-replan-campaign">
                  <Rocket className="mr-2 h-4 w-4" /> Re-plan
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setEditing(true)} data-testid="button-edit-campaign">
                <Pencil className="mr-2 h-4 w-4" /> Rename or reschedule
              </DropdownMenuItem>
              {canCancelCampaign(campaign.status) && (
                <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={isPending} onClick={() => setCancelling(true)} data-testid="button-cancel-campaign">
                  <XCircle className="mr-2 h-4 w-4" /> Stop campaign
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleting(true)} data-testid="button-delete-campaign">
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <CampaignNotReadyDialog notReady={notReady} onClose={() => setNotReady(null)} />

      <CampaignEditDialog campaign={editing ? campaign : null} open={editing} onOpenChange={setEditing} organizationId={organizationId} />

      <AlertDialog open={cancelling} onOpenChange={setCancelling}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {campaign.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the campaign for good: waiting sends are cancelled and it cannot be resumed. Use Pause if you want to continue later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep campaign</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                act("cancel")
                setCancelling(false)
              }}
              data-testid="button-confirm-cancel-campaign"
            >
              Stop campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {campaign.name}, its senders, imported recipients and delivery log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteCampaign.isPending}
              onClick={() =>
                deleteCampaign.mutate(
                  { campaignId: campaign.id },
                  {
                    onSuccess: () => {
                      void invalidateCampaignQueries(queryClient, organizationId, campaign.id)
                      toast({ title: "Campaign deleted" })
                      onDeleted()
                    },
                    onError: (error) => toast({ title: messageFrom(error, "Failed to delete campaign"), variant: "destructive" }),
                  },
                )
              }
              data-testid="button-confirm-delete-campaign"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function OverviewTab({ campaign, organizationId }: { campaign: Campaign; organizationId: number | undefined }) {
  const isRunning = campaign.status === "Running"
  const preLaunch = campaign.status === "Draft" || campaign.status === "Ready"
  const monitoring = useCampaignMonitoring(organizationId, campaign.id, isRunning)
  const routes = useListCampaignRoutes({ campaignId: campaign.id })

  if (monitoring.isLoading || !organizationId) return <StatStripSkeleton count={4} />
  if (monitoring.isError) {
    return <ErrorState title="Couldn't load campaign progress." error={monitoring.error} onRetry={() => void monitoring.refetch()} />
  }
  const data = monitoring.data
  const hasActivity = data ? monitoringHasActivity(data) : false

  return (
    <div className="space-y-4">
      {preLaunch && <CampaignReadinessChecklist organizationId={organizationId} campaignId={campaign.id} active />}

      {!data || !hasActivity ? (
        <EmptyState
          title={preLaunch ? "Nothing has been sent yet." : "No sending activity recorded."}
          description={preLaunch ? "Import recipients, choose senders and templates in Setup, then plan and execute the campaign." : "Progress appears here once the campaign has queued messages."}
          data-testid="empty-campaign-progress"
        />
      ) : (
        <>
          <ProgressCard data={data} isRunning={isRunning} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Recipients" value={formatNumber(data.valid)} hint={`${formatNumber(data.total)} imported`} />
            <Stat label="Waiting" value={formatNumber(data.pending)} hint="Not yet sent" />
            <Stat label="Sending now" value={formatNumber(data.processing)} hint="In progress" />
            <Stat label="Sent" value={formatNumber(data.sent)} hint="Accepted by WhatsApp" />
            <Stat label="Delivered" value={formatNumber(data.delivered)} hint="Reported by WhatsApp" />
            <Stat label="Read" value={formatNumber(data.read)} hint="Reported by WhatsApp" />
            <Stat label="Failed" value={formatNumber(data.failed)} hint={data.retryCount > 0 ? `${formatNumber(data.retryCount)} retries so far` : "No retries"} tone={data.failed > 0 ? "danger" : undefined} />
            <Stat label="Delivery unknown" value={formatNumber(data.deliveryUnknown)} hint="Needs manual review" tone={data.deliveryUnknown > 0 ? "warning" : undefined} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Configured speed" value={`${formatNumber(data.effectiveConfiguredTps)} msg/s`} hint="Configured capacity after provider caps, not a measured rate" />
            <Stat
              label="Estimated completion"
              value={data.estimatedCompletionAt ? new Date(data.estimatedCompletionAt).toLocaleTimeString() : "—"}
              hint={data.estimatedCompletionAt ? "Based on configured speed" : "Available while sending"}
            />
          </div>
          <SendersTable monitoringRoutes={data.routes} routes={routes.data ?? []} />
          <TechnicalDetails
            fields={[
              { label: "Campaign ID", value: campaign.id, copyable: true },
              { label: "Queued jobs", value: data.queued },
              { label: "Delayed retries", value: data.delayedRetries },
              { label: "Stale leases", value: data.staleLeases },
              { label: "Rate-limited senders", value: data.throttledRoutes },
              { label: "Reconciliation runs", value: data.reconciliationRuns },
              { label: "Error reasons", value: data.errorReasons },
            ]}
          />
        </>
      )}
    </div>
  )
}

function ProgressCard({ data, isRunning }: { data: NonNullable<ReturnType<typeof useCampaignMonitoring>["data"]>; isRunning: boolean }) {
  const settled = data.sent + data.failed
  const pct = data.valid > 0 ? Math.min(100, (settled / data.valid) * 100) : 0
  return (
    <Card>
      <CardContent className="space-y-2 pt-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Progress</span>
          <span className="font-mono text-muted-foreground">
            {formatNumber(settled)} / {formatNumber(data.valid)} ({Math.round(pct)}%)
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <div className={`h-full ${data.failed > 0 && data.failed >= data.sent ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          {isRunning ? "Updates automatically every few seconds while this campaign is sending." : "Figures reflect the last recorded state."}
        </p>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "warning" }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold tabular-nums ${tone === "danger" ? "text-destructive" : tone === "warning" ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function SendersTable({
  monitoringRoutes,
  routes,
}: {
  monitoringRoutes: { routeId: number; configuredTps: number; queueDepth: number; status: string; sent: number; failed: number }[]
  routes: { id: number; phoneNumber: string; templateName: string | null }[]
}) {
  if (!monitoringRoutes.length) return null
  const byId = new Map(routes.map((route) => [route.id, route]))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Senders</CardTitle>
        <CardDescription>How each number is doing in this campaign.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sender</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Configured speed</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitoringRoutes.map((route) => {
                const info = byId.get(route.routeId)
                return (
                  <TableRow key={route.routeId} data-testid={`row-sender-${route.routeId}`}>
                    <TableCell className="font-mono">{info?.phoneNumber ?? "—"}</TableCell>
                    <TableCell>{info?.templateName ?? "—"}</TableCell>
                    <TableCell><StatusChip kind="route" value={route.status} /></TableCell>
                    <TableCell className="text-right font-mono">{route.configuredTps}/s</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(route.queueDepth)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(route.sent)}</TableCell>
                    <TableCell className={`text-right font-mono ${route.failed > 0 ? "text-destructive" : ""}`}>{formatNumber(route.failed)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <ul className="space-y-2 md:hidden">
          {monitoringRoutes.map((route) => {
            const info = byId.get(route.routeId)
            return (
              <li key={route.routeId} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{info?.phoneNumber ?? "—"}</span>
                  <StatusChip kind="route" value={route.status} />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{info?.templateName ?? "—"}</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <span>Speed <span className="font-mono">{route.configuredTps}/s</span></span>
                  <span>Sent <span className="font-mono">{formatNumber(route.sent)}</span></span>
                  <span>Failed <span className={`font-mono ${route.failed > 0 ? "text-destructive" : ""}`}>{formatNumber(route.failed)}</span></span>
                </div>
              </li>
            )
          })}
        </ul>
        <TechnicalDetails fields={monitoringRoutes.map((route) => ({ label: `Route ${route.routeId}`, value: { routeId: route.routeId, status: route.status, queueDepth: route.queueDepth } }))} title="Route identifiers" />
      </CardContent>
    </Card>
  )
}

function SetupTab({ campaign, organizationId }: { campaign: Campaign; organizationId: number | undefined }) {
  const [mappingOpen, setMappingOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const routes = useListCampaignRoutes({ campaignId: campaign.id })
  const preLaunch = campaign.status === "Draft" || campaign.status === "Ready"

  return (
    <div className="space-y-4">
      {preLaunch && <CampaignReadinessChecklist organizationId={organizationId} campaignId={campaign.id} active />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients</CardTitle>
          <CardDescription>{formatNumber(campaign.audienceSize)} valid recipients imported.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" data-testid="link-manage-audience">
              <Link href={`/campaigns/${campaign.id}/audience`}>Manage audience</Link>
            </Button>
            <Button variant="ghost" onClick={() => setImportOpen(true)} disabled={campaign.status !== "Draft"} data-testid="button-import-contacts">
              Quick import (CSV)
            </Button>
          </div>
          {campaign.status !== "Draft" && (
            <p className="mt-2 text-xs text-muted-foreground">Recipients can only be imported while the campaign is a draft. A planned campaign with nothing sent can be moved back to draft from the audience page.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Senders and templates</CardTitle>
          <CardDescription>Which numbers send which template.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {routes.isLoading ? (
            <StatStripSkeleton count={2} />
          ) : (routes.data ?? []).length === 0 ? (
            <EmptyState
              title="No senders configured."
              description="Choose the numbers and templates for this campaign in Sending setup."
              primaryAction={
                <Button asChild variant="outline">
                  <Link href="/rocket-campaigns" data-testid="link-sending-setup">Open sending setup</Link>
                </Button>
              }
            />
          ) : (
            <ul className="space-y-2">
              {(routes.data ?? []).map((route) => (
                <li key={route.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm" data-testid={`row-setup-route-${route.id}`}>
                  <div>
                    <div className="font-mono">{route.phoneNumber}</div>
                    <div className="text-xs text-muted-foreground">{route.templateName ?? "No template chosen"}</div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Speed {route.configuredTps}/s</span>
                    <StatusChip kind="route" value={route.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setMappingOpen(true)} data-testid="button-configure-templates">Templates &amp; variables</Button>
            <Button asChild variant="outline">
              <Link href="/rocket-campaigns">Sending setup</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <TemplateMappingDialog campaign={mappingOpen ? campaign : null} organizationId={organizationId} open={mappingOpen} onOpenChange={setMappingOpen} />
      <ContactImportDialog campaign={importOpen ? campaign : null} organizationId={organizationId} open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}

function DetailsTab({ campaign, organizationId, active }: { campaign: Campaign; organizationId: number | undefined; active: boolean }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">About this campaign</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Status"><StatusChip kind="campaign" value={campaign.status} /></Field>
            <Field label="Schedule">{campaign.schedule}</Field>
            <Field label="Recipients">{formatNumber(campaign.audienceSize)}</Field>
            <Field label="Senders">{campaign.routesCount}</Field>
            <Field label="Created">{new Date(campaign.createdAt).toLocaleString()}</Field>
            <Field label="Last updated">{new Date(campaign.updatedAt).toLocaleString()}</Field>
          </dl>
          <div className="mt-4">
            <TechnicalDetails fields={[{ label: "Campaign ID", value: campaign.id, copyable: true }, { label: "Sample record", value: campaign.isSample }]} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What will send</CardTitle>
          <CardDescription>The frozen plan: senders, templates and variables locked in when the campaign was planned.</CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignPlanPanel organizationId={organizationId} campaignId={campaign.id} active={active} />
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

