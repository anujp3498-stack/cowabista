// What the signed-out SPA may offer, from GET /api/auth-policy. It fails closed: only an explicit
// { publicSignUp: true } shows a sign-up link or form (public sign-up is closed in production, Option 2a).
export type AuthPolicy = { publicSignUp: boolean }

export function parseAuthPolicy(value: unknown): AuthPolicy {
  const open = typeof value === "object" && value !== null && !Array.isArray(value) && (value as { publicSignUp?: unknown }).publicSignUp === true
  return { publicSignUp: open }
}

/** The API always lives at /api on the SPA's own origin (see lib/auth-client.ts), whatever BASE_PATH is. */
export async function fetchAuthPolicy(): Promise<AuthPolicy> {
  const response = await fetch("/api/auth-policy", { credentials: "same-origin", headers: { Accept: "application/json" } })
  if (!response.ok) return { publicSignUp: false }
  return parseAuthPolicy(await response.json().catch(() => null))
}
