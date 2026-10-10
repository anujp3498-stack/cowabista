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
import { normalizeTemplateStatus, syncWabaTemplates, type TemplateSyncHooks, type WabaTemplateSyncResult } from "./whatsapp-template-sync";
import { buildTemplateCreatePayload, compareTemplateEvidence, validateDraft } from "./template-authoring";
import { TemplateDraftError } from "./template-draft-errors";
import { hydrateDrafts, type SerializedDraft } from "./template-drafts";
import { loadReadyMediaUpload, templateMediaAppId } from "./template-media";

// V2-03B submission lifecycle (hardened in the V2-03B safety correction).
//
// The provider request is a non-idempotent POST /{waba}/message_templates
// (Meta documents no idempotency key), so the protections are all local:
//
//   tx1  under the WABA's advisory lock, lock the credential row FOR SHARE,
//        then the WABA row FOR SHARE, then the draft FOR UPDATE (the same
//        order the sync apply and the credential lifecycle writers use:
//        advisory -> credential -> WABA -> dependent rows). Validate,
//        build the payload, INSERT the attempt (state "requested") and
//        move the draft to "submitting". COMMIT. The partial unique index
//        template_submission_attempts_active_uq keeps a second active
//        attempt per draft impossible in the database.
//   fence re-read the attempt and the WABA binding WITHOUT locks. If the
//        attempt is no longer "requested" (a reconciliation settled a
//        stalled one) or the binding moved, make no request at all.
//        This is a local check followed by an HTTP call: a process that
//        passes the check and then stalls can still POST later. That
//        boundary cannot be closed without an idempotency key Meta does
//        not offer; what the design guarantees is that such a late POST
//        is recorded as late evidence and never silently duplicated by
//        a second local attempt.
//   net  decrypt and POST exactly once, outside any transaction.
//   tx2  lock the attempt and record the outcome:
//        confirmed id  -> attempt succeeded, draft submitted
//        definite 4xx  -> attempt failed, draft failed (editable again)
//        anything else -> attempt uncertain, draft reconcile_required.
//        If the attempt was settled meanwhile, the outcome is persisted as
//        late evidence (never overwriting a settled state), except that a
//        confirmed id may still settle an attempt that is merely
//        "uncertain", because that IS the missing proof.
//
// An unknown outcome is never converted into a retryable failure: an
// empty listing or an elapsed timeout does not prove the POST failed.
// The draft stays reconcile_required and non-resubmittable; the
// (organization, waba, name, language) uniqueness of drafts also blocks a
// second identical submission under a new draft.

export type SubmissionHooks = {
  /** Test barrier: inside tx1, after every lock is held and before the attempt row is written. */
  afterClaimLocks?: () => Promise<void>;
  /** Test barrier: after tx1 committed and before the fence + provider POST. */
  beforeProviderCall?: (attempt: TemplateSubmissionAttempt) => Promise<void>;
  /** Test barrier: after the provider replied and before tx2. */
  beforeOutcome?: (attempt: TemplateSubmissionAttempt) => Promise<void>;
};

export type SubmissionResult = { draft: SerializedDraft; attempt: TemplateSubmissionAttempt };

/** An attempt still "requested" after this long is treated as a crash window and may be reconciled. */
export const STALE_REQUESTED_MS = 2 * 60_000;

const RECONNECT = "The workspace credential for this business account is not active. Reconnect it in Number Center.";
const ACTIVE_ATTEMPT_STATES = ["requested", "uncertain"] as const;

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
    inArray(templateSubmissionAttemptsTable.state, [...ACTIVE_ATTEMPT_STATES]),
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
      return { kind: "uncertain", message: "WhatsApp (Meta) did not confirm whether the template was created. Reconcile before anything else; nothing is retried automatically.", providerCode: error.code };
    }
    return { kind: "failed", code: "provider_rejected", message: `Meta refused the template: ${error.message}`, providerCode: error.code };
  }
  return { kind: "uncertain", message: "The submission was interrupted before Meta's answer was recorded. Reconcile before anything else; nothing is retried automatically.", providerCode: undefined };
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

  // Unlocked preliminary lookup: identifies the WABA and the credential
  // so the locks can be taken in the established order. Everything it
  // read is re-verified under the locks below.
  const [peek] = await db.select({ wabaId: templateDraftsTable.wabaId })
    .from(templateDraftsTable).where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId)));
  if (!peek) throw new TemplateDraftError("not_found", "Draft not found.", 404);
  if (peek.wabaId === null) throw new TemplateDraftError("invalid_draft", "The draft is not ready to submit.", 400, [{ field: "wabaId", message: "Choose the business account to submit through." }]);
  const wabaId = peek.wabaId;
  const [peekWaba] = await db.select({ credentialId: wabasTable.credentialId }).from(wabasTable).where(and(eq(wabasTable.id, wabaId), eq(wabasTable.organizationId, organizationId)));
  if (!peekWaba) throw new TemplateDraftError("waba_not_eligible", "Business account not found in this workspace.", 400);
  if (peekWaba.credentialId === null) throw new TemplateDraftError("waba_not_eligible", "This business account has no workspace credential; templates cannot be submitted through it.", 400);
  const credentialId = peekWaba.credentialId;

  // tx1: claim. Lock order: advisory -> credential (FOR SHARE) -> WABA
  // (FOR SHARE) -> draft (FOR UPDATE). Same as the sync apply transaction
  // and compatible with connectManualNumber (credential row, then WABA
  // row) and revokeCredential (credential row, then phones).
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${advisoryKey(organizationId, wabaId)}))`);
    const [credential] = await tx.select({
      id: whatsappCredentialsTable.id, organizationId: whatsappCredentialsTable.organizationId, status: whatsappCredentialsTable.status,
      kind: whatsappCredentialsTable.kind, provider: whatsappCredentialsTable.provider,
    }).from(whatsappCredentialsTable).where(eq(whatsappCredentialsTable.id, credentialId)).for("share");
    if (!credential || credential.organizationId !== organizationId || credential.kind !== CREDENTIAL_KIND_MANUAL_TOKEN || credential.provider !== CREDENTIAL_PROVIDER || credential.status !== "active") {
      throw new TemplateDraftError("credential_inactive", RECONNECT, 409);
    }
    const [waba] = await tx.select().from(wabasTable).where(and(eq(wabasTable.id, wabaId), eq(wabasTable.organizationId, organizationId))).for("share");
    if (!waba) throw new TemplateDraftError("waba_not_eligible", "Business account not found in this workspace.", 400);
    // The association read before the locks must still hold now.
    if (waba.credentialId !== credential.id) throw new TemplateDraftError("credential_inactive", "The business account's credential changed. Reload and try again.", 409);
    const [draft] = await tx.select().from(templateDraftsTable).where(and(eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.id, draftId))).for("update");
    if (!draft) throw new TemplateDraftError("not_found", "Draft not found.", 404);
    if (draft.wabaId !== wabaId) throw new TemplateDraftError("stale_revision", "This draft changed since you loaded it. Reload it and try again.", 409);
    if (draft.state === "submitting" || draft.state === "reconcile_required") {
      const existing = await activeAttempt(organizationId, draftId);
      throw new TemplateDraftError(
        draft.state === "submitting" ? "attempt_in_progress" : "reconcile_required",
        draft.state === "submitting" ? "A submission for this draft is already in progress." : "The last submission's outcome is unknown. Reconcile it with Meta; it cannot be submitted again.",
        409, [], existing,
      );
    }
    if (draft.state === "submitted") throw new TemplateDraftError("not_editable", "This draft was already submitted to Meta.", 409);
    if (draft.revision !== input.expectedRevision) throw new TemplateDraftError("stale_revision", "This draft changed since you loaded it. Reload it and try again.", 409);

    let mediaHandle: string | undefined;
    const header = draft.content.header;
    if (header.kind === "image" || header.kind === "video" || header.kind === "document") {
      const upload = header.mediaUploadId ? await loadReadyMediaUpload(organizationId, header.mediaUploadId, now) : null;
      // Handle provenance (app binding): Meta documents no rule for using a
      // Resumable Upload handle under another token or app, so a handle is
      // only submitted through the SAME credential (the one locked above)
      // and the SAME configured Meta app that produced it. A replaced or
      // missing credential, a changed or missing WHATSAPP_APP_ID: fail
      // closed here, before any Meta request, with the field-level
      // "upload it again" error. Nothing internal is put in the error.
      const currentAppId = templateMediaAppId();
      const errors = validateDraft(draft, { forSubmission: true, mediaReady: () => Boolean(
        upload && upload.wabaId === wabaId && upload.kind === header.kind
        && upload.credentialId !== null && upload.credentialId === credential.id
        && currentAppId !== null && upload.appId === currentAppId,
      ) });
      if (errors.length) throw new TemplateDraftError("invalid_draft", "The draft is not ready to submit.", 400, errors);
      mediaHandle = upload!.providerHandle!;
    } else {
      const errors = validateDraft(draft, { forSubmission: true });
      if (errors.length) throw new TemplateDraftError("invalid_draft", "The draft is not ready to submit.", 400, errors);
    }

    await input.hooks?.afterClaimLocks?.();
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
      .where(and(eq(templateDraftsTable.id, draftId), eq(templateDraftsTable.organizationId, organizationId)));
    return { attempt, credentialId: credential.id, wabaExternalId: waba.externalId, payload };
  });

  await input.hooks?.beforeProviderCall?.(claimed.attempt);

  // Fence (unlocked): a stalled claim that a reconciliation already settled
  // must not go on to POST. See the boundary note at the top of the file.
  const [fence] = await db.select({ state: templateSubmissionAttemptsTable.state }).from(templateSubmissionAttemptsTable)
    .where(and(eq(templateSubmissionAttemptsTable.id, claimed.attempt.id), eq(templateSubmissionAttemptsTable.organizationId, organizationId)));
  if (!fence || fence.state !== "requested") {
    logger.warn({ organizationId, draftId, attemptId: claimed.attempt.id, state: fence?.state ?? "missing" }, "template submission attempt was settled before its request was made; no request sent");
    const [current] = await db.select().from(templateSubmissionAttemptsTable).where(eq(templateSubmissionAttemptsTable.id, claimed.attempt.id));
    return { draft: await serializedDraft(organizationId, draftId), attempt: current ?? claimed.attempt };
  }

  // Network, outside any transaction.
  let outcome: Outcome;
  try {
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
  logger.info({ organizationId, draftId, attemptId: attempt.id, outcome: outcome.kind, attemptState: attempt.state, providerCode: outcome.kind === "succeeded" ? undefined : outcome.providerCode }, "template submission recorded");

  if (attempt.state === "succeeded" && attempt.providerTemplateId && input.syncAfterSuccess !== false) {
    await linkThroughSync(organizationId, wabaId, draftId, attempt.providerTemplateId, input.fetchImpl);
  }
  return { draft: await serializedDraft(organizationId, draftId), attempt };
}

/**
 * tx2. Records the provider outcome for an attempt. A settled attempt is
 * never overwritten; the late outcome is persisted on the row instead.
 * One exception: a confirmed provider id settles an attempt that is
 * still merely "uncertain", because it is exactly the proof that was
 * missing.
 */
async function recordOutcome(organizationId: number, attemptId: number, outcome: Outcome, userId: number | null): Promise<TemplateSubmissionAttempt> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(templateSubmissionAttemptsTable)
      .where(and(eq(templateSubmissionAttemptsTable.organizationId, organizationId), eq(templateSubmissionAttemptsTable.id, attemptId))).for("update");
    if (!attempt) throw new TemplateDraftError("not_found", "Submission attempt not found.", 404);
    const completedAt = new Date();
    const draftWhere = (state: string) => (attempt.draftId === null
      ? undefined
      : and(eq(templateDraftsTable.id, attempt.draftId), eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.state, state)));

    const settled = attempt.state !== "requested";
    const confirmsUncertain = settled && attempt.state === "uncertain" && outcome.kind === "succeeded";
    if (settled && !confirmsUncertain) {
      const sameId = outcome.kind === "succeeded" && attempt.providerTemplateId === outcome.providerTemplateId;
      const note = sameId
        ? "Late provider reply confirmed the same template id the reconciliation had linked."
        : `Late provider outcome (${outcome.kind}${outcome.kind === "succeeded" ? ` id ${outcome.providerTemplateId}` : ""}) arrived after the attempt was settled as ${attempt.state}; recorded, not applied.`;
      const [noted] = await tx.update(templateSubmissionAttemptsTable).set({
        lateProviderTemplateId: outcome.kind === "succeeded" ? outcome.providerTemplateId : attempt.lateProviderTemplateId,
        lateOutcome: { ...outcome, recordedAt: completedAt.toISOString() },
        lateOutcomeAt: completedAt,
        reconcileNote: `${attempt.reconcileNote ? `${attempt.reconcileNote} ` : ""}${note}`,
      }).where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
      if (!sameId) logger.warn({ organizationId, attemptId, settledState: attempt.state, lateOutcome: outcome.kind }, "late template submission outcome recorded without being applied");
      return noted;
    }

    if (outcome.kind === "succeeded") {
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({
        state: "succeeded", providerTemplateId: outcome.providerTemplateId, providerStatus: outcome.providerStatus, providerCategory: outcome.providerCategory, completedAt,
        ...(confirmsUncertain ? { reconcileNote: `${attempt.reconcileNote ? `${attempt.reconcileNote} ` : ""}The provider's delayed reply confirmed creation (id ${outcome.providerTemplateId}).` } : {}),
      }).where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
      const where = draftWhere(confirmsUncertain ? "reconcile_required" : "submitting");
      if (where) {
        await tx.update(templateDraftsTable).set({
          state: "submitted", providerTemplateId: outcome.providerTemplateId, providerStatus: outcome.providerStatus, providerStatusCheckedAt: completedAt, lastError: null, updatedBy: userId,
        }).where(where);
      }
      return row;
    }
    if (outcome.kind === "failed") {
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "failed", error: outcome.message, errorCode: outcome.providerCode ?? outcome.code, completedAt })
        .where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
      const where = draftWhere("submitting");
      if (where) await tx.update(templateDraftsTable).set({ state: "failed", lastError: outcome.message, updatedBy: userId }).where(where);
      return row;
    }
    const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "uncertain", error: outcome.message, errorCode: outcome.providerCode ?? "uncertain" })
      .where(eq(templateSubmissionAttemptsTable.id, attemptId)).returning();
    const where = draftWhere("submitting");
    if (where) await tx.update(templateDraftsTable).set({ state: "reconcile_required", lastError: outcome.message, updatedBy: userId }).where(where);
    return row;
  });
}

/**
 * The ONLY path that writes provider status for a submitted draft's
 * template: the hardened per-WABA sync (generation-ordered, credential
 * and WABA association revalidated under row locks, Removed marking).
 * Afterwards the draft is linked to the synced row. Returns the sync
 * result so callers can tell "applied" from "failed" or "superseded".
 */
async function linkThroughSync(organizationId: number, wabaId: number, draftId: number, providerTemplateId: string, fetchImpl?: FetchLike, hooks?: TemplateSyncHooks): Promise<WabaTemplateSyncResult> {
  const result = await syncWabaTemplates({ organizationId, wabaId, fetchImpl, hooks });
  if (result.status !== "synced") {
    logger.info({ organizationId, wabaId, draftId, status: result.status, code: result.error?.code }, "template sync after submission did not apply this snapshot");
  }
  // Linking is safe whatever the sync outcome: the row (if present) is the
  // latest APPLIED snapshot, never this call's possibly-superseded fetch.
  const [template] = await db.select({ id: templatesTable.id }).from(templatesTable)
    .where(and(eq(templatesTable.organizationId, organizationId), eq(templatesTable.providerTemplateId, providerTemplateId)));
  if (template) {
    await db.update(templateDraftsTable).set({ templateId: template.id })
      .where(and(eq(templateDraftsTable.id, draftId), eq(templateDraftsTable.organizationId, organizationId), eq(templateDraftsTable.providerTemplateId, providerTemplateId)));
  }
  return result;
}

function mapReadError(error: unknown): TemplateDraftError {
  if (error instanceof SendingCredentialUnavailableError) return new TemplateDraftError("credential_inactive", RECONNECT, 409);
  if (error instanceof ProviderRequestError) {
    if (error.code === "190" || error.status === 401) return new TemplateDraftError("credential_inactive", "Meta rejected the workspace credential. Reconnect it in Number Center.", 409);
    if (error.retryable || (error.status ?? 0) >= 500) return new TemplateDraftError("provider_unavailable", "WhatsApp (Meta) could not be reached or returned an incomplete listing. Try again in a moment.", 502);
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
 * Authoritative evidence only: a template is linked when name, language,
 * component structure, texts and button destinations match the recorded
 * payload exactly (media headers: format only, reported as such). Several
 * matches or none leave the attempt unresolved. Never re-sends the POST
 * and never turns an unknown outcome into a retryable failure. The caller
 * names the attempt it is looking at so a stale client cannot act on a
 * newer one; concurrent reconciliations converge on the same settled row.
 */
export async function reconcileDraft(input: {
  organizationId: number;
  draftId: number;
  attemptId: number;
  userId: number | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<SubmissionResult> {
  const now = input.now ?? new Date();
  const { organizationId, draftId } = input;
  const [attempt] = await db.select().from(templateSubmissionAttemptsTable).where(and(
    eq(templateSubmissionAttemptsTable.organizationId, organizationId),
    eq(templateSubmissionAttemptsTable.id, input.attemptId),
    eq(templateSubmissionAttemptsTable.draftId, draftId),
  ));
  if (!attempt) throw new TemplateDraftError("not_found", "Submission attempt not found for this draft.", 404);
  const latest = await db.select({ id: templateSubmissionAttemptsTable.id }).from(templateSubmissionAttemptsTable)
    .where(and(eq(templateSubmissionAttemptsTable.organizationId, organizationId), eq(templateSubmissionAttemptsTable.draftId, draftId)))
    .orderBy(desc(templateSubmissionAttemptsTable.id)).limit(1);
  if (latest[0]?.id !== attempt.id) throw new TemplateDraftError("stale_attempt", "A newer submission attempt exists for this draft. Reload the draft.", 409, [], attempt);
  if (attempt.state === "succeeded" || attempt.state === "failed") {
    // Already settled (possibly by a concurrent reconciliation): converge.
    return { draft: await serializedDraft(organizationId, draftId), attempt };
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
  const evidence = sameName.map((template) => ({ template, evidence: compareTemplateEvidence(template, attempt.payload) }));
  const matching = evidence.filter((item) => item.evidence.verdict === "match");
  const insufficient = evidence.filter((item) => item.evidence.verdict === "insufficient");

  const settled = await db.transaction(async (tx) => {
    const [live] = await tx.select().from(templateSubmissionAttemptsTable)
      .where(and(eq(templateSubmissionAttemptsTable.id, attempt.id), eq(templateSubmissionAttemptsTable.organizationId, organizationId))).for("update");
    if (!live) throw new TemplateDraftError("not_found", "Submission attempt not found.", 404);
    if (live.state === "succeeded" || live.state === "failed") return { row: live, linked: null, converged: true };
    const completedAt = new Date();
    const draftWhere = and(eq(templateDraftsTable.id, draftId), eq(templateDraftsTable.organizationId, organizationId));
    if (matching.length === 1 && insufficient.length === 0) {
      const { template, evidence: proof } = matching[0];
      const status = normalizeTemplateStatus(template.status);
      const note = proof.verdict === "match" && proof.mediaUnverified
        ? "Confirmed from Meta: name, language, texts, buttons and header format match the submitted template. The media example itself cannot be compared from a listing."
        : "Confirmed from Meta: name, language and every component match the submitted template.";
      const [row] = await tx.update(templateSubmissionAttemptsTable).set({
        state: "succeeded", providerTemplateId: template.id, providerStatus: status, providerCategory: template.category ?? null, completedAt, reconcileNote: note,
      }).where(eq(templateSubmissionAttemptsTable.id, live.id)).returning();
      await tx.update(templateDraftsTable).set({ state: "submitted", providerTemplateId: template.id, providerStatus: status, providerStatusCheckedAt: completedAt, lastError: null, updatedBy: input.userId })
        .where(draftWhere);
      return { row, linked: template.id, converged: false };
    }
    let note: string;
    if (matching.length > 1) note = `Meta lists ${matching.length} templates matching this submission; a person must identify the right one in Meta Business Manager. Not linked.`;
    else if (insufficient.length) note = `Meta's listing for "${attempt.payload.name}" could not be compared (${insufficient[0].evidence.verdict === "insufficient" ? insufficient[0].evidence.reason : "incomplete"}). Not linked; try again later.`;
    else if (sameName.length) note = `A template named "${attempt.payload.name}" exists at Meta but differs from what was submitted (${evidence[0].evidence.verdict === "mismatch" ? evidence[0].evidence.reason : "content differs"}). Not linked.`;
    else note = "Meta lists no template with the submitted name yet. This does not prove the request failed; check again later. The draft cannot be submitted again.";
    const [row] = await tx.update(templateSubmissionAttemptsTable).set({ state: "uncertain", reconcileNote: note, error: live.error ?? "Outcome unknown." })
      .where(eq(templateSubmissionAttemptsTable.id, live.id)).returning();
    await tx.update(templateDraftsTable).set({ state: "reconcile_required", lastError: note, updatedBy: input.userId }).where(draftWhere);
    return { row, linked: null, converged: false };
  });
  logger.info({ organizationId, draftId, attemptId: attempt.id, sameName: sameName.length, matching: matching.length, insufficient: insufficient.length, linked: settled.linked !== null, converged: settled.converged }, "template submission reconciled");
  if (settled.linked) await linkThroughSync(organizationId, attempt.wabaId, draftId, settled.linked, input.fetchImpl);
  return { draft: await serializedDraft(organizationId, draftId), attempt: settled.row };
}

/**
 * Status refresh = the hardened per-WABA sync, nothing weaker. The sync
 * reserves a generation, fetches the complete listing outside any
 * transaction, revalidates tenant, WABA, credential (activity, kind,
 * provider, revision) under row locks and applies only if no newer
 * snapshot was applied; missing templates become Removed with their
 * metadata. The draft then shows the APPLIED row's status. A failed or
 * superseded sync does not claim a fresh status.
 */
export async function refreshDraftStatus(input: { organizationId: number; draftId: number; userId: number | null; fetchImpl?: FetchLike; now?: Date; hooks?: TemplateSyncHooks }): Promise<SerializedDraft> {
  const { organizationId, draftId } = input;
  const draft = await serializedDraft(organizationId, draftId);
  if (draft.state !== "submitted" || !draft.providerTemplateId || draft.wabaId === null) {
    throw new TemplateDraftError("not_submitted", "Only submitted drafts have a Meta status to refresh.", 409);
  }
  const result = await linkThroughSync(organizationId, draft.wabaId, draftId, draft.providerTemplateId, input.fetchImpl, input.hooks);
  if (result.status === "failed") {
    const code = result.error?.code === "credential_inactive" ? "credential_inactive" : result.error?.code === "provider_rejected" ? "provider_rejected" : "provider_unavailable";
    throw new TemplateDraftError(code, result.error?.message ?? "Could not refresh the status from Meta.", code === "credential_inactive" ? 409 : 502);
  }
  if (result.status === "superseded") {
    throw new TemplateDraftError("sync_superseded", "A newer synchronisation of this business account finished first; the status shown is from that newer result, not from this refresh.", 409);
  }
  return serializedDraft(organizationId, draftId);
}
