import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Lock, ShieldCheck } from "lucide-react"
import {
  getListPhoneNumbersQueryKey,
  getListWhatsAppCredentialsQueryKey,
  useConnectManualWhatsAppNumber,
  type ManualWhatsAppConnectResult,
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

// V2-02A connect flow. Two ways in:
//  - "Connect with Meta" (Embedded Signup) is shown but clearly unavailable:
//    it is a later milestone and we never pretend a button works.
//  - "Connect manually" takes a phone number, an access token and (when the
//    server asks for it) the WABA ID.
//
// The token lives in component state only while the dialog is open and is
// cleared the moment a request settles or the dialog closes. It is never
// written to localStorage/sessionStorage, never put in a URL and never shown
// back once submitted.

type Step = "choose" | "manual"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: number | undefined
  onConnected?: (result: ManualWhatsAppConnectResult) => void
}

export function ConnectNumberDialog({ open, onOpenChange, organizationId, onConnected }: Props) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const connect = useConnectManualWhatsAppNumber()

  const [step, setStep] = useState<Step>("choose")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [accessToken, setAccessToken] = useState("")
  const [wabaId, setWabaId] = useState("")
  const [needsWaba, setNeedsWaba] = useState(false)
  const [failure, setFailure] = useState<ReturnType<typeof describeApiError> | null>(null)

  const reset = () => {
    setStep("choose")
    setPhoneNumber("")
    setAccessToken("")
    setWabaId("")
    setNeedsWaba(false)
    setFailure(null)
    connect.reset()
  }

  useEffect(() => {
    if (!open) reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const canSubmit = Boolean(organizationId) && phoneNumber.trim().length > 0 && accessToken.trim().length > 0 && (!needsWaba || wabaId.trim().length > 0)

  const submit = () => {
    if (!organizationId || !canSubmit) return
    setFailure(null)
    const token = accessToken
    connect.mutate(
      {
        organizationId,
        data: { phoneNumber: phoneNumber.trim(), accessToken: token, wabaId: wabaId.trim() || null },
      },
      {
        onSuccess: (result) => {
          if (result.outcome === "waba_id_required") {
            // Token was valid; keep it in memory so the person only has to
            // add the WABA ID, but do not persist it anywhere.
            setNeedsWaba(true)
            return
          }
          setAccessToken("")
          void queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })
          void queryClient.invalidateQueries({ queryKey: getListWhatsAppCredentialsQueryKey(organizationId) })
          toast({ title: "WhatsApp number discovered", description: "It still needs verification before it can send." })
          onConnected?.(result)
          onOpenChange(false)
        },
        onError: (error) => {
          // Any rejection clears the token from memory; the person pastes it
          // again if they want to retry.
          setAccessToken("")
          const described = describeApiError(error, "Couldn't connect this number.")
          setFailure(described)
          const code = (described.raw as { code?: string } | null)?.code
          if (code === "waba_denied" || code === "phone_not_found") setNeedsWaba(true)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {step === "choose" ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect a WhatsApp number</DialogTitle>
              <DialogDescription>Choose how to bring a number into this workspace.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="rounded-lg border p-4 opacity-70" aria-disabled="true" data-testid="option-connect-meta">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Connect with Meta</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Sign in to Meta and pick a number. Not available yet in this workspace.
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled data-testid="button-connect-meta">
                    Coming soon
                  </Button>
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border p-4 text-left transition-colors hover:bg-muted"
                onClick={() => setStep("manual")}
                data-testid="option-connect-manual"
              >
                <p className="text-sm font-medium">Connect manually</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste a Meta access token and the number you want to use. Best for teams that already manage their own WhatsApp Business Account.
                </p>
              </button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Connect manually</DialogTitle>
              <DialogDescription>
                We check the token with Meta, find your number and save it here. Nothing is saved until every check passes.
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
                <Label htmlFor="connect-phone">Phone number</Label>
                <Input
                  id="connect-phone"
                  data-testid="input-connect-phone"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+1 555 019 2831"
                  inputMode="tel"
                  autoComplete="off"
                  required
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">Include the country code.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="connect-token">Access token</Label>
                <Input
                  id="connect-token"
                  data-testid="input-connect-token"
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  Stored encrypted. We never show it again.
                </p>
              </div>
              {needsWaba ? (
                <div className="grid gap-2">
                  <Label htmlFor="connect-waba">WhatsApp Business Account ID</Label>
                  <Input
                    id="connect-waba"
                    data-testid="input-connect-waba"
                    value={wabaId}
                    onChange={(e) => setWabaId(e.target.value)}
                    placeholder="Found in Meta Business Manager"
                    autoComplete="off"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    The token is valid, but we need the account that owns this number to find it.
                  </p>
                </div>
              ) : null}
              {failure ? (
                <Alert variant="destructive" data-testid="alert-connect-error">
                  <AlertTitle>Couldn't connect this number</AlertTitle>
                  <AlertDescription>
                    <p>{failure.message}</p>
                    {failure.details?.length ? (
                      <ul className="mt-1 list-disc pl-4">
                        {failure.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    ) : null}
                    {accessToken === "" ? <p className="mt-1 text-xs">Paste the token again to retry.</p> : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              {failure ? (
                <TechnicalDetails
                  fields={[
                    { label: "HTTP status", value: failure.status },
                    { label: "Error code", value: (failure.raw as { code?: string } | null)?.code ?? null, copyable: true },
                  ]}
                  data-testid="technical-connect-error"
                />
              ) : null}
              <Alert>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>What happens next</AlertTitle>
                <AlertDescription>
                  A discovered number can't send yet. Verification comes in a later step.
                </AlertDescription>
              </Alert>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button type="button" variant="ghost" onClick={() => setStep("choose")} disabled={connect.isPending}>
                  Back
                </Button>
                <Button type="submit" disabled={!canSubmit || connect.isPending} data-testid="button-submit-connect">
                  {connect.isPending ? "Checking with Meta…" : needsWaba ? "Find my number" : "Connect"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
