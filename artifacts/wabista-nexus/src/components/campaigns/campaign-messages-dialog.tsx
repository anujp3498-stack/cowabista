import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { Campaign } from "@workspace/api-client-react"
import { CampaignMessagesPanel } from "./campaign-messages-panel"

// Legacy dialog wrapper (still used by the Rocket page). The content lives
// in CampaignMessagesPanel, shared with the campaign detail Messages tab.
export function CampaignMessagesDialog({
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
      <DialogContent className="max-w-2xl sm:max-w-3xl" data-testid="dialog-campaign-messages">
        <DialogHeader>
          <DialogTitle>Delivery log — {campaign?.name}</DialogTitle>
          <DialogDescription>
            Per-recipient send status, retry attempts, and provider errors, straight from the send queue.
          </DialogDescription>
        </DialogHeader>
        <CampaignMessagesPanel organizationId={organizationId} campaignId={campaign?.id} active={open} compact />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-close-campaign-messages">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
