import {
  getDownloadDuplicateImportRowsUrl,
  getDownloadRejectedImportRowsUrl,
  getSniffContactImportUrl,
  getStreamContactImportUrl,
  type ContactImportSession,
  type CsvSniffResult,
} from "@workspace/api-client-react"

// Client-side model for the Rocket Audience step. Everything that decides
// what the server does lives on the server; this module only shapes
// requests and keeps local bookkeeping honest (which key belongs to which
// file + configuration, which autosave response is the newest).

/** Bytes of the file sent to the sniff endpoint (the server caps at the same size). */
export const SNIFF_PREFIX_BYTES = 256 * 1024

export type AudienceRequestError = Error & { status: number; code?: string; data?: unknown }

function requestError(status: number, body: unknown, fallback: string): AudienceRequestError {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const error = new Error(typeof data.error === "string" && data.error ? data.error : fallback) as AudienceRequestError
  error.status = status
  if (typeof data.code === "string") error.code = data.code
  error.data = body
  return error
}

/**
 * Raw-bytes POST of the first SNIFF_PREFIX_BYTES of the file. Not built on
 * the generated `sniffContactImport`: orval's binary-body codegen
 * JSON.stringifies the Blob instead of sending its bytes.
 */
export async function sniffCsv(organizationId: number, campaignId: number, file: File, signal?: AbortSignal): Promise<CsvSniffResult> {
  const res = await fetch(getSniffContactImportUrl(organizationId, campaignId), {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: file.slice(0, SNIFF_PREFIX_BYTES),
    signal,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw requestError(res.status, body, `Couldn't read this file (HTTP ${res.status})`)
  return body as CsvSniffResult
}

export type UploadConfig = {
  phoneColumn: string
  countryCode: string
  operation: "append" | "replace"
}

/** Streams the whole file as the request body (never buffered in JS memory). */
export async function uploadAudienceCsv(
  organizationId: number,
  campaignId: number,
  file: File,
  idempotencyKey: string,
  config: UploadConfig,
): Promise<ContactImportSession> {
  const res = await fetch(getStreamContactImportUrl(organizationId, campaignId), {
    method: "POST",
    headers: {
      "Content-Type": "text/csv",
      "idempotency-key": idempotencyKey,
      "x-file-name": file.name,
      "x-phone-column": config.phoneColumn,
      "x-import-operation": config.operation,
      ...(config.countryCode.trim() ? { "x-default-country-code": config.countryCode.trim() } : {}),
    },
    body: file,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw requestError(res.status, body, `Import failed (HTTP ${res.status})`)
  return body as ContactImportSession
}

/**
 * The idempotency key of an upload is bound to the campaign, the file's
 * identity (name, size, last-modified) and the upload configuration, and is
 * remembered for the browser tab session. Choosing the same file with the
 * same settings again -- after a dropped connection or a reload -- reuses
 * the key, so the server resumes or replays that upload instead of
 * starting a second one. Any change to the file or settings gets a new key
 * (the server refuses a reused key with a different configuration).
 */
export function uploadKeyFor(campaignId: number, file: Pick<File, "name" | "size" | "lastModified">, config: UploadConfig): string {
  const identity = JSON.stringify([campaignId, file.name, file.size, file.lastModified, config.phoneColumn, config.countryCode.trim(), config.operation])
  const storageKey = `wabista:audience-upload:${identity}`
  try {
    const existing = sessionStorage.getItem(storageKey)
    if (existing) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(storageKey, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export function rejectedRowsUrl(organizationId: number, campaignId: number, sessionId: number) {
  return getDownloadRejectedImportRowsUrl(organizationId, campaignId, sessionId)
}
export function duplicateRowsUrl(organizationId: number, campaignId: number, sessionId: number) {
  return getDownloadDuplicateImportRowsUrl(organizationId, campaignId, sessionId)
}

/**
 * Sequences autosave requests: only the response to the newest request may
 * update local state. An older response that arrives late is ignored, so a
 * slow save can never overwrite what the user typed after it.
 */
export function createSaveSequencer() {
  let latest = 0
  return {
    next: () => ++latest,
    isLatest: (ticket: number) => ticket === latest,
  }
}

/** Data rows this session read so far (rowsProcessed counts the header row). */
export function sessionDataRows(session: Pick<ContactImportSession, "rowsProcessed">) {
  return Math.max(0, session.rowsProcessed - 1)
}

export function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const direct = (error as { code?: unknown }).code
  if (typeof direct === "string") return direct
  const data = (error as { data?: unknown }).data
  const nested = data && typeof data === "object" ? (data as { code?: unknown }).code : undefined
  return typeof nested === "string" ? nested : undefined
}
