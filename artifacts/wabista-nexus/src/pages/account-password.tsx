import { type FormEvent, useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { PageHeader } from "@/components/app"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"
import { authErrorMessage, changePasswordProblem, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth-errors"

// Change password (Better Auth POST /api/auth/change-password). The current password is required and every
// other session of the account is always ended (the server refuses the change otherwise); this browser keeps
// its new session. An account created by an administrator starts with a temporary password, changed here.
export default function AccountPasswordPage() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setDone(false)
    const problem = changePasswordProblem({ current, next, confirm })
    if (problem) {
      setError(problem)
      return
    }
    setPending(true)
    setError(null)
    const { error: failure } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })
    setPending(false)
    if (failure) {
      setError(authErrorMessage(failure))
      return
    }
    setCurrent("")
    setNext("")
    setConfirm("")
    setDone(true)
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-2xl">
      <PageHeader title="Password" description="Change the password you sign in with." />
      <Card>
        <form onSubmit={submit} noValidate>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> Change password</CardTitle>
            <CardDescription>
              Changing your password signs you out everywhere else. If an administrator gave you a temporary password, change it now.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input id="current-password" data-testid="input-current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input id="new-password" data-testid="input-new-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="new-password-hint" />
              <p id="new-password-hint" className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input id="confirm-password" data-testid="input-confirm-password" type="password" autoComplete="new-password" maxLength={MAX_PASSWORD_LENGTH} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && (
              <p role="alert" data-testid="change-password-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}
            {done && (
              <p role="status" data-testid="change-password-success" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                Password changed. Every other session was signed out.
              </p>
            )}
          </CardContent>
          <CardFooter className="bg-slate-50 dark:bg-slate-900/50 border-t py-4 px-6 flex justify-end">
            <Button type="submit" disabled={pending || !current || !next || !confirm} data-testid="button-change-password-submit">
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Change password
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
