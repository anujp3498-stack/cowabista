import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"
import type { NotReadyState } from "@/hooks/use-campaign-lifecycle"

export function CampaignNotReadyDialog({
  notReady,
  onClose,
}: {
  notReady: NotReadyState | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!notReady} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="dialog-campaign-not-ready">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {notReady?.name} isn't ready to {notReady?.action === "execute" ? "execute" : "plan"}
          </DialogTitle>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {notReady?.errors.map((error, i) => (
            <li key={i} className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-destructive" data-testid={`text-readiness-error-${i}`}>
              <span className="mt-0.5">•</span>
              <span>{error}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-close-not-ready">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
