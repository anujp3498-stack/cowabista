import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/utils"
import { TemplateMappingDialog } from "@/components/campaigns/template-mapping-dialog"
import { CampaignNotReadyDialog } from "@/components/campaigns/campaign-not-ready-dialog"
import { CampaignPlanDialog } from "@/components/campaigns/campaign-plan-dialog"
import { CampaignMessagesDialog } from "@/components/campaigns/campaign-messages-dialog"
import { useCampaignLifecycle } from "@/hooks/use-campaign-lifecycle"
import {
  campaignStatusVariant,
  canPlanCampaign,
  canExecuteCampaign,
  canPauseCampaign,
  canResumeCampaign,
  canCancelCampaign,
} from "@/lib/campaign-status"
import { Plus, Search, MoreHorizontal, Pencil, Trash2, Sparkles, Rocket, PlayCircle, PauseCircle, XCircle, Loader2, ListChecks, Eye, ServerCog } from "lucide-react"
import {
  useListCampaigns,
  useCreateCampaign,
  useUpdateCampaign,
  useDeleteCampaign,
  useListOrganizations,
  getListCampaignsQueryKey,
  type Campaign,
  type CampaignInputStatus,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"

function CampaignFormDialog({
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
          <div className="grid gap-2">
            <Label htmlFor="camp-name">Campaign Name</Label>
            <Input
              id="camp-name"
              data-testid="input-campaign-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as CampaignInputStatus })}
              >
                <SelectTrigger data-testid="select-campaign-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Draft">Draft</SelectItem>
                  <SelectItem value="Ready">Ready</SelectItem>
                  <SelectItem value="Scheduled">Scheduled</SelectItem>
                  <SelectItem value="Running">Running</SelectItem>
                  <SelectItem value="Paused">Paused</SelectItem>
                  <SelectItem value="Completed">Completed</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                  <SelectItem value="Failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="camp-schedule">Schedule</Label>
              <Input
                id="camp-schedule"
                data-testid="input-campaign-schedule"
                value={form.schedule}
                onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                placeholder="Continuous / Unscheduled / a date"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="camp-audience">Audience Size</Label>
              <Input
                id="camp-audience"
                data-testid="input-campaign-audience"
                type="number"
                min={0}
                value={form.audienceSize}
                onChange={(e) => setForm({ ...form, audienceSize: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="camp-sent">Sent</Label>
              <Input
                id="camp-sent"
                data-testid="input-campaign-sent"
                type="number"
                min={0}
                value={form.sent}
                onChange={(e) => setForm({ ...form, sent: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="camp-delivered">Delivered</Label>
              <Input
                id="camp-delivered"
                data-testid="input-campaign-delivered"
                type="number"
                min={0}
                value={form.delivered}
                onChange={(e) => setForm({ ...form, delivered: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="camp-read">Read</Label>
              <Input
                id="camp-read"
                data-testid="input-campaign-read"
                type="number"
                min={0}
                value={form.read}
                onChange={(e) => setForm({ ...form, read: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="camp-failed">Failed</Label>
              <Input
                id="camp-failed"
                data-testid="input-campaign-failed"
                type="number"
                min={0}
                value={form.failed}
                onChange={(e) => setForm({ ...form, failed: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting} data-testid="button-submit-campaign">
              {isSubmitting ? "Saving..." : "Save Campaign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function Campaigns() {
  const { data: campaigns, isLoading } = useListCampaigns()
  const createCampaign = useCreateCampaign()
  const updateCampaign = useUpdateCampaign()
  const deleteCampaign = useDeleteCampaign()
  const { data: organizations } = useListOrganizations()
  const activeOrg = organizations?.find((org) => org.isActive) ?? organizations?.[0]
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidateCampaigns = () =>
    queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() })
  const { handleAction, isPending: isActioning, isActioningAs, notReady, setNotReady } = useCampaignLifecycle(activeOrg?.id)

  const [search, setSearch] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Campaign | null>(null)
  const [deleting, setDeleting] = useState<Campaign | null>(null)
  const [configuringTemplates, setConfiguringTemplates] = useState<Campaign | null>(null)
  const [viewingPlan, setViewingPlan] = useState<Campaign | null>(null)
  const [viewingMessages, setViewingMessages] = useState<Campaign | null>(null)
  const [cancelling, setCancelling] = useState<Campaign | null>(null)

  const filtered = (campaigns ?? []).filter((c) =>
    !search || c.name.toLowerCase().includes(search.toLowerCase())
  )

  const buildPayload = (values: FormState) => ({
    name: values.name,
    status: values.status,
    audienceSize: Number(values.audienceSize) || 0,
    sent: Number(values.sent) || 0,
    delivered: Number(values.delivered) || 0,
    read: Number(values.read) || 0,
    failed: Number(values.failed) || 0,
    schedule: values.schedule,
  })

  const handleCreate = (values: FormState) => {
    createCampaign.mutate(
      { data: buildPayload(values) },
      {
        onSuccess: () => {
          invalidateCampaigns()
          toast({ title: "Campaign created" })
          setCreateOpen(false)
        },
        onError: () => toast({ title: "Failed to create campaign", variant: "destructive" }),
      }
    )
  }

  const handleUpdate = (values: FormState) => {
    if (!editing) return
    updateCampaign.mutate(
      { campaignId: editing.id, data: buildPayload(values) },
      {
        onSuccess: () => {
          invalidateCampaigns()
          toast({ title: "Campaign updated" })
          setEditing(null)
        },
        onError: () => toast({ title: "Failed to update campaign", variant: "destructive" }),
      }
    )
  }

  const handleDelete = () => {
    if (!deleting) return
    deleteCampaign.mutate(
      { campaignId: deleting.id },
      {
        onSuccess: () => {
          invalidateCampaigns()
          toast({ title: "Campaign deleted" })
          setDeleting(null)
        },
        onError: () => toast({ title: "Failed to delete campaign", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">Manage your broadcast and automated outreach campaigns.</p>
        </div>
        <Button className="gap-2" data-testid="button-new-campaign" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New Campaign
        </Button>
      </div>

      <Card>
        <div className="p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search campaigns..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search-campaigns"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Performance</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading campaigns...</TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No campaigns found.</TableCell>
              </TableRow>
            )}
            {filtered.map((camp) => {
              const statusVariant = campaignStatusVariant(camp.status) as any
              const canPlan = canPlanCampaign(camp.status)
              const canExecute = canExecuteCampaign(camp.status)

              const deliveryRate = camp.sent > 0 ? ((camp.delivered / camp.sent) * 100).toFixed(1) : "0.0"
              const readRate = camp.delivered > 0 ? ((camp.read / camp.delivered) * 100).toFixed(1) : "0.0"

              return (
                <TableRow key={camp.id} className="group" data-testid={`row-campaign-${camp.id}`}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {camp.name}
                      {camp.isSample && (
                        <Badge variant="outline" className="gap-1 text-[10px] py-0 h-5">
                          <Sparkles className="h-2.5 w-2.5" /> Sample
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 font-mono">{camp.routesCount} routes</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant}>{camp.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono">{formatNumber(camp.audienceSize)}</TableCell>
                  <TableCell className="font-mono">
                    {formatNumber(camp.sent)}
                    {camp.failed > 0 && <span className="text-destructive text-xs ml-2">({formatNumber(camp.failed)} fail)</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-xs">
                      <div className="flex justify-between w-24">
                        <span className="text-muted-foreground">Delivered:</span>
                        <span className="font-mono">{deliveryRate}%</span>
                      </div>
                      <div className="flex justify-between w-24">
                        <span className="text-muted-foreground">Read:</span>
                        <span className="font-mono">{readRate}%</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {camp.schedule}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" data-testid={`button-campaign-actions-${camp.id}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canPlan && (
                          <DropdownMenuItem
                            disabled={isActioning}
                            onClick={() => handleAction(camp, "plan")}
                            data-testid={`button-plan-campaign-${camp.id}`}
                          >
                            {isActioningAs(camp.id, "plan") ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Rocket className="mr-2 h-4 w-4" />
                            )}
                            {camp.status === "Ready" ? "Re-plan" : "Plan"}
                          </DropdownMenuItem>
                        )}
                        {canExecute && (
                          <DropdownMenuItem
                            disabled={isActioning}
                            onClick={() => handleAction(camp, "execute")}
                            data-testid={`button-execute-campaign-${camp.id}`}
                          >
                            {isActioningAs(camp.id, "execute") ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <PlayCircle className="mr-2 h-4 w-4" />
                            )}
                            Execute
                          </DropdownMenuItem>
                        )}
                        {canPauseCampaign(camp.status) && (
                          <DropdownMenuItem
                            disabled={isActioning}
                            onClick={() => handleAction(camp, "pause")}
                            data-testid={`button-pause-campaign-${camp.id}`}
                          >
                            {isActioningAs(camp.id, "pause") ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <PauseCircle className="mr-2 h-4 w-4" />
                            )}
                            Pause
                          </DropdownMenuItem>
                        )}
                        {canResumeCampaign(camp.status) && (
                          <DropdownMenuItem
                            disabled={isActioning}
                            onClick={() => handleAction(camp, "resume")}
                            data-testid={`button-resume-campaign-${camp.id}`}
                          >
                            {isActioningAs(camp.id, "resume") ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <PlayCircle className="mr-2 h-4 w-4" />
                            )}
                            Resume
                          </DropdownMenuItem>
                        )}
                        {canCancelCampaign(camp.status) && (
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={isActioning}
                            onClick={() => setCancelling(camp)}
                            data-testid={`button-cancel-campaign-${camp.id}`}
                          >
                            <XCircle className="mr-2 h-4 w-4" /> Cancel
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => setConfiguringTemplates(camp)}
                          data-testid={`button-configure-templates-${camp.id}`}
                        >
                          <ListChecks className="mr-2 h-4 w-4" /> Templates &amp; Variables
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setViewingPlan(camp)}
                          data-testid={`button-view-plan-${camp.id}`}
                        >
                          <Eye className="mr-2 h-4 w-4" /> What Will Send
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setViewingMessages(camp)}
                          data-testid={`button-view-messages-${camp.id}`}
                        >
                          <ServerCog className="mr-2 h-4 w-4" /> Delivery Log
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditing(camp)} data-testid={`button-edit-campaign-${camp.id}`}>
                          <Pencil className="mr-2 h-4 w-4" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleting(camp)}
                          data-testid={`button-delete-campaign-${camp.id}`}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      <CampaignFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={emptyForm}
        onSubmit={handleCreate}
        isSubmitting={createCampaign.isPending}
        title="New Campaign"
      />

      {editing && (
        <CampaignFormDialog
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
          initial={{
            name: editing.name,
            status: editing.status,
            audienceSize: String(editing.audienceSize),
            sent: String(editing.sent),
            delivered: String(editing.delivered),
            read: String(editing.read),
            failed: String(editing.failed),
            schedule: editing.schedule,
          }}
          onSubmit={handleUpdate}
          isSubmitting={updateCampaign.isPending}
          title="Edit Campaign"
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deleting?.name} and any campaign routes attached to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-confirm-delete-campaign">
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

      <TemplateMappingDialog
        campaign={configuringTemplates}
        organizationId={activeOrg?.id}
        open={!!configuringTemplates}
        onOpenChange={(open) => !open && setConfiguringTemplates(null)}
      />

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
    </div>
  )
}

type FormState = {
  name: string
  status: CampaignInputStatus
  audienceSize: string
  sent: string
  delivered: string
  read: string
  failed: string
  schedule: string
}

const emptyForm: FormState = {
  name: "",
  status: "Draft",
  audienceSize: "0",
  sent: "0",
  delivered: "0",
  read: "0",
  failed: "0",
  schedule: "Unscheduled",
}
