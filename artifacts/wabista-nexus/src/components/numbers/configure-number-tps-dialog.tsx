import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getListPhoneNumbersQueryKey,
  useSyncWhatsAppPhoneThroughput,
  useUpdatePhoneNumber,
  type PhoneNumber,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { messageFrom } from "@/lib/api-errors"
import { useToast } from "@/hooks/use-toast"

function knownMetaCap(phone: PhoneNumber): number | null {
  const cap = phone.providerMetadata?.approvedTpsLimit
  return typeof cap === "number" && Number.isInteger(cap) && cap > 0 && cap <= 1000 ? cap : null
}

export function ConfigureNumberTpsDialog({
  phone, organizationId, canSyncMeta, onOpenChange,
}: {
  phone: PhoneNumber | null
  organizationId: number | undefined
  canSyncMeta: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const update = useUpdatePhoneNumber()
  const sync = useSyncWhatsAppPhoneThroughput()
  const [raw, setRaw] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [latest, setLatest] = useState<PhoneNumber | null>(null)
  useEffect(() => {
    setLatest(null)
    setRaw(phone ? String(phone.tpsLimit) : "")
    setError(null)
  }, [phone?.id])

  const current = phone && latest?.id === phone.id ? latest : phone
  const approved = current ? knownMetaCap(current) : null
  const ceiling = current ? (approved ?? current.tpsLimit) : null
  const tier = current?.providerMetadata?.throughputLevel
  const rate = Number(raw)
  const valid = ceiling !== null && /^\d+$/.test(raw) && Number.isSafeInteger(rate) && rate >= 1 && rate <= ceiling
  const busy = update.isPending || sync.isPending
  const canRefresh = Boolean(canSyncMeta && current?.credentialId && current?.providerPhoneId && current?.setupState === "active")

  const save = () => {
    if (!current || !valid || !organizationId || busy) return
    setError(null)
    update.mutate({ phoneNumberId: current.id, data: { tpsLimit: rate } }, {
      onSuccess: (saved) => {
        setLatest(saved)
        setRaw(String(saved.tpsLimit))
        void queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })
        toast({ title: "Sender TPS saved", description: `${saved.displayName}: ${saved.tpsLimit} TPS for future campaign plans.` })
        onOpenChange(false)
      },
      onError: (failure) => setError(messageFrom(failure, "Could not save sender TPS.")),
    })
  }

  const refresh = () => {
    if (!current || !organizationId || !canRefresh || busy) return
    setError(null)
    sync.mutate({ organizationId, phoneNumberId: current.id }, {
      onSuccess: (saved) => {
        setLatest(saved)
        setRaw(String(saved.tpsLimit))
        void queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })
        toast({ title: "Meta throughput synchronized", description: `Approved ${knownMetaCap(saved) ?? "unknown"} TPS; configured ${saved.tpsLimit} TPS.` })
      },
      onError: (failure) => setError(messageFrom(failure, "Meta throughput sync failed.")),
    })
  }

  return (
    <Dialog open={phone !== null} onOpenChange={(open) => { if (!busy) onOpenChange(open) }}>
      <DialogContent className="sm:max-w-md" data-testid="configure-number-tps-dialog">
        <DialogHeader>
          <DialogTitle>Configure sender TPS</DialogTitle>
          <DialogDescription>{current?.displayName ?? "Number"} · {current?.phone ?? ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Meta throughput</div>
              <div className="font-medium" data-testid="number-tps-meta-tier">{approved === null ? "Not verified" : `${typeof tier === "string" ? tier : "Approved"} · ${approved} TPS`}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Current setting</div>
              <div className="font-medium" data-testid="number-tps-current">{current?.tpsLimit ?? "—"} TPS</div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="configured-number-tps">Sender TPS</Label>
            <Input id="configured-number-tps" data-testid="configured-number-tps" type="number" min={1} max={ceiling ?? undefined} step={1}
              inputMode="numeric" value={raw} disabled={busy} aria-invalid={!valid}
              onChange={(event) => setRaw(event.target.value)} />
            <p className="text-xs text-muted-foreground" data-testid="number-tps-cap-note">
              {approved !== null ? `Meta-approved maximum: ${approved} TPS.` : `Current allowed maximum: ${ceiling ?? "—"} TPS. Refresh from Meta to verify a higher capacity.`}
              {" "}Normal and Rocket campaigns use this sender cap when planning; Rocket may choose a lower per-campaign speed.
            </p>
          </div>
          {canRefresh ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={refresh} data-testid="button-refresh-meta-tps">
              {sync.isPending ? "Checking Meta…" : "Refresh Meta TPS"}
            </Button>
          ) : approved === null ? (
            <p className="text-xs text-muted-foreground">Meta sync is available after this number has a verified, active workspace connection. No provider tier is assumed.</p>
          ) : null}
          {error ? <p className="text-sm text-destructive" role="alert" data-testid="number-tps-error">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)} data-testid="button-close-number-tps">Cancel</Button>
          <Button type="button" disabled={busy || !valid || Number(current?.tpsLimit) === rate} onClick={save} data-testid="button-save-number-tps">
            {update.isPending ? "Saving…" : "Save TPS"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
