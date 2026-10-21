import { type FormEvent, type ReactNode, useState } from "react"
import { Link, useSearch } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"
import { authErrorMessage, MIN_PASSWORD_LENGTH } from "@/lib/auth-errors"
import { safeNextPath } from "@/lib/safe-next"

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

// Email and password sign-in and sign-up (Better Auth). `?invite=<token>` returns to the invite page after
// authenticating so the invitee can accept it; `?next=<path>` returns to the page that asked for sign-in;
// `?email=` only prefills the form.
function useAuthParams() {
  const params = new URLSearchParams(useSearch())
  const invite = params.get("invite")
  const next = safeNextPath(params.get("next"))
  const carried = new URLSearchParams()
  if (invite) carried.set("invite", invite)
  if (next) carried.set("next", next)
  const email = params.get("email") ?? ""
  if (email) carried.set("email", email)
  const query = carried.toString()
  return { invite, next, email, suffix: query ? `?${query}` : "" }
}

function continueAfterAuth(invite: string | null, next: string | null) {
  // A full load starts the app fresh for the new session (no cached data from before).
  if (invite) window.location.assign(`${basePath}/invite/${encodeURIComponent(invite)}`)
  else window.location.assign(`${basePath}${next ?? "/overview"}`)
}

function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 px-4 py-10">
      <div className="w-full max-w-[440px] rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Link href="/" className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white" aria-label="Wabista Nexus home">
            <MessageCircle className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-slate-900">{title}</h1>
            <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
          </div>
        </div>
        {children}
        <p className="mt-6 text-center text-sm text-slate-500">{footer}</p>
      </div>
    </div>
  )
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" data-testid="auth-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  )
}

export function SignInPage() {
  const { invite, next, email: prefill, suffix } = useAuthParams()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState(prefill)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const { error: failure } = await authClient.signIn.email({ email: email.trim(), password })
    if (failure) {
      setError(authErrorMessage(failure))
      setPending(false)
      return
    }
    queryClient.clear()
    continueAfterAuth(invite, next)
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to your Wabista Nexus workspace"
      footer={<>No account yet? <Link href={`/sign-up${suffix}`} className="font-semibold text-primary hover:text-primary/80" data-testid="link-to-sign-up">Create one</Link></>}
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="sign-in-email" className="text-slate-700">Email</Label>
          <Input id="sign-in-email" data-testid="input-sign-in-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="border-slate-200 text-slate-900" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sign-in-password" className="text-slate-700">Password</Label>
          <Input id="sign-in-password" data-testid="input-sign-in-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="border-slate-200 text-slate-900" />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending || !email.trim() || !password} data-testid="button-sign-in-submit">
          {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Sign in
        </Button>
      </form>
    </AuthCard>
  )
}

export function SignUpPage() {
  const { invite, next, email: prefill, suffix } = useAuthParams()
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [email, setEmail] = useState(prefill)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(authErrorMessage({ code: "PASSWORD_TOO_SHORT" }))
      return
    }
    setPending(true)
    setError(null)
    const { error: failure } = await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
    if (failure) {
      setError(authErrorMessage(failure))
      setPending(false)
      return
    }
    queryClient.clear()
    continueAfterAuth(invite, next)
  }

  return (
    <AuthCard
      title="Create your workspace"
      subtitle="Get started with Wabista Nexus in seconds"
      footer={<>Already have an account? <Link href={`/sign-in${suffix}`} className="font-semibold text-primary hover:text-primary/80" data-testid="link-to-sign-in">Sign in</Link></>}
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="sign-up-name" className="text-slate-700">Your name</Label>
          <Input id="sign-up-name" data-testid="input-sign-up-name" autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className="border-slate-200 text-slate-900" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sign-up-email" className="text-slate-700">Email</Label>
          <Input id="sign-up-email" data-testid="input-sign-up-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="border-slate-200 text-slate-900" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sign-up-password" className="text-slate-700">Password</Label>
          <Input id="sign-up-password" data-testid="input-sign-up-password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} className="border-slate-200 text-slate-900" aria-describedby="sign-up-password-hint" />
          <p id="sign-up-password-hint" className="text-xs text-slate-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending || !name.trim() || !email.trim() || !password} data-testid="button-sign-up-submit">
          {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create account
        </Button>
      </form>
    </AuthCard>
  )
}
