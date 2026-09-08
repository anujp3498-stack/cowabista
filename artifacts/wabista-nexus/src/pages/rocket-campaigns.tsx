import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatNumber } from "@/lib/utils"
import {
  campaignStatusVariant,
  canPlanCampaign,
  canExecuteCampaign,
  canPauseCampaign,
  canResumeCampaign,
  canCancelCampaign,
} from "@/lib/campaign-status"
import { useCampaignLifecycle } from "@/hooks/use-campaign-lifecycle"
import { CampaignNotReadyDialog } from "@/components/campaigns/campaign-not-ready-dialog"
import { CampaignPlanDialog } from "@/components/campaigns/campaign-plan-dialog"
import { CampaignMessagesDialog } from "@/components/campaigns/campaign-messages-dialog"
import { ContactImportDialog } from "@/components/campaigns/contact-import-dialog"
import { TemplateMappingDialog } from "@/components/campaigns/template-mapping-dialog"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Eye,
  FileDigit,
  Loader2,
  MoreVertical,
  Network,
  Pencil,
  PauseCircle,
  PlayCircle,
  Plus,
  Rocket,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Webhook,
  XCircle,
} from "lucide-react"
import {
  useListCampaignRoutes,
  useConfigureRocketCampaign,
  useCreateCampaignRoute,
  useUpdateCampaignRoute,
  useDeleteCampaignRoute,
  useListCampaigns,
  useListOrganizations,
  useListPhoneNumbers,
  useListTemplates,
  useGetCampaignMonitoring,
  useGetCampaignReadiness,
  getListCampaignRoutesQueryKey,
  getListCampaignsQueryKey,
  getGetCampaignMonitoringQueryKey,
  getGetCampaignReadinessQueryKey,
  type Campaign,
  type CampaignRoute,
  type CampaignRouteInputPriority,
  type CampaignRouteInputStatus,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"

function apiErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback
  const data = "data" in error ? (error as { data?: unknown }).data : undefined
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error
  }
  return error instanceof Error ? error.message : fallback
}

// Live progress/readiness panel for one campaign card. Reads the existing
// GET .../campaigns/:id/monitoring endpoint (queue/sent/delivered/failed
// counts, effective TPS after provider caps, retry/stale-lease/throttle
// signals) that already backed the campaign-engine service but was never
// surfaced on this screen -- Rocket previously showed only static
// configuration (route TPS fields, audience size), not real send progress.
function CampaignMonitoringPanel({
  organizationId,
  campaignId,
  isRunning,
}: {
  organizationId: number | undefined
  campaignId: number
  isRunning: boolean
}) {
  // Orval types `options.query` as a full UseQueryOptions (see the
  // orval-hooks-enabled-quirk memory), so re-supply queryKey alongside
  // refetchInterval to satisfy that without fighting the generated type.
  const { data: monitoring, isLoading } = useGetCampaignMonitoring(
    organizationId as number,
    campaignId,
    {
      query: {
        queryKey: getGetCampaignMonitoringQueryKey(organizationId as number, campaignId),
        refetchInterval: isRunning ? 4000 : false,
      },
    },
  )

  if (!organizationId || isLoading || !monitoring) return null
  // Before a plan exists there's nothing sent/queued yet -- avoid showing an
  // all-zero progress panel that would read as "campaign is stuck".
  if (monitoring.valid === 0 && monitoring.queued === 0 && monitoring.sent === 0 && monitoring.failed === 0) return null

  const settled = monitoring.sent + monitoring.failed
  const progressPct = monitoring.valid > 0 ? Math.min(100, (settled / monitoring.valid) * 100) : 0
  const topErrors = Object.entries(monitoring.errorReasons).sort((a, b) => b[1] - a[1]).slice(0, 2)

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid={`panel-monitoring-${campaignId}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">Live Send Progress</span>
        <span className="font-mono" data-testid={`text-monitoring-progress-${campaignId}`}>
          {formatNumber(settled)} / {formatNumber(monitoring.valid)}
        </span>
      </div>
      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${monitoring.failed > 0 && monitoring.failed >= monitoring.sent ? "bg-destructive" : "bg-emerald-500"}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs pt-1">
        <div>
          <span className="text-muted-foreground">Queued</span>
          <p className="font-mono font-medium" data-testid={`text-monitoring-queued-${campaignId}`}>{formatNumber(monitoring.pending)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Delivered</span>
          <p className="font-mono font-medium">{formatNumber(monitoring.delivered)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Failed</span>
          <p className={`font-mono font-medium ${monitoring.failed > 0 ? "text-destructive" : ""}`} data-testid={`text-monitoring-failed-${campaignId}`}>
            {formatNumber(monitoring.failed)}
          </p>
        </div>
        <div>
          <span className="text-muted-foreground">Effective TPS</span>
          <p className="font-mono font-medium">{monitoring.effectiveConfiguredTps}</p>
        </div>
      </div>
      {(monitoring.staleLeases > 0 || monitoring.throttledRoutes > 0 || topErrors.length > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {monitoring.throttledRoutes > 0 && (
            <Badge variant="warning" className="text-[10px] py-0 h-5">{monitoring.throttledRoutes} route(s) throttled</Badge>
          )}
          {monitoring.staleLeases > 0 && (
            <Badge variant="warning" className="text-[10px] py-0 h-5">{monitoring.staleLeases} stale lease(s) recovering</Badge>
          )}
          {topErrors.map(([reason, count]) => (
            <Badge key={reason} variant="destructive" className="text-[10px] py-0 h-5" title={reason}>
              {reason}: {count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

// Proactive readiness checklist for one campaign card. Reads the new GET
// .../campaigns/:id/readiness endpoint, which runs the exact same
// validateCampaignReady() rule set Plan/Execute enforce -- so a manager sees
// precisely what's blocking a launch (missing route, unselected template,
// unmapped variable, TPS over the provider cap, etc.) right on this screen,
// instead of discovering it only after clicking Plan and hitting the
// CampaignNotReadyDialog error. Only shown pre-launch (Draft/Ready), where
// readiness is still actionable; Running/Paused/Completed campaigns show
// live progress via CampaignMonitoringPanel instead.
function CampaignReadinessChecklist({
  organizationId,
  campaignId,
  active,
}: {
  organizationId: number | undefined
  campaignId: number
  active: boolean
}) {
  const { data: readiness, isLoading } = useGetCampaignReadiness(
    organizationId as number,
    campaignId,
    {
      query: {
        queryKey: getGetCampaignReadinessQueryKey(organizationId as number, campaignId),
        refetchInterval: active ? 5000 : false,
      },
    },
  )

  if (!organizationId || !active || isLoading || !readiness) return null

  if (readiness.ready) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
        data-testid={`panel-readiness-${campaignId}`}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className="font-medium">Ready to plan and launch</span>
      </div>
    )
  }

  return (
    <div
      className="rounded-md border border-amber-600/30 bg-amber-500/10 p-3 space-y-1.5"
      data-testid={`panel-readiness-${campaignId}`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {readiness.errors.length} readiness issue{readiness.errors.length === 1 ? "" : "s"} to resolve
      </div>
      <ul className="space-y-1 pl-6 list-disc text-xs text-muted-foreground">
        {readiness.errors.map((error, index) => (
          <li key={index} data-testid={`text-readiness-issue-${campaignId}-${index}`}>{error}</li>
        ))}
      </ul>
    </div>
  )
}

type RocketSetupForm = {
  campaignId: string
  selectedNumbers: Record<number, number>
  templateIds: number[]
  priority: CampaignRouteInputPriority
}

function RocketSetupDialog({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: RocketSetupForm) => void
  isSubmitting: boolean
}) {
  const { data: campaigns } = useListCampaigns()
  const { data: phoneNumbers } = useListPhoneNumbers()
  const { data: templates } = useListTemplates()
  const [form, setForm] = useState<RocketSetupForm>({
    campaignId: "",
    selectedNumbers: {},
    templateIds: [],
    priority: "Normal",
  })

  const connectedNumbers = (phoneNumbers ?? []).filter((number) => number.status === "Connected")
  const approvedTemplates = (templates ?? []).filter((template) => template.status === "Approved")
  const selectedNumberEntries = Object.entries(form.selectedNumbers)
  const aggregateTps = selectedNumberEntries.reduce((sum, [, tps]) => sum + tps, 0)
  const readyToSave =
    !!form.campaignId &&
    selectedNumberEntries.length > 0 &&
    form.templateIds.length > 0 &&
    selectedNumberEntries.length >= form.templateIds.length &&
    selectedNumberEntries.every(([id, tps]) => {
      const number = connectedNumbers.find((candidate) => candidate.id === Number(id))
      return !!number && Number.isInteger(tps) && tps >= 1 && tps <= number.tpsLimit
    })

  const reset = () =>
    setForm({
      campaignId: "",
      selectedNumbers: {},
      templateIds: [],
      priority: "Normal",
    })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-rocket-setup">
        <DialogHeader>
          <DialogTitle>Configure Rocket Campaign</DialogTitle>
          <DialogDescription>
            Pick all sending numbers once, set each number's TPS, and choose the templates. Contacts will be distributed automatically across the resulting routes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault()
            if (readyToSave) onSubmit(form)
          }}
        >
          <div className="grid gap-2">
            <Label>Campaign</Label>
            <Select value={form.campaignId} onValueChange={(campaignId) => setForm({ ...form, campaignId })}>
              <SelectTrigger data-testid="select-rocket-campaign">
                <SelectValue placeholder="Select a draft campaign" />
              </SelectTrigger>
              <SelectContent>
                {(campaigns ?? [])
                  .filter((campaign) => campaign.status === "Draft" || campaign.status === "Ready")
                  .map((campaign) => (
                    <SelectItem key={campaign.id} value={String(campaign.id)}>
                      {campaign.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <div className="flex items-end justify-between gap-4">
              <div>
                <Label>Sending Numbers</Label>
                <p className="text-xs text-muted-foreground mt-1">Select multiple connected numbers and confirm the TPS for each.</p>
              </div>
              <Badge variant="outline" className="font-mono">
                {selectedNumberEntries.length} numbers · {aggregateTps} aggregate TPS
              </Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {connectedNumbers.map((number) => {
                const selectedTps = form.selectedNumbers[number.id]
                const selected = selectedTps !== undefined
                return (
                  <div
                    key={number.id}
                    className={`rounded-lg border p-3 ${selected ? "border-primary bg-primary/5" : ""}`}
                    data-testid={`rocket-number-${number.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selected}
                        onCheckedChange={(checked) => {
                          const selectedNumbers = { ...form.selectedNumbers }
                          if (checked) selectedNumbers[number.id] = number.tpsLimit
                          else delete selectedNumbers[number.id]
                          setForm({ ...form, selectedNumbers })
                        }}
                        aria-label={`Select ${number.displayName}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{number.displayName}</p>
                        <p className="text-xs text-muted-foreground font-mono">{number.phone}</p>
                      </div>
                      <div className="w-24">
                        <Label className="text-[10px] text-muted-foreground">TPS / max {number.tpsLimit}</Label>
                        <Input
                          type="number"
                          min={1}
                          max={number.tpsLimit}
                          disabled={!selected}
                          value={selectedTps ?? number.tpsLimit}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              selectedNumbers: {
                                ...form.selectedNumbers,
                                [number.id]: Number(event.target.value),
                              },
                            })
                          }
                          className="h-8 font-mono"
                          data-testid={`input-rocket-tps-${number.id}`}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {connectedNumbers.length === 0 && (
              <p className="text-sm text-muted-foreground">Connect at least one WhatsApp number before configuring Rocket.</p>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <Label>Templates</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Select multiple approved templates. Rocket rotates them across the selected numbers.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {approvedTemplates.map((template) => {
                const selected = form.templateIds.includes(template.id)
                return (
                  <label
                    key={template.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${selected ? "border-primary bg-primary/5" : ""}`}
                    data-testid={`rocket-template-${template.id}`}
                  >
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) =>
                        setForm({
                          ...form,
                          templateIds: checked
                            ? [...form.templateIds, template.id]
                            : form.templateIds.filter((id) => id !== template.id),
                        })
                      }
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{template.name}</p>
                      <p className="text-xs text-muted-foreground">{template.language} · {template.category}</p>
                    </div>
                  </label>
                )
              })}
            </div>
            {form.templateIds.length > selectedNumberEntries.length && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Select at least {form.templateIds.length} numbers so every template receives a route.
              </p>
            )}
          </div>

          <div className="grid gap-2 max-w-xs">
            <Label>Priority</Label>
            <Select
              value={form.priority}
              onValueChange={(priority) => setForm({ ...form, priority: priority as CampaignRouteInputPriority })}
            >
              <SelectTrigger data-testid="select-rocket-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="High">High</SelectItem>
                <SelectItem value="Normal">Normal</SelectItem>
                <SelectItem value="Low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div><p className="text-2xl font-bold">{selectedNumberEntries.length}</p><p className="text-xs text-muted-foreground">Numbers</p></div>
              <div><p className="text-2xl font-bold">{form.templateIds.length}</p><p className="text-xs text-muted-foreground">Templates</p></div>
              <div><p className="text-2xl font-bold font-mono">{aggregateTps}</p><p className="text-xs text-muted-foreground">Estimated TPS</p></div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!readyToSave || isSubmitting} data-testid="button-save-rocket-setup">
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
              Configure Routes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RouteFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  isSubmitting,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: FormState
  onSubmit: (values: FormState) => void
  isSubmitting: boolean
  title: string
}) {
  const [form, setForm] = useState<FormState>(initial)
  const { data: campaigns } = useListCampaigns()
  const { data: phoneNumbers } = useListPhoneNumbers()
  const { data: templates } = useListTemplates()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(initial)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(form)
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Campaign</Label>
              <Select value={form.campaignId} onValueChange={(v) => setForm({ ...form, campaignId: v })}>
                <SelectTrigger data-testid="select-route-campaign">
                  <SelectValue placeholder="Select campaign" />
                </SelectTrigger>
                <SelectContent>
                  {(campaigns ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Phone Number</Label>
              <Select value={form.phoneNumberId} onValueChange={(v) => setForm({ ...form, phoneNumberId: v })}>
                <SelectTrigger data-testid="select-route-phone-number">
                  <SelectValue placeholder="Select number" />
                </SelectTrigger>
                <SelectContent>
                  {(phoneNumbers ?? []).map((pn) => (
                    <SelectItem key={pn.id} value={String(pn.id)}>{pn.displayName} ({pn.phone})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Template</Label>
            <Select value={form.templateId} onValueChange={(v) => setForm({ ...form, templateId: v })}>
              <SelectTrigger data-testid="select-route-template">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {(templates ?? []).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Priority</Label>
              <Select
                value={form.priority}
                onValueChange={(v) => setForm({ ...form, priority: v as CampaignRouteInputPriority })}
              >
                <SelectTrigger data-testid="select-route-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Normal">Normal</SelectItem>
                  <SelectItem value="Low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as CampaignRouteInputStatus })}
              >
                <SelectTrigger data-testid="select-route-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Throttled">Throttled</SelectItem>
                  <SelectItem value="Error">Error</SelectItem>
                  <SelectItem value="Paused">Paused</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="route-configured-tps">Configured TPS</Label>
              <input
                id="route-configured-tps"
                data-testid="input-route-configured-tps"
                type="number"
                min={0}
                value={form.configuredTps}
                onChange={(e) => setForm({ ...form, configuredTps: e.target.value })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="route-current-tps">Current TPS</Label>
              <input
                id="route-current-tps"
                data-testid="input-route-current-tps"
                type="number"
                min={0}
                value={form.currentTps}
                onChange={(e) => setForm({ ...form, currentTps: e.target.value })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="route-queue-depth">Queue Depth</Label>
              <input
                id="route-queue-depth"
                data-testid="input-route-queue-depth"
                type="number"
                min={0}
                value={form.queueDepth}
                onChange={(e) => setForm({ ...form, queueDepth: e.target.value })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={isSubmitting || !form.campaignId || !form.phoneNumberId}
              data-testid="button-submit-route"
            >
              {isSubmitting ? "Saving..." : "Save Route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function RocketCampaigns() {
  const { data: routes, isLoading } = useListCampaignRoutes()
  const { data: campaigns } = useListCampaigns()
  const { data: organizations } = useListOrganizations()
  const activeOrg = organizations?.find((org) => org.isActive) ?? organizations?.[0]
  const createRoute = useCreateCampaignRoute()
  const configureRocket = useConfigureRocketCampaign()
  const updateRoute = useUpdateCampaignRoute()
  const deleteRoute = useDeleteCampaignRoute()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidateRoutes = () =>
    queryClient.invalidateQueries({ queryKey: getListCampaignRoutesQueryKey() })
  const { handleAction, isPending: isActioning, isActioningAs, notReady, setNotReady } = useCampaignLifecycle(activeOrg?.id)

  const [createOpen, setCreateOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [editing, setEditing] = useState<CampaignRoute | null>(null)
  const [deleting, setDeleting] = useState<CampaignRoute | null>(null)
  const [viewingPlan, setViewingPlan] = useState<Campaign | null>(null)
  const [viewingMessages, setViewingMessages] = useState<Campaign | null>(null)
  const [importingContacts, setImportingContacts] = useState<Campaign | null>(null)
  const [cancelling, setCancelling] = useState<Campaign | null>(null)
  const [configuringTemplates, setConfiguringTemplates] = useState<Campaign | null>(null)

  // Multi-route campaigns are exactly what the Rocket Engine partitions
  // across numbers, so managers need to plan/execute and see readiness right
  // here rather than switching to the plain Campaigns page. Group routes by
  // campaign and pull in each campaign's live status from useListCampaigns().
  const routesByCampaign = new Map<number, CampaignRoute[]>()
  for (const route of routes ?? []) {
    const list = routesByCampaign.get(route.campaignId) ?? []
    list.push(route)
    routesByCampaign.set(route.campaignId, list)
  }
  const engineCampaigns = [...routesByCampaign.entries()]
    .map(([campaignId, campaignRoutes]) => {
      const campaign = campaigns?.find((c) => c.id === campaignId)
      if (!campaign) return null
      return {
        campaign,
        routes: campaignRoutes,
        totalConfiguredTps: campaignRoutes.reduce((sum, r) => sum + r.configuredTps, 0),
        totalCurrentTps: campaignRoutes.reduce((sum, r) => sum + r.currentTps, 0),
        totalQueueDepth: campaignRoutes.reduce((sum, r) => sum + r.queueDepth, 0),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  const buildPayload = (values: FormState) => ({
    campaignId: Number(values.campaignId),
    phoneNumberId: Number(values.phoneNumberId),
    templateId: values.templateId === "none" || !values.templateId ? null : Number(values.templateId),
    priority: values.priority,
    configuredTps: Number(values.configuredTps) || 0,
    currentTps: Number(values.currentTps) || 0,
    queueDepth: Number(values.queueDepth) || 0,
    status: values.status,
  })

  const handleCreate = (values: FormState) => {
    createRoute.mutate(
      { data: buildPayload(values) },
      {
        onSuccess: () => {
          invalidateRoutes()
          toast({ title: "Route created" })
          setCreateOpen(false)
        },
        onError: () => toast({ title: "Failed to create route", variant: "destructive" }),
      }
    )
  }

  const handleRocketSetup = (values: RocketSetupForm) => {
    if (!activeOrg) return
    const campaignId = Number(values.campaignId)
    const campaign = campaigns?.find((candidate) => candidate.id === campaignId)
    if (!campaign) return
    configureRocket.mutate(
      {
        organizationId: activeOrg.id,
        campaignId,
        data: {
          numbers: Object.entries(values.selectedNumbers).map(([phoneNumberId, configuredTps]) => ({
            phoneNumberId: Number(phoneNumberId),
            configuredTps,
          })),
          templateIds: values.templateIds,
          priority: values.priority,
        },
      },
      {
        onSuccess: async (result) => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getListCampaignRoutesQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() }),
            queryClient.invalidateQueries({
              queryKey: getGetCampaignReadinessQueryKey(activeOrg.id, campaignId),
            }),
          ])
          toast({
            title: "Rocket routes configured",
            description: `${result.numberCount} numbers, ${result.templateCount} templates, ${result.aggregateTps} aggregate TPS.`,
          })
          setSetupOpen(false)
          setConfiguringTemplates(campaign)
        },
        onError: (error) =>
          toast({
            title: "Rocket setup failed",
            description: apiErrorMessage(error, "Unable to configure this campaign"),
            variant: "destructive",
          }),
      },
    )
  }

  const handleUpdate = (values: FormState) => {
    if (!editing) return
    updateRoute.mutate(
      { routeId: editing.id, data: buildPayload(values) },
      {
        onSuccess: () => {
          invalidateRoutes()
          toast({ title: "Route updated" })
          setEditing(null)
        },
        onError: () => toast({ title: "Failed to update route", variant: "destructive" }),
      }
    )
  }

  const handleDelete = () => {
    if (!deleting) return
    deleteRoute.mutate(
      { routeId: deleting.id },
      {
        onSuccess: () => {
          invalidateRoutes()
          toast({ title: "Route deleted" })
          setDeleting(null)
        },
        onError: () => toast({ title: "Failed to delete route", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">Rocket Engine</h1>
            <Badge className="bg-primary/20 text-primary border-none hover:bg-primary/20">PRO FEATURE</Badge>
          </div>
          <p className="text-muted-foreground max-w-3xl">
            The Rocket Campaign Engine partitions large audiences and distributes sending across multiple WABA numbers simultaneously.
            This avoids provider rate limits and ensures massive campaigns complete reliably.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" className="gap-2" data-testid="button-add-route" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Add Single Route
          </Button>
          <Button className="gap-2" data-testid="button-configure-rocket" onClick={() => setSetupOpen(true)}>
            <Rocket className="h-4 w-4" />
            Configure Campaign
          </Button>
        </div>
      </div>

      <div className="bg-slate-900 rounded-xl p-8 text-slate-50 border border-slate-800 shadow-2xl overflow-hidden relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/20 via-slate-900 to-slate-900 z-0 opacity-50"></div>

        <div className="relative z-10">
          <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" /> Engine Pipeline Architecture
          </h2>
          <p className="text-xs text-slate-400 mb-8 font-mono">LIVE — TPS enforcement and queue depth below are updated in real time by the campaign runtime.</p>

          <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
            {/* Step 1 */}
            <div className="flex-1 w-full bg-slate-800/80 backdrop-blur border border-slate-700 p-4 rounded-lg text-center">
              <Database className="h-8 w-8 mx-auto mb-3 text-slate-400" />
              <div className="font-semibold text-sm mb-1">Audience Split</div>
              <div className="text-xs text-slate-400 font-mono">1.2M Contacts</div>
            </div>

            <ArrowRight className="h-6 w-6 text-slate-600 hidden lg:block flex-shrink-0" />
            <div className="h-6 w-px bg-slate-600 block lg:hidden"></div>

            {/* Step 2 */}
            <div className="flex-1 w-full bg-slate-800/80 backdrop-blur border border-slate-700 p-4 rounded-lg text-center">
              <ShieldCheck className="h-8 w-8 mx-auto mb-3 text-emerald-400" />
              <div className="font-semibold text-sm mb-1">Validation & Normalization</div>
              <div className="text-xs text-slate-400 font-mono">E.164 Checking</div>
            </div>

            <ArrowRight className="h-6 w-6 text-slate-600 hidden lg:block flex-shrink-0" />
            <div className="h-6 w-px bg-slate-600 block lg:hidden"></div>

            {/* Step 3 */}
            <div className="flex-[1.5] w-full bg-primary/10 backdrop-blur border border-primary/30 p-4 rounded-lg text-center ring-1 ring-primary/50 relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-primary/20 px-2 py-0.5 text-[10px] font-bold text-primary rounded-bl">ROUTER</div>
              <ServerCog className="h-8 w-8 mx-auto mb-3 text-primary" />
              <div className="font-semibold text-sm mb-1 text-primary-100">Dynamic Multi-Routing</div>
              <div className="text-xs text-primary/70 font-mono">Assigning {routes?.length ?? 0} route(s)</div>
            </div>

            <ArrowRight className="h-6 w-6 text-slate-600 hidden lg:block flex-shrink-0" />
            <div className="h-6 w-px bg-slate-600 block lg:hidden"></div>

            {/* Step 4 */}
            <div className="flex-1 w-full bg-slate-800/80 backdrop-blur border border-slate-700 p-4 rounded-lg text-center">
              <FileDigit className="h-8 w-8 mx-auto mb-3 text-amber-400" />
              <div className="font-semibold text-sm mb-1">TPS Controller</div>
              <div className="text-xs text-slate-400 font-mono">Enforcing Limits</div>
            </div>

            <ArrowRight className="h-6 w-6 text-slate-600 hidden lg:block flex-shrink-0" />
            <div className="h-6 w-px bg-slate-600 block lg:hidden"></div>

            {/* Step 5 */}
            <div className="flex-1 w-full bg-slate-800/80 backdrop-blur border border-slate-700 p-4 rounded-lg text-center">
              <Webhook className="h-8 w-8 mx-auto mb-3 text-purple-400" />
              <div className="font-semibold text-sm mb-1">Cloud API Async Worker</div>
              <div className="text-xs text-slate-400 font-mono">Real-time Sending</div>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold tracking-tight">Multi-Route Campaigns</h3>
        {engineCampaigns.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No campaigns have routes yet. Add a route below to bring a campaign into the Rocket Engine.
          </p>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {engineCampaigns.map(({ campaign, routes: campaignRoutes, totalConfiguredTps, totalCurrentTps, totalQueueDepth }) => {
            const canPlan = canPlanCampaign(campaign.status)
            const canExecute = canExecuteCampaign(campaign.status)
            return (
              <Card key={campaign.id} data-testid={`card-engine-campaign-${campaign.id}`}>
                <CardHeader className="pb-3 flex flex-row items-start justify-between">
                  <div>
                    <CardTitle className="text-base font-bold tracking-tight flex items-center gap-2">
                      {campaign.name}
                      {campaign.isSample && (
                        <Badge variant="outline" className="gap-1 text-[10px] py-0 h-5">
                          <Sparkles className="h-2.5 w-2.5" /> Sample
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="text-xs mt-1">
                      {campaignRoutes.length} route{campaignRoutes.length === 1 ? "" : "s"} · combined TPS {totalCurrentTps}/{totalConfiguredTps}
                    </CardDescription>
                  </div>
                  <Badge variant={campaignStatusVariant(campaign.status) as any}>{campaign.status}</Badge>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div className="space-y-1">
                      <span className="text-muted-foreground text-xs">Combined TPS</span>
                      <p className="font-mono font-medium">{totalCurrentTps} / {totalConfiguredTps}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-muted-foreground text-xs">Queue Depth</span>
                      <p className="font-mono font-medium">{formatNumber(totalQueueDepth)}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-muted-foreground text-xs">Audience</span>
                      <p className="font-mono font-medium">{formatNumber(campaign.audienceSize)}</p>
                    </div>
                  </div>
                  <CampaignReadinessChecklist
                    organizationId={activeOrg?.id}
                    campaignId={campaign.id}
                    active={canPlan || canExecute}
                  />
                  <CampaignMonitoringPanel
                    organizationId={activeOrg?.id}
                    campaignId={campaign.id}
                    isRunning={campaign.status === "Running"}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={() => setImportingContacts(campaign)}
                      data-testid={`button-import-contacts-${campaign.id}`}
                    >
                      <Upload className="h-4 w-4" />
                      Import Contacts
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={() => setConfiguringTemplates(campaign)}
                      data-testid={`button-template-mappings-${campaign.id}`}
                    >
                      <FileDigit className="h-4 w-4" />
                      Templates & Variables
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      disabled={!canPlan || isActioning}
                      onClick={() => handleAction(campaign, "plan")}
                      data-testid={`button-engine-plan-${campaign.id}`}
                    >
                      {isActioningAs(campaign.id, "plan") ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Rocket className="h-4 w-4" />
                      )}
                      {campaign.status === "Ready" ? "Re-plan" : "Plan"}
                    </Button>
                    <Button
                      size="sm"
                      className="gap-2"
                      disabled={!canExecute || isActioning}
                      onClick={() => handleAction(campaign, "execute")}
                      data-testid={`button-engine-execute-${campaign.id}`}
                    >
                      {isActioningAs(campaign.id, "execute") ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <PlayCircle className="h-4 w-4" />
                      )}
                      Execute
                    </Button>
                    {canPauseCampaign(campaign.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        disabled={isActioning}
                        onClick={() => handleAction(campaign, "pause")}
                        data-testid={`button-engine-pause-${campaign.id}`}
                      >
                        {isActioningAs(campaign.id, "pause") ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <PauseCircle className="h-4 w-4" />
                        )}
                        Pause
                      </Button>
                    )}
                    {canResumeCampaign(campaign.status) && (
                      <Button
                        size="sm"
                        className="gap-2"
                        disabled={isActioning}
                        onClick={() => handleAction(campaign, "resume")}
                        data-testid={`button-engine-resume-${campaign.id}`}
                      >
                        {isActioningAs(campaign.id, "resume") ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <PlayCircle className="h-4 w-4" />
                        )}
                        Resume
                      </Button>
                    )}
                    {canCancelCampaign(campaign.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-2 text-destructive hover:text-destructive"
                        disabled={isActioning}
                        onClick={() => setCancelling(campaign)}
                        data-testid={`button-engine-cancel-${campaign.id}`}
                      >
                        <XCircle className="h-4 w-4" />
                        Cancel
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-2"
                      onClick={() => setViewingPlan(campaign)}
                      data-testid={`button-view-plan-${campaign.id}`}
                    >
                      <Eye className="h-4 w-4" />
                      What Will Send
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-2"
                      onClick={() => setViewingMessages(campaign)}
                      data-testid={`button-view-messages-${campaign.id}`}
                    >
                      <ServerCog className="h-4 w-4" />
                      Delivery Log
                    </Button>
                    {!canPlan && !canExecute && !canPauseCampaign(campaign.status) && !canResumeCampaign(campaign.status) && (
                      <span className="text-xs text-muted-foreground">
                        {campaign.status} campaigns can't be planned or executed from here.
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold tracking-tight">Campaign Routes</h3>
        {isLoading && <p className="text-sm text-muted-foreground">Loading routes...</p>}
        {!isLoading && (routes ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No campaign routes yet. Add one to route a campaign through a phone number.</p>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(routes ?? []).map((route) => (
            <Card key={route.id} className={route.status === 'Active' ? 'border-primary/50 shadow-sm' : ''} data-testid={`card-route-${route.id}`}>
              <CardHeader className="pb-3 flex flex-row items-start justify-between">
                <div>
                  <CardTitle className="text-base font-mono font-bold tracking-tight flex items-center gap-2">
                    {route.phoneNumber}
                    {route.isSample && (
                      <Badge variant="outline" className="gap-1 text-[10px] py-0 h-5">
                        <Sparkles className="h-2.5 w-2.5" /> Sample
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="font-mono text-xs mt-1">
                    {route.campaignName} • WABA: {route.wabaExternalId ?? "—"}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={
                    route.status === 'Active' ? 'success' :
                    route.status === 'Throttled' ? 'warning' : 'destructive'
                  }>
                    {route.status}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7" data-testid={`button-route-actions-${route.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(route)} data-testid={`button-edit-route-${route.id}`}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleting(route)}
                        data-testid={`button-delete-route-${route.id}`}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-xs">Template</span>
                    <p className="font-mono truncate" title={route.templateName ?? undefined}>{route.templateName ?? "—"}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-xs">Priority</span>
                    <p className="font-medium">{route.priority}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-xs">TPS Limit / Current</span>
                    <p className="font-mono">
                      <span className={route.currentTps >= route.configuredTps * 0.9 ? "text-amber-600 dark:text-amber-400 font-bold" : ""}>
                        {route.currentTps}
                      </span>
                      <span className="text-muted-foreground"> / {route.configuredTps}</span>
                    </p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-xs">Queue Depth</span>
                    <p className="font-mono font-medium">{formatNumber(route.queueDepth)}</p>
                  </div>
                </div>
                {route.queueDepth > 0 && (
                  <div className="mt-4 w-full h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full ${route.status === 'Throttled' ? 'bg-amber-500' : 'bg-primary'}`}
                      style={{ width: `${Math.min(100, (route.currentTps / route.configuredTps) * 100)}%` }}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <RouteFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={emptyForm}
        onSubmit={handleCreate}
        isSubmitting={createRoute.isPending}
        title="Add Campaign Route"
      />

      <RocketSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onSubmit={handleRocketSetup}
        isSubmitting={configureRocket.isPending}
      />

      {editing && (
        <RouteFormDialog
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
          initial={{
            campaignId: String(editing.campaignId),
            phoneNumberId: String(editing.phoneNumberId),
            templateId: editing.templateId ? String(editing.templateId) : "none",
            priority: editing.priority,
            configuredTps: String(editing.configuredTps),
            currentTps: String(editing.currentTps),
            queueDepth: String(editing.queueDepth),
            status: editing.status,
          }}
          onSubmit={handleUpdate}
          isSubmitting={updateRoute.isPending}
          title="Edit Campaign Route"
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete route?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the route from {deleting?.campaignName} to {deleting?.phoneNumber}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-confirm-delete-route">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!cancelling} onOpenChange={(open) => !open && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {cancelling?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the campaign for good — queued sends are cancelled and it cannot be resumed. This is different from Pause, which can be resumed later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Campaign</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (cancelling) handleAction(cancelling, "cancel")
                setCancelling(null)
              }}
              data-testid="button-confirm-cancel-campaign"
            >
              Cancel Campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CampaignNotReadyDialog notReady={notReady} onClose={() => setNotReady(null)} />

      <CampaignPlanDialog
        campaign={viewingPlan}
        organizationId={activeOrg?.id}
        open={!!viewingPlan}
        onOpenChange={(open) => !open && setViewingPlan(null)}
      />

      <CampaignMessagesDialog
        campaign={viewingMessages}
        organizationId={activeOrg?.id}
        open={!!viewingMessages}
        onOpenChange={(open) => !open && setViewingMessages(null)}
      />

      <ContactImportDialog
        campaign={importingContacts}
        organizationId={activeOrg?.id}
        open={!!importingContacts}
        onOpenChange={(open) => !open && setImportingContacts(null)}
      />

      <TemplateMappingDialog
        campaign={configuringTemplates}
        organizationId={activeOrg?.id}
        open={!!configuringTemplates}
        onOpenChange={(open) => !open && setConfiguringTemplates(null)}
      />
    </div>
  )
}

type FormState = {
  campaignId: string
  phoneNumberId: string
  templateId: string
  priority: CampaignRouteInputPriority
  configuredTps: string
  currentTps: string
  queueDepth: string
  status: CampaignRouteInputStatus
}

const emptyForm: FormState = {
  campaignId: "",
  phoneNumberId: "",
  templateId: "none",
  priority: "Normal",
  configuredTps: "50",
  currentTps: "0",
  queueDepth: "0",
  status: "Active",
}
