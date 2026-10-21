// `?next=` after sign-in may only point back into this app: a path starting with a single "/", never "//"
// or "/\" (protocol-relative, another host), no scheme, no control characters. Anything else is ignored.
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null
  return raw
}
