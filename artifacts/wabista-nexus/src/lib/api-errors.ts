// The generated API client doesn't export its ApiError class, so failed
// requests are inspected structurally: a fetch failure from customFetch
// always carries `status` (HTTP status code) and `data` (parsed JSON body,
// e.g. `{ error, details? }` for validation/readiness 400/409 responses).
//
// This module is the single frontend helper for turning an unknown thrown
// value into something a business user can read (`message`, `details`) while
// keeping enough structure for a Technical Details panel (`status`, `raw`).
// It never includes request headers, cookies or bodies, only what the server
// chose to send back.

export type ApiErrorDescription = {
  /** Human-readable headline, never empty. */
  message: string
  /** Optional list of specific problems (validation / readiness details). */
  details: string[] | null
  /** HTTP status when the failure came from the API. */
  status: number | null
  /** Raw server body (JSON) or error message for troubleshooting. */
  raw: unknown
}

function dataOf(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null
  const data = (error as { data?: unknown }).data
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null
}

export function errorDetailsFrom(error: unknown): string[] | null {
  const details = dataOf(error)?.details
  return Array.isArray(details) ? details.filter((d): d is string => typeof d === "string") : null
}

export function errorStatusFrom(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : null
}

export function messageFrom(error: unknown, fallback: string): string {
  const serverMessage = dataOf(error)?.error
  if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function describeApiError(error: unknown, fallback: string): ApiErrorDescription {
  const data = dataOf(error)
  return {
    message: messageFrom(error, fallback),
    details: errorDetailsFrom(error),
    status: errorStatusFrom(error),
    raw: data ?? (error instanceof Error ? error.message : error ?? null),
  }
}
