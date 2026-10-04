import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  templateDraftsTable,
  templateSubmissionAttemptsTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
  type TemplateSubmissionAttempt,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { ProviderRequestError, type MetaTemplate } from "./whatsapp-provider";
import { ManualMetaClient, type FetchLike } from "./whatsapp-manual-client";
import { resolveSendingCredential, SendingCredentialUnavailableError } from "./whatsapp-transport-credentials";
import { CREDENTIAL_KIND_MANUAL_TOKEN, CREDENTIAL_PROVIDER } from "./whatsapp-manual-connection";
import { normalizeTemplateStatus, syncWabaTemplates } from "./whatsapp-template-sync";
import { buildTemplateCreatePayload, templateMatchesPayload, validateDraft } from "./template-authoring";
import { TemplateDraftError } from "./template-draft-errors";
import { hydrateDrafts, type SerializedDraft } from "./template-drafts";
import { loadReadyMediaUpload } from "./template-media";

// V2-03B submission lifecycle. The provider request is a non-idempotent
// POST /{waba}/message_templates (Meta documents no idempotency key for
// it), so the ONLY protection against duplicate templates is on our side:
//
//   tx1  lock the draft, validate for submission, bind the WABA +
//        credential, INSERT the attempt (state "requested") and move the
//        draft to "submitting"; COMMIT. The partial unique index
//        template_submission_attempts_active_uq makes a second active
//        attempt for the same draft impossible in the database.
//   net  decrypt the credential and POST once, outside any transaction.
//   tx2  lock the attempt and record the outcome:
//        confirmed id  -> attempt succeeded, draft submitted
//        definite 4xx  -> attempt failed, draft failed (editable again)
//        anything else -> attempt uncertain, draft reconcile_required:
//                         the request MAY have created the template.
//
// An uncertain attempt is never retried automatically. Reconciliation
// reads the provider (GET by name) and links a template only when the
// name, language and content evidence match what this attempt sent.
// A same-name template with different content is reported, not linked.

export type SubmissionHooks = {
  /** Test barrier: runs after tx1 committed and before the provider POST. */
  beforeProviderCall?: (attempt: TemplateSubmissionAttempt) => Promise<void>;
  /** Test barrier: runs after the provider replied and before tx2. */
  beforeOutcome?: (attempt: TemplateSubmissionAttempt) => Promise<void>;
};

export type SubmissionResult = { draft: SerializedDraft; attempt: TemplateSubmissionAttempt };

/** An attempt still "requested" after this long is treated as a crash window and may be reconciled. */
export const STALE_REQUESTED_MS = 2 * 60_000;

const RECONNECT = "The workspace credential for this business account is not active. Reconnect it in Number Center.";

function advisoryKey(organizationId: number, wabaId: number) {
  return `whatsapp-template-sync:${organizationId}:${wabaId}`;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

async function activeAttempt(organizationId: number, draftId: number): Promise<TemplateSubmissionAttempt | null> {
  const [row] = await db.select().from(templateSubmissionAttemptsTable).where(and(
    eq(templateSubmissionAttemptsTable.organizationId, organizationId),
    eq(templateSubmissionAttemptsTable.draftId, draftId),
    inArray(templateSubmissionAttemptsTable.state, ["requested", "uncertain"]),
  )).orderBy(desc(templateSubmissionAttemptsTable.id)).limit(1);
  return row ?? null;
}

async function serializedDraft(organizationId: number, draftId: number): Promise<SerializedDraft> {
  const [draft] = await db.select().from(templateDraftsTable).where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId)));
  if (!draft) throw new TemplateDraftError("not_found", "Draft not found.", 404);
  return (await hydrateDrafts(organizationId, [draft]))[0];
}

type Outcome =
  | { kind: "succeeded"; providerTemplateId: string; providerStatus: string | null; providerCategory: string | null }
  | { kind: "failed"; code: "provider_rejected" | "credential_inactive"; message: string; providerCode?: string }
  | { kind: "uncertain"; message: string; providerCode?: string };

function classifyOutcome(error: unknown): Outcome {
  if (error instanceof SendingCredentialUnavailableError) return { kind: "failed", code: "credential_inactive", message: RECONNECT };
  if (error instanceof ProviderRequestError) {
    const status = error.status ?? 0;
    if (error.code === "190" || status === 401) return { kind: "failed", code: "credential_inactive", message: "Meta rejected the workspace credential. Reconnect it in Number Center.", providerCode: error.code };
    if (error.code === "timeout" || error.code === "network" || error.code === "ambiguous_success" || status >= 500 || status === 0) {
      return { kind: "uncertain", message: "WhatsApp (Meta) did not confirm whether the template was created. Reconcile before submitting again.", providerCode: error.code };
    }
    return { kind: "failed", code: "provider_rejected", message: `Meta refused the template: ${error.message}`, providerCode: error.code };
  }
  return { kind: "uncertain", message: "The submission was interrupted before Meta's answer was recorded. Reconcile before submitting again.", providerCode: undefined };
}

export async function submitDraft(input: {
  organizationId: number;
  draftId: number;
  expectedRevision: number;
  userId: number | null;
  fetchImpl?: FetchLike;
  hooks?: SubmissionHooks;
  now?: Date;
  /** Refresh the WABA's template list after a confirmed creation (default true). */
  syncAfterSuccess?: boolean;
}): Promise<SubmissionResult> {
  const now = input.now ?? new Date();
  const { organizationId, draftId } = input;

  // Locate the draft's WABA without a lock to pick the advisory key; the
  // locked re-read below verifies nothing moved.
  const [peek] = await db.select({ wabaId: templateDraftsTable.wabaId, state: templateDraftsTable.state })
    .from(templateDraftsTable).where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId)));
  if (!peek) throw new TemplateDraftError("not_found", "Draft not found.", 404);
  if (peek.wabaId === null) throw new TemplateDraftError("invalid_draft", "The draft is not ready to submit.", 400, [{ field: "wabaId", message: "Choose the business account to submit through." }]);
  const wabaId = peek.wabaId;

  // tx1: claim.
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${advisoryKey(organizationId, wabaId)}))`);
    const [waba] = await tx.select().from(wabasTable).where(and(eq(wabasTable.id, wabaId), eq(wabasTable.organizationId, organizationId))).for("share");
    if (!waba) throw new TemplateDraftError("waba_not_eligible", "Business account not found in this workspace.", 400);
    if (waba.credentialId === null) throw new TemplateDraftError("waba_not_eligible", "This business account has no workspace credential; templates cannot be submitted through it.", 400);
    const [credential] = await tx.select({
      id: whatsappCredentialsTable.id, organizationId: whatsappCredentialsTable.organizationId, status: whatsappCredentialsTable.status,
      kind: whatsappCredentialsTable.kind, provider: whatsappCredentialsTable.provider,
    }).from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, waba.credentialId)).for("share");
    if (!credential || credential.organizationId !== organizationId || credential.kind !== CREDENTIAL_KIND_MANUAL_TOKEN || credential.provider !== CREDENTIAL_PROVIDER || credential.status !== "active") {
      throw new TemplateDraftError("credential_inactive", RECONNECT, 409);
    }
    const [draft] = await tx.select().from(templateDraftsTable).where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId))).for("update");
    if (!draft) throw new TemplateDraftError("not_found", "Draft not found.", 404);
    if (draft.wabaId !== wabaId) throw new TemplateDraftError("stale_revision", "This draft changed since you loaded it. Reload it and try again.", 409);
    if (draft.state === "submitting" || draft.state === "reconcile_required") {
      const existing = await activeAttempt(organizationId, draftId);
      throw new TemplateDraftError(
        draft.state === "submitting" ? "attempt_in_progress" : "reconcile_required",
        draft.state === "submitting" ? "A submission for this draft is already in progress." : "The last submission's outcome is unknown. Reconcile it with Meta before submitting again.",
        409, [], existing,
      );
    }
    if (draft.state === "submitted") throw new TemplateDraftError("not_editable", "This draft was already submitted to Meta.", 409);
    if (draft.revision !== input.expectedRevision) throw new TemplateDraftError("stale_revision", "This draft changed since you loaded it. Reload it and try again.", 409);

    // Media example (if any) must be ready, unexpired and for this WABA.
    let mediaHandle: string | undefined;
    const header = draft.content.header;
    if (header.kind === "image" || header.kind === "video" || header.kind === "document") {
      const upload = header.mediaUploadId ? await loadReadyMediaUpload(organizationId, header.mediaUploadId, now) : null;
      const errors = validateDraft(draft, { forSubmission: true, mediaReady: () => Boolean(upload && upload.wabaId === wabaId && upload.kind === header.kind) });
      if (errors.length) throw new TemplateDraftError("invalid_draft", "The draft is not ready to submit.", 400, errors);
      mediaHandle = upload!.providerHandle!;
    } else {
      const errors = validateDraft(draft, { forSubmission: true });
      if (errors.length) throw new TemplateDraftError("invalid_draft", "The draft is not ready to submit.", 400, errors);
    }

    const payload = buildTemplateCreatePayload(draft, mediaHandle);
    let attempt: TemplateSubmissionAttempt;
    try {
      [attempt] = await tx.insert(templateSubmissionAttemptsTable).values({
        organizationId, draftId, draftRevision: draft.revision, wabaId, wabaExternalId: waba.externalId,
        credentialId: credential.id, payload, state: "requested", startedAt: now, createdBy: input.userId,
      }).returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await activeAttempt(organizationId, draftId);
        throw new TemplateDraftError("attempt_in_progress", "A submission for this draft is already in progress.", 409, [], existing);
      }
      throw error;
    }
    await tx.update(templateDraftsTable).set({ state: "submitting", lastError: null, updatedBy: input.userId })
      .where(eq(templateDraftsTable.id, draftId));
    return { attempt, credentialId: credential.id, wabaExternalId: waba.externalId, payload };
  });

  // Network, outside any transaction.
  await input.hooks?.beforeProviderCall?.(claimed.attempt);
  let outcome: Outcome;
  try {
    // The binding made in tx1 must still hold: the WABA still submits
    // through the credential the attempt recorded. A re-association or a
    // revocation in between means no request is made at all.
    const [liveWaba] = await db.select({ credentialId: wabasTable.credentialId, organizationId: wabasTable.organizationId }).from(wabasTable).where(eq(wabasTable.id, wabaId));
    if (!liveWaba || liveWaba.organizationId !== organizationId || liveWaba.credentialId !== claimed.credentialId) {
      throw new SendingCredentialUnavailableError(organizationId, claimed.credentialId, "WABA credential association changed before the request");
    }
    const credential = await resolveSendingCredential(organizationId, claimed.credentialId);
    const client = new ManualMetaClient({ accessToken: credential.accessToken, fetchImpl: input.fetchImpl });
    const created = await client.createTemplate(claimed.wabaExternalId, claimed.payload);
    outcome = { kind: "succeeded", providerTemplateId: created.id, providerStatus: created.status ? normalizeTemplateStatus(created.status) : null, providerCategory: created.category ?? null };
  } catch (error) {
    outcome = classifyOutcome(error);
  }
  await input.hooks?.beforeOutcome?.(claimed.attempt);

  const attempt = await recordOutcome(organizationId, claimed.attempt.id, outcome, input.userId);
  logger.info({ organizationId, draftId, attemptId: attempt.id, outcome: outcome.kind, providerCode: outcome.kind === "succeeded" ? undefined : outcome.providerCode }, "template submission recorded");

  if (outcome.kind === "succeeded" && input.syncAfterSuccess !== false) {
    await refreshFromSync(organizationId, wabaId, draftId, outcome.providerTemplateId, input.fetchImpl);
  }
  const draft = await serializedDraft(organizationId, draftId);
  return { draft, attempt };
}

/**
 * tx2. The attempt row is locked; if a reconciliation already settled it
 * (possible only for a long-stalled request), the later result is kept as
 * a note rather than overwriting the settled state.
 */
async function recordOutcome(organizationId: number, attemptId: number, outcome: Outcome, userId: number | null): Promise<TemplateSubmissionAttempt> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(templateSubmissionAttemptsTable).where(and(eq(templateSubmissionAttemptsTable.organizationId, organizationId), eq(templateSubmissionAttemptsTable.id, attemptId))).for("update");
    if (!attempt) throw new TemplateDraftError("not_found", "Submission attempt not found.", 404);
    if (attempt.state !== "requested") {
      const [noted] = await tx.update(templateSubmissionAttemptsTable)
        .set({ reconcileNote: `${attempt.reconcileNote ?? ""}${attempt.reconcileNote ? " " : ""}Late provider outcome (${outcome.kind}) arrived after the attempt was settled; not applied.`.trim() })
        .where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
      return noted;
    }
    const completedAt = new Date();
    if (outcome.kind === "succeeded") {
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({
        state: "succeeded", providerTemplateId: outcome.providerTemplateId, providerStatus: outcome.providerStatus, providerCategory: outcome.providerCategory, completedAt,
      }).where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
      await tx.update(templateDraftsTable).set({
        state: "submitted", providerTemplateId: outcome.providerTemplateId, providerStatus: outcome.providerStatus, providerStatusCheckedAt: completedAt, lastError: null, updatedBy: userId,
      }).where(and(eq(templateDraftsTable.id, attempt.draftId), eq(templateDraftsTable.state, "submitting")));
      return row;
    }
    if (outcome.kind === "failed") {
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "failed", error: outcome.message, errorCode: outcome.providerCode ?? outcome.code, completedAt })
        .where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
      await tx.update(templateDraftsTable).set({ state: "failed", lastError: outcome.message, updatedBy: userId })
        .where(and(eq(templateDraftsTable.id, attempt.draftId), eq(templateDraftsTable.state, "submitting")));
      return row;
    }
    const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "uncertain", error: outcome.message, errorCode: outcome.providerCode ?? "uncertain" })
      .where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
    await tx.update(templateDraftsTable).set({ state: "reconcile_required", lastError: outcome.message, updatedBy: userId })
      .where(and(eq(templateDraftsTable.id, attempt.draftId), eq(templateDraftsTable.state, "submitting")));
    return row;
  });
}

/** Best-effort: pull the WABA's templates through the hardened sync and link the local row. Never fails the submission. */
async function refreshFromSync(organizationId: number, wabaId: number, draftId: number, providerTemplateId: string, fetchImpl?: FetchLike) {
  try {
    const result = await syncWabaTemplates({ organizationId, wabaId, fetchImpl });
    if (result.status === "failed") {
      logger.info({ organizationId, wabaId, draftId, code: result.error?.code }, "post-submission template sync did not apply");
    }
    const [template] = await db.select({ id: templatesTable.id, status: templatesTable.status }).from(templatesTable)
      .where(and(eq(templatesTable.organizationId, organizationId), eq(templatesTable.providerTemplateId, providerTemplateId)));
    if (template) {
      await db.update(templateDraftsTable).set({ templateId: template.id, providerStatus: template.status, providerStatusCheckedAt: new Date() })
        .where(and(eq(templateDraftsTable.id, draftId), eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.providerTemplateId, providerTemplateId)));
    }
  } catch (error) {
    logger.warn({ organizationId, wabaId, draftId, err: error instanceof Error ? error.name : "unknown" }, "post-submission template sync failed");
  }
}

function mapReadError(error: unknown): TemplateDraftError {
  if (error instanceof SendingCredentialUnavailableError) return new TemplateDraftError("credential_inactive", RECONNECT, 409);
  if (error instanceof ProviderRequestError) {
    if (error.code === "190" || error.status === 401) return new TemplateDraftError("credential_inactive", "Meta rejected the workspace credential. Reconnect it in Number Center.", 409);
    if (error.retryable || (error.status ?? 0) >= 500) return new TemplateDraftError("provider_unavailable", "WhatsApp (Meta) could not be reached. Try again in a moment.", 502);
    return new TemplateDraftError("provider_rejected", `Meta refused the request: ${error.message}`, 502);
  }
  return new TemplateDraftError("provider_unavailable", "WhatsApp (Meta) could not be reached. Try again in a moment.", 502);
}

async function clientForWaba(organizationId: number, wabaId: number) {
  const [waba] = await db.select().from(wabasTable).where(and(eq(wabasTable.id, wabaId), eq(wabasTable.organizationId, organizationId)));
  if (!waba) throw new TemplateDraftError("waba_not_eligible", "Business account not found in this workspace.", 400);
  if (waba.credentialId === null) throw new TemplateDraftError("credential_inactive", RECONNECT, 409);
  let credential;
  try {
    credential = await resolveSendingCredential(organizationId, waba.credentialId);
  } catch (error) {
    throw mapReadError(error);
  }
  return { waba, client: (fetchImpl?: FetchLike) => new ManualMetaClient({ accessToken: credential.accessToken, fetchImpl }) };
}

/**
 * Reconcile an uncertain (or crash-stalled) attempt against the provider.
 * Authoritative evidence only: a template is linked when name, language
 * and content match the recorded payload. Never re-sends the POST.
 */
export async function reconcileDraft(input: {
  organizationId: number;
  draftId: number;
  userId: number | null;
  discardUnconfirmed?: boolean;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<SubmissionResult> {
  const now = input.now ?? new Date();
  const { organizationId, draftId } = input;
  const draft = await serializedDraft(organizationId, draftId);
  const attempt = await activeAttempt(organizationId, draftId);
  if (!attempt || (draft.state !== "reconcile_required" && draft.state !== "submitting")) {
    throw new TemplateDraftError("not_submitted", "There is no unconfirmed submission to reconcile for this draft.", 409);
  }
  if (attempt.state === "requested" && now.getTime() - attempt.startedAt.getTime() < STALE_REQUESTED_MS) {
    throw new TemplateDraftError("attempt_in_progress", "A submission for this draft is still in progress. Wait for it to finish.", 409, [], attempt);
  }

  const { client } = await clientForWaba(organizationId, attempt.wabaId);
  let candidates: MetaTemplate[];
  try {
    candidates = await client(input.fetchImpl).findTemplatesByName(attempt.wabaExternalId, String(attempt.payload.name));
  } catch (error) {
    throw mapReadError(error);
  }
  const sameName = candidates.filter((template) => template.name === attempt.payload.name);
  const matching = sameName.filter((template) => templateMatchesPayload(template, attempt.payload));

  const settled = await db.transaction(async (tx) => {
    const [live] = await tx.select().from(templateSubmissionAttemptsTable).where(eq(templateSubmissionAttemptsTable.id, attempt.id)).for("update");
    if (!live || (live.state !== "requested" && live.state !== "uncertain")) {
      throw new TemplateDraftError("not_submitted", "The submission was settled by another request. Reload the draft.", 409);
    }
    const completedAt = new Date();
    if (matching.length === 1) {
      const template = matching[0];
      const status = normalizeTemplateStatus(template.status);
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({
        state: "succeeded", providerTemplateId: template.id, providerStatus: status, providerCategory: template.category ?? null, completedAt,
        reconcileNote: "Confirmed from Meta: a template with the submitted name, language and content exists.",
      }).where(eq(templateSubmissionAttemptsTable.id, live.id)).returning();
      await tx.update(templateDraftsTable).set({ state: "submitted", providerTemplateId: template.id, providerStatus: status, providerStatusCheckedAt: completedAt, lastError: null, updatedBy: input.userId })
        .where(eq(templateDraftsTable.id, draftId));
      return { row, linked: template.id };
    }
    let note: string;
    if (matching.length > 1) note = `Meta lists ${matching.length} templates matching this submission; a person must pick the right one in Meta Business Manager. Not linked.`;
    else if (sameName.length > 0) note = `A template named "${attempt.payload.name}" exists at Meta but its language or content differs from what was submitted. Not linked.`;
    else note = "Meta lists no template with the submitted name. The request most likely never created one.";
    if (input.discardUnconfirmed && matching.length === 0) {
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "failed", error: "Unconfirmed submission discarded after reconciliation.", errorCode: "discarded_unconfirmed", reconcileNote: note, completedAt })
        .where(eq(templateSubmissionAttemptsTable.id, live.id)).returning();
      await tx.update(templateDraftsTable).set({ state: "failed", lastError: `${note} The draft can be edited and submitted again.`, updatedBy: input.userId })
        .where(eq(templateDraftsTable.id, draftId));
      return { row, linked: null };
    }
    const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "uncertain", reconcileNote: note, error: live.error ?? "Outcome unknown." })
      .where(eq(templateSubmissionAttemptsTable.id, live.id)).returning();
    await tx.update(templateDraftsTable).set({ state: "reconcile_required", lastError: note, updatedBy: input.userId })
      .where(eq(templateDraftsTable.id, draftId));
    return { row, linked: null };
  });
  logger.info({ organizationId, draftId, attemptId: attempt.id, sameName: sameName.length, matching: matching.length, linked: settled.linked !== null, discarded: settled.row.state === "failed" }, "template submission reconciled");
  if (settled.linked) await refreshFromSync(organizationId, attempt.wabaId, draftId, settled.linked, input.fetchImpl);
  return { draft: await serializedDraft(organizationId, draftId), attempt: settled.row };
}

/** One bounded provider read of the submitted template's current status. */
export async function refreshDraftStatus(input: { organizationId: number; draftId: number; userId: number | null; fetchImpl?: FetchLike; now?: Date }): Promise<SerializedDraft> {
  const { organizationId, draftId } = input;
  const draft = await serializedDraft(organizationId, draftId);
  if (draft.state !== "submitted" || !draft.providerTemplateId || draft.wabaId === null) {
    throw new TemplateDraftError("not_submitted", "Only submitted drafts have a Meta status to refresh.", 409);
  }
  const { client } = await clientForWaba(organizationId, draft.wabaId);
  let template: MetaTemplate;
  try {
    template = await client(input.fetchImpl).getTemplate(draft.providerTemplateId);
  } catch (error) {
    throw mapReadError(error);
  }
  const status = normalizeTemplateStatus(template.status);
  const checkedAt = input.now ?? new Date();
  await db.update(templateDraftsTable).set({ providerStatus: status, providerStatusCheckedAt: checkedAt, updatedBy: input.userId })
    .where(and(eq(templateDraftsTable.id, draftId), eq(templateDraftsTable.organizationId, organizationId)));
  // Keep the synced row honest too (same fidelity rules as sync: provider value, never a local promotion).
  await db.update(templatesTable).set({ status })
    .where(and(eq(templatesTable.organizationId, organizationId), eq(templatesTable.providerTemplateId, draft.providerTemplateId)));
  return serializedDraft(organizationId, draftId);
}
