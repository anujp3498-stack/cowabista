import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  templateDraftsTable,
  templateMediaUploadsTable,
  templateSubmissionAttemptsTable,
  wabasTable,
  whatsappCredentialsTable,
  type TemplateDraft,
  type TemplateDraftContent,
  type TemplateSubmissionAttempt,
} from "@workspace/db";
import { CREDENTIAL_KIND_MANUAL_TOKEN, CREDENTIAL_PROVIDER } from "./whatsapp-manual-connection";
import { emptyDraftContent, validateDraft, type DraftFieldError } from "./template-authoring";
import { isTemplateMediaConfigured } from "./template-media";

// V2-03B draft storage: management plane only. Every query is scoped by
// organizationId; a draft id from another workspace behaves exactly like a
// missing one. Writes take the draft row FOR UPDATE and compare the
// caller's expected revision inside the same transaction, so a stale edit
// or an edit racing a submission is refused instead of silently applied.

export { TemplateDraftError, serializeAttempt, type TemplateDraftErrorCode } from "./template-draft-errors";
import { TemplateDraftError, serializeAttempt } from "./template-draft-errors";

export const EDITABLE_STATES = ["draft", "failed"] as const;

export type DraftInput = {
  wabaId?: number | null;
  name: string;
  language: string;
  category: string;
  content: TemplateDraftContent;
};

/** Public shape of a draft: no payloads, no handles, no credential material. */
export function serializeDraft(
  draft: TemplateDraft,
  waba: { displayName: string; externalId: string } | null,
  latestAttempt: TemplateSubmissionAttempt | null,
) {
  return {
    id: draft.id,
    wabaId: draft.wabaId,
    wabaDisplayName: waba?.displayName ?? null,
    wabaExternalId: waba?.externalId ?? null,
    name: draft.name,
    language: draft.language,
    category: draft.category,
    content: normalizeContent(draft.content),
    revision: draft.revision,
    state: draft.state,
    providerTemplateId: draft.providerTemplateId ?? null,
    providerStatus: draft.providerStatus ?? null,
    providerStatusCheckedAt: draft.providerStatusCheckedAt ?? null,
    templateId: draft.templateId ?? null,
    lastError: draft.lastError ?? null,
    latestAttempt: latestAttempt ? serializeAttempt(latestAttempt) : null,
    validation: validateDraft(draft, { forSubmission: true }),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export type SerializedDraft = ReturnType<typeof serializeDraft>;

/** Defensive copy of what the API accepted: only known fields are stored. */
export function normalizeContent(input: TemplateDraftContent | null | undefined): TemplateDraftContent {
  const base = emptyDraftContent();
  if (!input || typeof input !== "object") return base;
  const header = input.header && typeof input.header === "object" ? input.header : base.header;
  let normalizedHeader: TemplateDraftContent["header"];
  if (header.kind === "text") normalizedHeader = { kind: "text", text: String(header.text ?? ""), example: String(header.example ?? "") };
  else if (header.kind === "image" || header.kind === "video" || header.kind === "document") {
    const id = header.mediaUploadId;
    normalizedHeader = { kind: header.kind, mediaUploadId: Number.isInteger(id) && (id as number) > 0 ? (id as number) : null };
  } else normalizedHeader = { kind: "none" };
  const body = input.body && typeof input.body === "object" ? input.body : base.body;
  const examples = Array.isArray(body.examples) ? body.examples.map((e) => String(e ?? "")) : [];
  const footer = input.footer && typeof input.footer === "object" ? { text: String(input.footer.text ?? "") } : null;
  const buttons: TemplateDraftContent["buttons"] = Array.isArray(input.buttons)
    ? input.buttons.map((button) => {
      const text = String(button?.text ?? "");
      if (button?.type === "url") return { type: "url", text, url: String(button.url ?? ""), example: String(button.example ?? "") };
      if (button?.type === "phone") return { type: "phone", text, phoneNumber: String(button.phoneNumber ?? "") };
      return { type: "quick_reply", text };
    })
    : [];
  return { header: normalizedHeader, body: { text: String(body.text ?? ""), examples }, footer, buttons };
}

async function wabaSummaries(organizationId: number, wabaIds: number[]) {
  const ids = [...new Set(wabaIds)];
  if (!ids.length) return new Map<number, { displayName: string; externalId: string }>();
  const rows = await db.select({ id: wabasTable.id, displayName: wabasTable.displayName, externalId: wabasTable.externalId })
    .from(wabasTable).where(and(eq(wabasTable.organizationId, organizationId), inArray(wabasTable.id, ids)));
  return new Map(rows.map((row) => [row.id, { displayName: row.displayName, externalId: row.externalId }]));
}

async function latestAttempts(organizationId: number, draftIds: number[]) {
  if (!draftIds.length) return new Map<number, TemplateSubmissionAttempt>();
  const rows = await db.select().from(templateSubmissionAttemptsTable)
    .where(and(eq(templateSubmissionAttemptsTable.organizationId, organizationId), inArray(templateSubmissionAttemptsTable.draftId, draftIds)))
    .orderBy(desc(templateSubmissionAttemptsTable.id));
  const map = new Map<number, TemplateSubmissionAttempt>();
  for (const row of rows) if (!map.has(row.draftId)) map.set(row.draftId, row);
  return map;
}

export async function hydrateDrafts(organizationId: number, drafts: TemplateDraft[]): Promise<SerializedDraft[]> {
  const wabas = await wabaSummaries(organizationId, drafts.map((d) => d.wabaId).filter((id): id is number => id !== null));
  const attempts = await latestAttempts(organizationId, drafts.map((d) => d.id));
  return drafts.map((draft) => serializeDraft(draft, draft.wabaId ? wabas.get(draft.wabaId) ?? null : null, attempts.get(draft.id) ?? null));
}

export async function loadDraft(organizationId: number, draftId: number): Promise<SerializedDraft> {
  const [draft] = await db.select().from(templateDraftsTable)
    .where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId)));
  if (!draft) throw new TemplateDraftError("not_found", "Draft not found.", 404);
  const [serialized] = await hydrateDrafts(organizationId, [draft]);
  return serialized;
}

export const DRAFT_PAGE_MAX = 100;

export async function listDrafts(organizationId: number, options: { limit?: number; cursor?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), DRAFT_PAGE_MAX);
  const conditions = [eq(templateDraftsTable.organizationId, organizationId)];
  if (options.cursor !== undefined) conditions.push(lt(templateDraftsTable.id, options.cursor));
  const rows = await db.select().from(templateDraftsTable).where(and(...conditions)).orderBy(desc(templateDraftsTable.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = await hydrateDrafts(organizationId, page);
  return { items, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

/**
 * Business accounts offered for authoring. Credential-backed WABAs are
 * eligible; the legacy connector WABA is listed so it is not a mystery,
 * but cannot be chosen (there is no workspace credential to submit with).
 */
export async function listAuthoringWabas(organizationId: number) {
  const rows = await db.select({
    id: wabasTable.id,
    externalId: wabasTable.externalId,
    displayName: wabasTable.displayName,
    credentialId: wabasTable.credentialId,
    credentialStatus: whatsappCredentialsTable.status,
    credentialKind: whatsappCredentialsTable.kind,
    credentialProvider: whatsappCredentialsTable.provider,
  }).from(wabasTable)
    .leftJoin(whatsappCredentialsTable, and(
      eq(whatsappCredentialsTable.id, wabasTable.credentialId),
      eq(whatsappCredentialsTable.organizationId, wabasTable.organizationId),
    ))
    .where(eq(wabasTable.organizationId, organizationId))
    .orderBy(wabasTable.id);
  const mediaSupported = isTemplateMediaConfigured();
  return rows.map((row) => {
    let reason: string | null = null;
    if (row.credentialId === null) reason = "Connected through the legacy connector; add a workspace credential in Number Center to author templates for it.";
    else if (row.credentialKind !== CREDENTIAL_KIND_MANUAL_TOKEN || row.credentialProvider !== CREDENTIAL_PROVIDER) reason = "This business account's credential is not a workspace WhatsApp token.";
    else if (row.credentialStatus !== "active") reason = "The workspace credential for this business account is not active. Reconnect it in Number Center.";
    return {
      id: row.id,
      displayName: row.displayName,
      externalId: row.externalId,
      authoringSupported: reason === null,
      reason,
      mediaSupported: reason === null && mediaSupported,
    };
  });
}

/** Eligible WABA for a draft: in this org, credential-backed and active. Throws waba_not_eligible otherwise. */
export async function assertAuthoringWaba(organizationId: number, wabaId: number) {
  const options = await listAuthoringWabas(organizationId);
  const match = options.find((option) => option.id === wabaId);
  if (!match) throw new TemplateDraftError("waba_not_eligible", "Business account not found in this workspace.", 400, [{ field: "wabaId", message: "Choose one of the listed business accounts." }]);
  if (!match.authoringSupported) throw new TemplateDraftError("waba_not_eligible", match.reason ?? "This business account cannot be used for authoring.", 400, [{ field: "wabaId", message: match.reason ?? "Not eligible." }]);
  return match;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/**
 * A media example may be referenced only when it belongs to this
 * organization and (when the draft names one) the same business account.
 */
async function assertMediaReference(organizationId: number, wabaId: number | null, content: TemplateDraftContent) {
  if (content.header.kind !== "image" && content.header.kind !== "video" && content.header.kind !== "document") return;
  const id = content.header.mediaUploadId;
  if (!id) return;
  const [upload] = await db.select().from(templateMediaUploadsTable)
    .where(and(eq(templateMediaUploadsTable.organizationId, organizationId), eq(templateMediaUploadsTable.id, id)));
  const field = { field: "header.mediaUploadId", message: "Upload the media example again for this business account." };
  if (!upload) throw new TemplateDraftError("media_unavailable", "The referenced media example does not exist in this workspace.", 400, [field]);
  if (upload.kind !== content.header.kind) throw new TemplateDraftError("media_invalid", `The referenced upload is a ${upload.kind}, not a ${content.header.kind}.`, 400, [field]);
  if (wabaId !== null && upload.wabaId !== wabaId) throw new TemplateDraftError("media_invalid", "The media example was uploaded for a different business account.", 400, [field]);
}

export async function createDraft(organizationId: number, userId: number | null, input: DraftInput): Promise<SerializedDraft> {
  const content = normalizeContent(input.content);
  const wabaId = input.wabaId ?? null;
  const candidate = { name: input.name.trim(), language: input.language.trim(), category: input.category, content, wabaId };
  const errors = validateDraft(candidate, { forSubmission: false });
  if (errors.length) throw new TemplateDraftError("invalid_draft", "The draft has problems that must be fixed.", 400, errors);
  if (wabaId !== null) await assertAuthoringWaba(organizationId, wabaId);
  await assertMediaReference(organizationId, wabaId, content);
  try {
    const [row] = await db.insert(templateDraftsTable).values({
      organizationId, wabaId, name: candidate.name, language: candidate.language, category: candidate.category, content,
      createdBy: userId, updatedBy: userId,
    }).returning();
    return (await hydrateDrafts(organizationId, [row]))[0];
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateDraftError("name_conflict", "A draft with this name and language already exists for that business account.", 409, [{ field: "name", message: "Choose a different name or language." }]);
    throw error;
  }
}

export async function updateDraft(
  organizationId: number,
  userId: number | null,
  draftId: number,
  patch: Partial<DraftInput> & { expectedRevision: number },
): Promise<SerializedDraft> {
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(templateDraftsTable)
      .where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId))).for("update");
    if (!current) throw new TemplateDraftError("not_found", "Draft not found.", 404);
    if (current.revision !== patch.expectedRevision) throw new TemplateDraftError("stale_revision", "This draft changed since you loaded it. Reload it and apply your edits again.", 409);
    if (!(EDITABLE_STATES as readonly string[]).includes(current.state)) {
      throw new TemplateDraftError(current.state === "reconcile_required" ? "reconcile_required" : "not_editable", describeNotEditable(current.state), 409);
    }
    const next = {
      wabaId: patch.wabaId === undefined ? current.wabaId : patch.wabaId,
      name: (patch.name ?? current.name).trim(),
      language: (patch.language ?? current.language).trim(),
      category: patch.category ?? current.category,
      content: patch.content === undefined ? normalizeContent(current.content) : normalizeContent(patch.content),
    };
    const errors = validateDraft(next, { forSubmission: false });
    if (errors.length) throw new TemplateDraftError("invalid_draft", "The draft has problems that must be fixed.", 400, errors);
    if (next.wabaId !== null && next.wabaId !== current.wabaId) await assertAuthoringWaba(organizationId, next.wabaId);
    await assertMediaReference(organizationId, next.wabaId, next.content);
    try {
      const [row] = await tx.update(templateDraftsTable).set({
        ...next,
        revision: sql`${templateDraftsTable.revision} + 1`,
        // A failed draft that is edited goes back to draft; its last error
        // stays visible on the attempt history.
        state: "draft",
        lastError: null,
        updatedBy: userId,
      }).where(eq(templateDraftsTable.id, current.id)).returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new TemplateDraftError("name_conflict", "A draft with this name and language already exists for that business account.", 409, [{ field: "name", message: "Choose a different name or language." }]);
      throw error;
    }
  });
  return (await hydrateDrafts(organizationId, [updated]))[0];
}

function describeNotEditable(state: string): string {
  if (state === "submitting") return "This draft is being submitted to Meta. Wait for the submission to finish.";
  if (state === "submitted") return "This draft was submitted to Meta. Create a new draft to make changes.";
  if (state === "reconcile_required") return "The last submission's outcome is unknown. Reconcile it with Meta before editing.";
  return "This draft cannot be edited in its current state.";
}

/** Deleting is allowed for drafts that are not mid-submission or awaiting reconciliation. History rows cascade. */
export async function deleteDraft(organizationId: number, draftId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(templateDraftsTable)
      .where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId))).for("update");
    if (!current) throw new TemplateDraftError("not_found", "Draft not found.", 404);
    if (current.state === "submitting" || current.state === "reconcile_required") {
      throw new TemplateDraftError(current.state === "submitting" ? "not_editable" : "reconcile_required", describeNotEditable(current.state), 409);
    }
    await tx.delete(templateDraftsTable).where(eq(templateDraftsTable.id, current.id));
  });
}
