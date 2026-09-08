// The generated API client doesn't export its ApiError class, so failed
// requests are inspected structurally: a fetch failure from customFetch
// always carries `status` (HTTP status code) and `data` (parsed JSON body,
// e.g. `{ error, details? }` for validation/readiness 400/409 responses).

export function errorDetailsFrom(error: unknown): string[] | null {
  if (!error || typeof error !== "object") return null
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== "object") return null
  const details = (data as { details?: unknown }).details
  return Array.isArray(details) ? details.filter((d): d is string => typeof d === "string") : null
}

export function messageFrom(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      return (data as { error: string }).error
    }
    if (error instanceof Error && error.message) return error.message
  }
  return fallback
}
