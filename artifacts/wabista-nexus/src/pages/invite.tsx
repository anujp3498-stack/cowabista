import { Show } from "@clerk/react"
import { Link, useParams } from "wouter"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Loader2, Mail, ShieldCheck, XCircle } from "lucide-react"
import {
  getInvitationPreview,
  getGetInvitationPreviewQueryKey,
} from "@workspace/api-client-react"

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  agent: "Agent",
}

// Public landing page for a shareable `/invite/:token` link. It only shows
// what the invite is for -- acceptance itself still happens through the
// existing email-match logic in attachOrgContext once the invitee signs in
// or signs up with the invited address, so this page never grants
// membership on its own.
export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
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
                  </span>{" "}
                  to join automatically.
                </p>
                <div className="mt-2 flex w-full flex-col gap-2">
                  <Show when="signed-out">
                    <Link href="/sign-up">
                      <Button
                        className="w-full"
                        data-testid="button-invite-sign-up"
                      >
                        Create account &amp; join
                      </Button>
                    </Link>
                    <Link href="/sign-in">
                      <Button
                        variant="outline"
                        className="w-full"
                        data-testid="button-invite-sign-in"
                      >
                        I already have an account
                      </Button>
                    </Link>
                  </Show>
                  <Show when="signed-in">
                    <Link href="/overview">
                      <Button className="w-full">Go to your workspace</Button>
                    </Link>
                  </Show>
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
