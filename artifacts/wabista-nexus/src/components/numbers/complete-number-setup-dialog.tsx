import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Lock, MessageSquareText, PhoneCall, ShieldCheck } from "lucide-react"
import {
  getListPhoneNumbersQueryKey,
  useRegisterWhatsAppPhone,
  useRequestWhatsAppPhoneVerificationCode,
  useVerifyWhatsAppPhoneCode,
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

// V2-02B guided setup: Verify → Enter code → Set PIN → Registered.
//
// Two different secrets pass through this dialog and the copy keeps them
// apart on purpose:
//   - the verification code Meta sends to the phone (SMS or voice call);
//   - the 6-digit registration PIN the person chooses.
// Both live only in component state, are cleared when a request settles
// or the dialog closes, and are never stored in the browser or a URL.
// There is no access-token field here: the server uses the credential
// already associated with the number.
//
// After registration the number is NOT ready to send. Wabista sending
// activation (V2-02C) is the final step and the UI says so.

type Step = "verify" | "enter_code" | "register" | "done" | "reconnect"

function initialStep(phone: PhoneNumber | null): Step {
  if (!phone) return "verify"
  if (!phone.credentialId) return "reconnect"
  const state = phone.setupState ?? "unknown"
  // action_required means the server found the credential unusable (for
  // example Meta rejected the stored token). Sending the person back to
  // SMS/voice would just fail again; the way forward is to reconnect.
  if (state === "action_required") return "reconnect"
  if (state === "registered_transport_pending" || state === "active") return "done"
  if (state === "registration_required" || phone.providerMetadata?.verificationStatus === "VERIFIED") return "register"
  if (state === "verification_code_sent") return "enter_code"
  return "verify"
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
  const requestCode = useRequestWhatsAppPhoneVerificationCode()
  const verify = useVerifyWhatsAppPhoneCode()
  const register = useRegisterWhatsAppPhone()

  const [step, setStep] = useState<Step>("verify")
  const [code, setCode] = useState("")
  const [pin, setPin] = useState("")
  const [pinConfirm, setPinConfirm] = useState("")
  const [failure, setFailure] = useState<ReturnType<typeof describeApiError> | null>(null)
  const [lastMethod, setLastMethod] = useState<"SMS" | "VOICE" | null>(null)

  const open = phone !== null
  useEffect(() => {
    setStep(initialStep(phone))
    setCode("")
    setPin("")
    setPinConfirm("")
    setFailure(null)
    setLastMethod(null)
    requestCode.reset()
    verify.reset()
    register.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone?.id, open])

  const busy = requestCode.isPending || verify.isPending || register.isPending
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
    if (result.setupState === "verification_code_sent") setStep("enter_code")
    else if (result.setupState === "registration_required") setStep("register")
    else if (result.setupState === "registered_transport_pending") setStep("done")
  }

  const sendCode = (method: "SMS" | "VOICE") => {
    if (!organizationId || !phone) return
    setFailure(null)
    setLastMethod(method)
    requestCode.mutate(
      { organizationId, phoneNumberId: phone.id, data: { method } },
      {
        onSuccess: (result) => {
          setCode("")
          applyResult(result)
          toast({ title: method === "SMS" ? "Code sent by SMS" : "Meta is calling you with the code" })
        },
        onError: (error) => fail(error, "Couldn't send the verification code."),
      },
    )
  }

  const submitCode = () => {
    if (!organizationId || !phone || !/^\d+$/.test(code)) return
    setFailure(null)
    verify.mutate(
      { organizationId, phoneNumberId: phone.id, data: { code } },
      {
        onSuccess: (result) => {
          setCode("")
          applyResult(result)
        },
        onError: (error) => {
          setCode("")
          fail(error, "That verification code was not accepted.")
        },
      },
    )
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

        {step === "verify" ? (
          <div className="space-y-4" data-testid="setup-step-verify">
            <div>
              <h3 className="text-sm font-medium">Verify phone number</h3>
              <p className="mt-1 text-sm text-muted-foreground">Meta needs to confirm that you control this phone number.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="button" className="gap-2" disabled={busy} onClick={() => sendCode("SMS")} data-testid="button-send-sms-code">
                <MessageSquareText className="h-4 w-4" />
                {requestCode.isPending && lastMethod === "SMS" ? "Sending…" : "Send SMS code"}
              </Button>
              <Button type="button" variant="outline" className="gap-2" disabled={busy} onClick={() => sendCode("VOICE")} data-testid="button-send-voice-code">
                <PhoneCall className="h-4 w-4" />
                {requestCode.isPending && lastMethod === "VOICE" ? "Calling…" : "Call me with code"}
              </Button>
            </div>
          </div>
        ) : null}

        {step === "enter_code" ? (
          <form
            className="space-y-4"
            data-testid="setup-step-enter-code"
            onSubmit={(e) => {
              e.preventDefault()
              submitCode()
            }}
          >
            <div>
              <h3 className="text-sm font-medium">Verification code</h3>
              <p className="mt-1 text-sm text-muted-foreground">Enter the code Meta sent to this phone number.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="setup-code">Code</Label>
              <Input
                id="setup-code"
                data-testid="input-verification-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                autoFocus
                required
              />
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <div className="flex gap-3 text-xs">
                <button type="button" className="text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50" disabled={busy} onClick={() => sendCode("SMS")} data-testid="button-resend-sms">
                  Resend by SMS
                </button>
                <button type="button" className="text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50" disabled={busy} onClick={() => sendCode("VOICE")} data-testid="button-use-voice">
                  Use voice instead
                </button>
              </div>
              <Button type="submit" disabled={busy || !/^\d+$/.test(code)} data-testid="button-verify-code">
                {verify.isPending ? "Checking…" : "Verify code"}
              </Button>
            </DialogFooter>
          </form>
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
                This is a 6-digit PIN you choose. Meta uses it for two-step verification.
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
  { key: "verify", label: "Verify" },
  { key: "enter_code", label: "Enter code" },
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
