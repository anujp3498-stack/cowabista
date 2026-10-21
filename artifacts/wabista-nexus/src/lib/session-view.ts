// What a page should show for the Better Auth session state (pure, unit-tested). A failed session check
// that is not a 401 is "unavailable" (server or network trouble), never "signed out": a signed-in user must
// not be sent to the sign-in page because the API was briefly unreachable.
export type SessionView = "loading" | "signed-in" | "signed-out" | "unavailable"

export function sessionView(state: { hasSession: boolean; isPending: boolean; error: { status?: number } | null | undefined }): SessionView {
  if (state.hasSession) return "signed-in"
  if (state.isPending) return "loading"
  if (state.error && state.error.status !== 401) return "unavailable"
  return "signed-out"
}
