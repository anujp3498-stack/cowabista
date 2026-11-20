import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Lock, ShieldCheck } from "lucide-react"
import {
  getListPhoneNumbersQueryKey,
  useRegisterWhatsAppPhone,
  type PhoneNumber,
  type WhatsAppPhoneSetupResult,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TechnicalDetails } from "@/components/app"
import { useToast } from "@/hooks/use-toast"
import { describeApiError } from "@/lib/api-errors"

// Phone ownership verification is performed outside Wabista in Meta's onboarding.
// This dialog only registers Meta-VERIFIED numbers with their 6-digit PIN.
// It must never bypass the server-side verification guard. Activation remains
// a separate explicit step after registration.

type Step = "meta_verification_required" | "register" | "done" | "reconnect"

function initialStep(phone: PhoneNumber | null): Step {
  if (!phone) return "meta_verification_required"
  if (!phone.credentialId) return "reconnect"
  const state = phone.setupState ?? "unknown"
  if (state === "action_required") return "reconnect"
  if (state === "registered_transport_pending" || state === "active") return "done"
  if (state === "registration_required" || phone.providerMetadata?.verificationStatus === "VERIFIED") return "register"
  return "meta_verification_required"
}

export function CompleteNumberSetupDialog({
  phone,
  organizationId,
  onOpenChange,
}: {
  phone: PhoneNumber | null
  organizationId: number | undefined
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const register = useRegisterWhatsAppPhone()

  const [step, setStep] = useState<Step>("meta_verification_required")
  const [pin, setPin] = useState("")
  const [pinConfirm, setPinConfirm] = useState("")
  const [failure, setFailure] = useState<ReturnType<typeof describeApiError> | null>(null)

  const open = phone !== null
  useEffect(() => {
    setStep(initialStep(phone))
    setPin("")
    setPinConfirm("")
    setFailure(null)
    register.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone?.id, open])

  const busy = register.isPending
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })

  const fail = (error: unknown, fallback: string) => {
    const described = describeApiError(error, fallback)
    setFailure(described)
    const errorCode = (described.raw as { code?: string } | null)?.code
    if (errorCode === "credential_inactive") setStep("reconnect")
    if (errorCode === "state_conflict") void refresh()
  }

  const applyResult = (result: WhatsAppPhoneSetupResult) => {
    void refresh()
    if (result.setupState === "registered_transport_pending") setStep("done")
  }

  const pinValid = /^\d{6}$/.test(pin)
  const pinsMatch = pin === pinConfirm
  const submitPin = () => {
    if (!organizationId || !phone || !pinValid || !pinsMatch) return
    setFailure(null)
    register.mutate(
      { organizationId, phoneNumberId: phone.id, data: { pin } },
      {
        onSuccess: (result) => {
          setPin("")
          setPinConfirm("")
          applyResult(result)
          toast({ title: "Registered with Meta", description: "Wabista sending activation is the final step." })
        },
        onError: (error) => {
          setPin("")
          setPinConfirm("")
          fail(error, "Meta did not accept the registration.")
        },
      },
    )
  }

  const title = phone ? `Complete setup — ${phone.displayName}` : "Complete setup"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {phone ? <span className="font-mono">{phone.phone}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <StepTrail step={step} />

        {failure ? (
          <Alert variant="destructive" data-testid="alert-setup-error">
            <AlertTitle>That didn't work</AlertTitle>
            <AlertDescription>
              <p>{failure.message}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {step === "reconnect" ? (
          <div className="space-y-3" data-testid="setup-step-reconnect">
            <p className="text-sm">Reconnect this number to continue setup.</p>
            <p className="text-xs text-muted-foreground">
              The credential connected to this number is no longer active. Use Connect number, then Connect manually, to connect it again.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === "meta_verification_required" ? (
          <div className="space-y-4" data-testid="setup-step-meta-verification-required">
            <Alert>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Verify this number in Meta first</AlertTitle>
              <AlertDescription>
                This phone is not yet marked VERIFIED by Meta. Complete phone ownership
                verification in Meta Business Manager / WhatsApp Manager, then use
                Connect number → Connect manually again to refresh its status in Wabista.
                This Wabista setup screen no longer sends or accepts SMS/voice verification codes.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === "register" ? (
          <form
            className="space-y-4"
            data-testid="setup-step-register"
            onSubmit={(e) => {
              e.preventDefault()
              submitPin()
            }}
          >
            <div>
              <h3 className="text-sm font-medium">Set registration PIN</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                If this number already has a Meta two-step verification PIN, enter that existing PIN. Otherwise choose a new 6-digit PIN. This does not verify phone ownership.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="setup-pin">PIN</Label>
                <Input
                  id="setup-pin"
                  data-testid="input-registration-pin"
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  autoFocus
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="setup-pin-confirm">Confirm PIN</Label>
                <Input
                  id="setup-pin-confirm"
                  data-testid="input-registration-pin-confirm"
                  type="password"
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  required
                />
              </div>
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className={pinValid ? "text-foreground" : undefined}>Exactly 6 digits</li>
              <li className={pinValid && pinsMatch ? "text-foreground" : undefined}>Both entries match</li>
            </ul>
            <Alert>
              <Lock className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Save this PIN securely.</AlertTitle>
              <AlertDescription>Wabista does not store it. You will need it again if you move this number.</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="submit" disabled={busy || !pinValid || !pinsMatch} data-testid="button-register-number">
                {register.isPending ? "Registering…" : "Register number"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === "done" ? (
          <div className="space-y-4" data-testid="setup-step-done">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-medium">Registered with Meta</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Registration complete. Activate sending to let campaigns use this number.
                </p>
              </div>
            </div>
            <Alert>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Not sending yet</AlertTitle>
              <AlertDescription>This number is not used by campaigns until you activate sending from the Numbers page.</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)} data-testid="button-setup-close">Done</Button>
            </DialogFooter>
          </div>
        ) : null}

        {failure ? (
          <TechnicalDetails
            fields={[
              { label: "HTTP status", value: failure.status },
              { label: "Error code", value: (failure.raw as { code?: string } | null)?.code ?? null, copyable: true },
              { label: "Provider code", value: ((failure.raw as { details?: { providerCode?: string } } | null)?.details?.providerCode) ?? null },
            ]}
            data-testid="technical-setup-error"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const TRAIL: Array<{ key: Step; label: string }> = [
  { key: "meta_verification_required", label: "Meta verification" },
  { key: "register", label: "Set PIN" },
  { key: "done", label: "Registered" },
]

function StepTrail({ step }: { step: Step }) {
  if (step === "reconnect") return null
  const index = TRAIL.findIndex((item) => item.key === step)
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Setup progress">
      {TRAIL.map((item, i) => (
        <li
          key={item.key}
          className={
            i < index
              ? "rounded-full bg-primary/10 px-2 py-0.5 text-primary"
              : i === index
                ? "rounded-full bg-primary px-2 py-0.5 text-primary-foreground"
                : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
          }
          aria-current={i === index ? "step" : undefined}
        >
          {item.label}
        </li>
      ))}
    </ol>
  )
}
