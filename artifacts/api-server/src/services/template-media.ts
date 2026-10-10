import { and, eq } from "drizzle-orm";
import { db, templateMediaUploadsTable, wabasTable, type TemplateMediaUpload } from "@workspace/db";
import { logger } from "../lib/logger";
import { ProviderRequestError } from "./whatsapp-provider";
import { ManualMetaClient, type FetchLike } from "./whatsapp-manual-client";
import { resolveSendingCredential, SendingCredentialUnavailableError } from "./whatsapp-transport-credentials";
import { TemplateDraftError } from "./template-draft-errors";

// V2-03B media examples for template headers, through Meta's Resumable
// Upload API (https://developers.facebook.com/docs/graph-api/guides/upload/
// -- could not be fetched live from this environment; verify the session
// and chunk request shapes before production use).
//
// Flow, as documented: POST /{app-id}/uploads?file_length&file_type&file_name
// opens a session; POST /{upload-session-id} with `Authorization: OAuth
// <token>`, `file_offset: 0` and the raw bytes returns `{ "h": "<handle>" }`.
// The handle is what a template HEADER example references.
//
// Lifetime: no exact header_handle lifetime is documented in the Meta
// evidence available to this project. TEMPLATE_MEDIA_HANDLE_TTL_MS is a
// LOCAL UX upper bound, not a provider guarantee: after it, submission asks
// for a re-upload (the only cost if Meta would still accept the handle).
// If Meta expires a handle sooner, the template-create request is refused
// and the attempt fails closed; nothing is retried automatically.
//
// App binding: the row records the credential and the Meta app id used for
// the upload; submission accepts the handle only through that same
// credential and that same configured app (template-submission.ts), so no
// undocumented cross-token or cross-app handle behaviour is relied upon.
//
// Boundaries:
//  - bytes come from the authenticated request body only, never from a URL;
//  - size and content type are checked before any provider call;
//  - the WABA and its credential must belong to the organization;
//  - the app id comes from server configuration, not the client;
//  - the provider handle stays server-side (not in API responses);
//  - no token appears in URLs, logs, errors or stored rows.

export const TEMPLATE_MEDIA_APP_ID_ENV = "WHATSAPP_APP_ID";
export const TEMPLATE_MEDIA_HANDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // local UX upper bound; NOT a Meta-documented handle lifetime

export const TEMPLATE_MEDIA_LIMITS: Record<string, { kind: "image" | "video" | "document"; maxBytes: number }> = {
  "image/jpeg": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "image/png": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "video/mp4": { kind: "video", maxBytes: 16 * 1024 * 1024 },
  "application/pdf": { kind: "document", maxBytes: 16 * 1024 * 1024 },
};
export const TEMPLATE_MEDIA_MAX_BYTES = Math.max(...Object.values(TEMPLATE_MEDIA_LIMITS).map((l) => l.maxBytes));

export function templateMediaAppId(): string | null {
  const value = process.env[TEMPLATE_MEDIA_APP_ID_ENV]?.trim();
  return value ? value : null;
}

export function isTemplateMediaConfigured(): boolean {
  return templateMediaAppId() !== null;
}

export function serializeMediaUpload(row: TemplateMediaUpload) {
  return {
    id: row.id,
    wabaId: row.wabaId,
    fileName: row.fileName,
    contentType: row.contentType,
    byteLength: row.byteLength,
    kind: row.kind,
    state: row.state,
    error: row.error ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

const SAFE_FILE_NAME = /^[A-Za-z0-9._ -]{1,120}$/;

export async function uploadTemplateMedia(input: {
  organizationId: number;
  userId: number | null;
  wabaId: number;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: FetchLike;
  now?: Date;
}) {
  const appId = templateMediaAppId();
  if (!appId) {
    throw new TemplateDraftError("media_not_configured", `Media examples need the server setting ${TEMPLATE_MEDIA_APP_ID_ENV} (the Meta app id the workspace tokens were issued for). Text-only templates can still be authored.`, 503);
  }
  const contentType = input.contentType.split(";")[0].trim().toLowerCase();
  const limit = TEMPLATE_MEDIA_LIMITS[contentType];
  if (!limit) throw new TemplateDraftError("media_invalid", "Unsupported file type. Use JPEG or PNG images, MP4 video or PDF documents.", 400);
  if (!input.bytes.byteLength) throw new TemplateDraftError("media_invalid", "The uploaded file is empty.", 400);
  if (input.bytes.byteLength > limit.maxBytes) throw new TemplateDraftError("media_invalid", `${limit.kind === "image" ? "Images" : limit.kind === "video" ? "Videos" : "Documents"} must be at most ${Math.round(limit.maxBytes / 1024 / 1024)} MB.`, 400);
  const fileName = input.fileName.trim();
  if (!SAFE_FILE_NAME.test(fileName)) throw new TemplateDraftError("media_invalid", "Use a simple file name (letters, numbers, dots, dashes, spaces).", 400);

  const [waba] = await db.select().from(wabasTable).where(and(eq(wabasTable.id, input.wabaId), eq(wabasTable.organizationId, input.organizationId)));
  if (!waba) throw new TemplateDraftError("waba_not_eligible", "Business account not found in this workspace.", 400);
  if (waba.credentialId === null) throw new TemplateDraftError("waba_not_eligible", "This business account has no workspace credential; media examples cannot be uploaded for it.", 400);

  let credential;
  try {
    credential = await resolveSendingCredential(input.organizationId, waba.credentialId);
  } catch (error) {
    if (error instanceof SendingCredentialUnavailableError) throw new TemplateDraftError("credential_inactive", "The workspace credential for this business account is not active. Reconnect it in Number Center.", 409);
    throw error;
  }

  const now = input.now ?? new Date();
  const client = new ManualMetaClient({ accessToken: credential.accessToken, fetchImpl: input.fetchImpl });
  let sessionId: string | null = null;
  try {
    sessionId = await client.createUploadSession(appId, { byteLength: input.bytes.byteLength, contentType, fileName });
    const handle = await client.uploadFile(sessionId, input.bytes, 0);
    const [row] = await db.insert(templateMediaUploadsTable).values({
      organizationId: input.organizationId,
      wabaId: waba.id,
      credentialId: credential.credentialId,
      appId,
      fileName,
      contentType,
      byteLength: input.bytes.byteLength,
      kind: limit.kind,
      providerSessionId: sessionId,
      providerHandle: handle,
      state: "ready",
      expiresAt: new Date(now.getTime() + TEMPLATE_MEDIA_HANDLE_TTL_MS),
      createdBy: input.userId,
    }).returning();
    return serializeMediaUpload(row);
  } catch (error) {
    // Failed uploads are not persisted: there is nothing a draft could
    // reference. The error text is already token-scrubbed by the client.
    const providerCode = error instanceof ProviderRequestError ? error.code : undefined;
    logger.info({ organizationId: input.organizationId, wabaId: waba.id, kind: limit.kind, byteLength: input.bytes.byteLength, providerCode, sessionOpened: sessionId !== null }, "template media upload failed");
    if (error instanceof ProviderRequestError) {
      if (error.code === "190" || error.status === 401) throw new TemplateDraftError("credential_inactive", "Meta rejected the workspace credential. Reconnect it in Number Center.", 409);
      if (error.retryable) throw new TemplateDraftError("provider_unavailable", "WhatsApp (Meta) could not accept the upload right now. Try again in a moment.", 502);
      throw new TemplateDraftError("provider_rejected", `Meta refused the upload: ${error.message}`, 502);
    }
    throw error;
  }
}

/** A ready, unexpired upload of this organization (for submission). */
export async function loadReadyMediaUpload(organizationId: number, uploadId: number, now: Date): Promise<TemplateMediaUpload | null> {
  const [row] = await db.select().from(templateMediaUploadsTable)
    .where(and(eq(templateMediaUploadsTable.organizationId, organizationId), eq(templateMediaUploadsTable.id, uploadId)));
  if (!row || row.state !== "ready" || !row.providerHandle) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}
