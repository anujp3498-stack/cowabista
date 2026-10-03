import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { Campaign } from "@workspace/api-client-react"
import { CampaignPlanPanel } from "./campaign-plan-panel"

// Legacy dialog wrapper (still used by the Rocket page). The content lives
// in CampaignPlanPanel, shared with the campaign detail Details tab.
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-3xl" data-testid="dialog-campaign-plan">
        <DialogHeader>
          <DialogTitle>What will send — {campaign?.name}</DialogTitle>
          <DialogDescription>
            Read-only view of the campaign's frozen plan: the senders, templates, and variable mappings locked in
            when it was planned, and exactly what any one contact will receive.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-3">
          <CampaignPlanPanel organizationId={organizationId} campaignId={campaign?.id} active={open} />
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-close-campaign-plan">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
