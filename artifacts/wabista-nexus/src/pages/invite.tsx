import { Link, useParams } from "wouter"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Loader2, Mail, ShieldCheck, XCircle } from "lucide-react"
import {
  getInvitationPreview,
  getGetInvitationPreviewQueryKey,
  useAcceptInvitation,
} from "@workspace/api-client-react"
import { authClient } from "@/lib/auth-client"
import { sessionView } from "@/lib/session-view"
import { messageFrom } from "@/lib/api-errors"
import { useSignOut } from "@/hooks/use-sign-out"

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  agent: "Agent",
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

// Landing page for a shareable `/invite/:token` link. The preview is public.
// Joining is an explicit step: signed in with the invited email, the invitee
// accepts (POST /invitations/accept with the token); signing up with that
// email alone never joins, because email ownership is not verified.
export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const { data: session, isPending: sessionPending, error: sessionError, refetch: refetchSession } = authClient.useSession()
  const view = sessionView({ hasSession: !!session, isPending: sessionPending, error: sessionError })
  const acceptInvitation = useAcceptInvitation()
  const signOut = useSignOut()
  const { data, isLoading, isError } = useQuery({
    queryKey: getGetInvitationPreviewQueryKey(token ?? ""),
    queryFn: () => getInvitationPreview(token ?? ""),
    enabled: !!token,
    retry: false,
  })

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-8 text-center shadow-xl">
        {isLoading && (
          <div className="flex flex-col items-center gap-3 py-8 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p>Loading invitation…</p>
          </div>
        )}

        {isError && (
          <div
            data-testid="invite-preview-not-found"
            className="flex flex-col items-center gap-3 py-6"
          >
            <XCircle className="h-10 w-10 text-red-500" />
            <h1 className="text-lg font-semibold text-white">
              Invitation not found
            </h1>
            <p className="text-sm text-slate-400">
              This invite link is invalid, expired, or has already been
              revoked. Ask whoever invited you to send a new one.
            </p>
            <Link href="/">
              <Button variant="outline" className="mt-2">
                Go to Wabista Nexus
              </Button>
            </Link>
          </div>
        )}

        {data && (
          <div
            data-testid="invite-preview"
            className="flex flex-col items-center gap-4"
          >
            {data.status === "Pending" ? (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                  <Mail className="h-6 w-6" />
                </div>
                <h1 className="text-lg font-semibold text-white">
                  You're invited to join{" "}
                  <span className="text-emerald-400">
                    {data.organizationName}
                  </span>
                </h1>
                <p className="text-sm text-slate-400">
                  As{" "}
                  <span className="font-medium text-slate-200">
                    {ROLE_LABEL[data.role] ?? data.role}
                  </span>
                  . Sign in or create an account with{" "}
                  <span className="font-medium text-slate-200">
                    {data.email}
                  </span>
                  , then accept to join.
                </p>
                <div className="mt-2 flex w-full flex-col gap-2">
                  {view === "loading" && (
                    <div className="flex justify-center py-2 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
                  )}
                  {view === "unavailable" && (
                    <div data-testid="invite-session-unavailable" className="flex flex-col gap-2 text-sm text-slate-400">
                      <p>We could not check your sign-in right now.</p>
                      <Button variant="outline" className="w-full" onClick={() => void refetchSession()}>Try again</Button>
                    </div>
                  )}
                  {view === "signed-out" && (
                    <>
                      <Link href={`/sign-up?${new URLSearchParams({ invite: token ?? "", email: data.email }).toString()}`}>
                        <Button
                          className="w-full"
                          data-testid="button-invite-sign-up"
                        >
                          Create account &amp; join
                        </Button>
                      </Link>
                      <Link href={`/sign-in?${new URLSearchParams({ invite: token ?? "", email: data.email }).toString()}`}>
                        <Button
                          variant="outline"
                          className="w-full"
                          data-testid="button-invite-sign-in"
                        >
                          I already have an account
                        </Button>
                      </Link>
                    </>
                  )}
                  {view === "signed-in" && session && session.user.email === data.email.trim().toLowerCase() && (
                    <>
                      <Button
                        className="w-full"
                        data-testid="button-invite-accept"
                        disabled={acceptInvitation.isPending}
                        onClick={() =>
                          acceptInvitation.mutate(
                            { data: { token: token ?? "" } },
                            { onSuccess: () => window.location.assign(`${basePath}/overview`) },
                          )
                        }
                      >
                        {acceptInvitation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Join {data.organizationName}
                      </Button>
                      {acceptInvitation.isError && (
                        <p role="alert" data-testid="invite-accept-error" className="text-sm text-red-400">
                          {messageFrom(acceptInvitation.error, "Could not accept this invitation. Try again.")}
                        </p>
                      )}
                    </>
                  )}
                  {view === "signed-in" && session && session.user.email !== data.email.trim().toLowerCase() && (
                    <div data-testid="invite-email-mismatch" className="flex flex-col gap-2">
                      <p className="text-sm text-amber-300">
                        You're signed in as <span className="font-medium">{session.user.email}</span>, but this
                        invitation is for <span className="font-medium">{data.email}</span>. Sign out and sign in
                        with that address to accept it.
                      </p>
                      <Button variant="outline" className="w-full" data-testid="button-invite-sign-out" onClick={() => void signOut(`/invite/${encodeURIComponent(token ?? "")}`)}>
                        Sign out
                      </Button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-700/50 text-slate-300">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <h1 className="text-lg font-semibold text-white">
                  {data.status === "Accepted"
                    ? "This invitation has already been accepted"
                    : "This invitation has been revoked"}
                </h1>
                <Link href="/">
                  <Button variant="outline" className="mt-2">
                    Go to Wabista Nexus
                  </Button>
                </Link>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
