import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
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
import { useCreateCampaign, useUpdateCampaign, type Campaign } from "@workspace/api-client-react"
import { useToast } from "@/hooks/use-toast"
import { messageFrom } from "@/lib/api-errors"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"

// The only campaign fields a person edits by hand: the name and a free-text
// schedule label. Status and the sent/delivered/read/failed counters are
// runtime state owned by the engine and are never offered as inputs here
// (the backend also refuses status changes outside the actions endpoint).
export function CampaignEditDialog({
  campaign,
  open,
  onOpenChange,
  organizationId,
  onCreated,
}: {
  /** Null creates a new draft; otherwise edits this campaign. */
  campaign: Campaign | null
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: number | undefined
  onCreated?: (campaign: Campaign) => void
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const createCampaign = useCreateCampaign()
  const updateCampaign = useUpdateCampaign()
  const [name, setName] = useState("")
  const [schedule, setSchedule] = useState("Unscheduled")

  useEffect(() => {
    if (open) {
      setName(campaign?.name ?? "")
      setSchedule(campaign?.schedule ?? "Unscheduled")
    }
  }, [open, campaign])

  const isPending = createCampaign.isPending || updateCampaign.isPending
  const isEdit = campaign !== null

  const submit = () => {
    const payload = { name: name.trim(), schedule: schedule.trim() || "Unscheduled" }
    if (!payload.name) return
    if (isEdit) {
      updateCampaign.mutate(
        { campaignId: campaign.id, data: payload },
        {
          onSuccess: () => {
            void invalidateCampaignQueries(queryClient, organizationId, campaign.id)
            toast({ title: "Campaign updated" })
            onOpenChange(false)
          },
          onError: (error) => toast({ title: messageFrom(error, "Failed to update campaign"), variant: "destructive" }),
        },
      )
    } else {
      createCampaign.mutate(
        { data: payload },
        {
          onSuccess: (created) => {
            void invalidateCampaignQueries(queryClient, organizationId)
            toast({ title: "Campaign created" })
            onOpenChange(false)
            onCreated?.(created)
          },
          onError: (error) => toast({ title: messageFrom(error, "Failed to create campaign"), variant: "destructive" }),
        },
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit campaign" : "New campaign"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Change the name or schedule label. Sending settings live in Setup."
              : "Give the campaign a name. You'll add recipients, senders and templates next."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="camp-name">Campaign name</Label>
            <Input id="camp-name" data-testid="input-campaign-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="camp-schedule">Schedule label</Label>
            <Input
              id="camp-schedule"
              data-testid="input-campaign-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="Unscheduled, Continuous, or a date"
            />
            <p className="text-xs text-muted-foreground">A note for your team. Timed sending is set when you schedule the campaign.</p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isPending || !name.trim()} data-testid="button-submit-campaign">
              {isPending ? "Saving…" : isEdit ? "Save changes" : "Create campaign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
