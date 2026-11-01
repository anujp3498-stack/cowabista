import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Gauge, Loader2 } from "lucide-react"
import {
  getCampaign,
  getGetDeliverySetupQueryKey,
  transitionCampaign,
  useGetDeliverySetup,
  type Campaign,
  type CampaignActionInput,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useToast } from "@/hooks/use-toast"
import { invalidateCampaignQueries } from "@/lib/campaign-queries"
import { messageFrom } from "@/lib/api-errors"
import { cn } from "@/lib/utils"
import { deliveryDraftFrom, deliveryPayload, plannedTotal, rateHint, SPEED_OPTIONS, type DeliveryDraft, type SpeedChoice } from "@/lib/delivery-model"
import { runSpeedChange } from "@/lib/speed-change-model"
import { errorCodeOf } from "@/lib/message-studio-model"

// Rocket "Change speed" while a campaign runs: the new speed (a preset or
// each number's own messages/sec) is validated by the server's delivery
// resolver and applied to every message not yet sent, through the safe
// pause -> adjust-speed -> resume sequence (lib/speed-change-model.ts).

export function SpeedChangeDialog({ campaign, organizationId, open, onOpenChange }: { campaign: Campaign; organizationId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const setupQuery = useGetDeliverySetup(organizationId, campaign.id, { query: { enabled: open } as never })
  const setup = setupQuery.data
  const [draft, setDraft] = useState<DeliveryDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) { setDraft(null); setError(null); return }
    if (setup && draft === null) {
      const start = deliveryDraftFrom(setup)
      setDraft({ ...start, deliveryMode: (start.deliveryMode ?? "advanced") as SpeedChoice })
    }
  }, [open, setup, draft])

  const hints = draft?.deliveryMode === "advanced" && setup ? setup.senders.map((sender) => rateHint(draft.rates[String(sender.phoneNumberId)], sender.effectiveCeiling)) : []
  const total = draft && setup ? plannedTotal(draft, setup, true) : null
  const valid = Boolean(draft?.deliveryMode) && hints.every((hint) => hint === null)

  const apply = async () => {
    if (!draft || !setup || !draft.deliveryMode) return
    setBusy(true)
    setError(null)
    // The same body shape the Delivery step saves; adjust-speed takes the
    // mode and (for Advanced) the per-number rates.
    const payload = deliveryPayload({ ...draft, distributionMode: draft.distributionMode ?? "equal_numbers" }, setup, setup.revision)
    const adjust: CampaignActionInput = { action: "adjust-speed", deliveryMode: payload.deliveryMode, ...(payload.deliverySettings ? { deliverySettings: payload.deliverySettings } : {}) }
    // Decide the steps from the campaign's CURRENT status (never the cached
    // page data: it may have been paused or finished since the page loaded).
    let current: Campaign
    try {
      current = await getCampaign(campaign.id)
    } catch (failure) {
      setBusy(false)
      setError(messageFrom(failure, "Couldn't read the campaign's current status. Nothing was changed."))
      return
    }
    if (current.distributionMode == null) {
      setBusy(false)
      setError("This campaign was launched without a distribution, so its speed cannot be changed while it runs. Nothing was changed.")
      return
    }
    const outcome = await runSpeedChange(
      current.status,
      // pause and resume carry purpose speed_change: the server then refuses
      // the resume if anyone paused the campaign in the meantime.
      (action) => transitionCampaign(organizationId, campaign.id, action === "adjust-speed" ? adjust : { action, purpose: "speed_change" }),
      (failure) => messageFrom(failure, "The request was refused."),
      errorCodeOf,
    )
    await Promise.all([
      invalidateCampaignQueries(queryClient, organizationId, campaign.id),
      queryClient.invalidateQueries({ queryKey: getGetDeliverySetupQueryKey(organizationId, campaign.id) }),
    ])
    setBusy(false)
    if (outcome.ok) {
      toast({ title: outcome.message })
      onOpenChange(false)
    } else {
      setError(outcome.message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="dialog-change-speed">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Gauge className="h-4 w-4" aria-hidden="true" /> Change speed</DialogTitle>
          <DialogDescription>
            {campaign.status === "Running"
              ? "Rocket pauses the campaign for a moment, applies the new speed to every message not sent yet, and resumes it. Messages already on their way are not affected."
              : "The new speed applies to every message not sent yet. The campaign stays paused until you resume it."}
          </DialogDescription>
        </DialogHeader>
        {!setup || !draft ? (
          setupQuery.isError ? <p className="text-sm text-destructive">Couldn't load the current speed.</p> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the current speed...</p>
        ) : (
          <div className="space-y-4">
            <RadioGroup value={draft.deliveryMode ?? ""} onValueChange={(value) => setDraft({ ...draft, deliveryMode: value as SpeedChoice })} className="grid gap-2 sm:grid-cols-2" aria-label="Speed" disabled={busy}>
              {SPEED_OPTIONS.map((option) => (
                <Label key={option.value} htmlFor={`live-speed-${option.value}`} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal", draft.deliveryMode === option.value && "border-primary bg-primary/5")} data-testid={`live-speed-${option.value}`}>
                  <RadioGroupItem id={`live-speed-${option.value}`} value={option.value} className="mt-0.5" />
                  <span><span className="block font-medium">{option.title}</span><span className="block text-xs text-muted-foreground">{option.description}</span></span>
                </Label>
              ))}
            </RadioGroup>
            {draft.deliveryMode === "advanced" ? (
              <ul className="divide-y rounded-md border" data-testid="live-speed-rates">
                {setup.senders.map((sender, index) => {
                  const key = String(sender.phoneNumberId)
                  return (
                    <li key={sender.phoneNumberId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{sender.displayName || sender.phone}</p>
                        <p className="text-xs text-muted-foreground">Up to {sender.effectiveCeiling ?? "?"} messages/sec</p>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Input aria-label={`Speed for ${sender.displayName || sender.phone}`} inputMode="numeric" className="w-24" value={draft.rates[key] ?? ""} disabled={busy}
                            onChange={(event) => setDraft({ ...draft, rates: { ...draft.rates, [key]: event.target.value } })} data-testid={`live-rate-${sender.phoneNumberId}`} />
                          <span className="text-xs text-muted-foreground">messages/sec</span>
                        </div>
                        {hints[index] ? <p className="text-xs text-destructive">{hints[index]}</p> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            <p className="text-sm text-muted-foreground" data-testid="live-speed-total">New total: {total === null ? "—" : `${total} messages/sec`}</p>
          </div>
        )}
        {error ? (
          <Alert variant="destructive" data-testid="alert-change-speed">
            <AlertTitle>Speed change incomplete</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
          <Button onClick={() => void apply()} disabled={busy || !valid || !setup} className="gap-2" data-testid="button-apply-speed">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gauge className="h-4 w-4" />} Apply new speed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
