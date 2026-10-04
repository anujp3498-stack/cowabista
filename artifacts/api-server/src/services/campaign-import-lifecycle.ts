import { and, eq, sql } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignsTable,
  contactImportSessionsTable,
  db,
  type ContactImportSession,
} from "@workspace/db";
import { withCampaignLifecycleLock } from "./campaign-planning";

export type ContactImportOperation = "append" | "replace";

export type InitializeContactImportInput = {
  organizationId: number;
  campaignId: number;
  idempotencyKey: string;
  fileName: string;
  phoneColumn?: string;
  defaultCountryCode?: string;
  operation?: ContactImportOperation;
};

export type AudienceConflictCode =
  | "reopen_required"
  | "not_draft"
  | "execution_history"
  | "import_in_progress"
  | "idempotency_mismatch"
  | "fenced";

export type InitializeContactImportResult =
  | { ok: true; replay: boolean; campaign: { id: number; status: string; audienceGeneration: number }; session: ContactImportSession }
  | { ok: false; status: 404 | 409; code?: AudienceConflictCode; message: string };

type CampaignTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class CampaignImportFencedError extends Error {
  constructor(message = "Campaign contact import is no longer active") {
    super(message);
    this.name = "CampaignImportFencedError";
  }
}

/**
 * True once the campaign has any job row (queued, sent, failed, cancelled --
 * all of it is history). Provider work always hangs off a job, so jobs are
 * the complete signal. A campaign with execution history must never have
 * its audience appended, replaced or re-planned from Draft: the frozen
 * plan, its allocations and the `send:` idempotency keys derived from the
 * contacts' canonical keys are what guarantees no recipient is sent twice.
 */
export async function hasExecutionHistory(
  tx: Pick<typeof db, "select">,
  organizationId: number,
  campaignId: number,
): Promise<boolean> {
  const [job] = await tx.select({ id: campaignJobsTable.id }).from(campaignJobsTable).where(and(
    eq(campaignJobsTable.organizationId, organizationId),
    eq(campaignJobsTable.campaignId, campaignId),
  )).limit(1);
  return Boolean(job);
}

/**
 * Per-batch fence, called inside every short batch transaction of a
 * streaming import: the campaign must still be Draft (locked FOR UPDATE so
 * a concurrent cancel/plan serializes against this batch), the session
 * must still be Processing, and the session's audience generation must
 * still be writable -- an append whose generation is no longer the active
 * one (a replace activated meanwhile) or a replace whose staged generation
 * has already been passed is a stale batch and must not land.
 */
export async function assertContactImportWritable(
  tx: CampaignTransaction,
  organizationId: number,
  campaignId: number,
  sessionId: number,
): Promise<{ audienceGeneration: number; operation: string }> {
  const [campaign] = await tx.select({
    status: campaignsTable.status,
    audienceGeneration: campaignsTable.audienceGeneration,
  }).from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  )).for("update");
  const [session] = await tx.select({
    status: contactImportSessionsTable.status,
    operation: contactImportSessionsTable.operation,
    audienceGeneration: contactImportSessionsTable.audienceGeneration,
  })
    .from(contactImportSessionsTable)
    .where(and(
      eq(contactImportSessionsTable.id, sessionId),
      eq(contactImportSessionsTable.organizationId, organizationId),
      eq(contactImportSessionsTable.campaignId, campaignId),
    ))
    .for("update");
  if (campaign?.status !== "Draft" || session?.status !== "Processing") {
    throw new CampaignImportFencedError(
      campaign?.status === "Cancelled"
        ? "Campaign was cancelled during contact import"
        : "Campaign contact import is no longer active",
    );
  }
  const generationOk = session.operation === "replace"
    ? campaign.audienceGeneration < session.audienceGeneration
    : campaign.audienceGeneration === session.audienceGeneration;
  if (!generationOk) {
    throw new CampaignImportFencedError("Campaign audience changed during contact import; this upload is stale");
  }
  return { audienceGeneration: session.audienceGeneration, operation: session.operation };
}

function sameConfig(session: ContactImportSession, input: InitializeContactImportInput): boolean {
  return (session.phoneColumn ?? null) === (input.phoneColumn ?? null)
    && (session.defaultCountryCode ?? null) === (input.defaultCountryCode ?? null)
    && session.operation === (input.operation ?? "append");
}

/**
 * Creates (or resumes / replays) an import session under the campaign
 * lifecycle lock, so it can never interleave with plan()/execute()/reopen
 * or another import's initialization. The lock is held only for this
 * transaction, never across the upload; batches use the per-batch fence.
 *
 * Lifecycle rules (stable codes):
 *  - Ready without execution history -> 409 reopen_required (the client
 *    reopens explicitly; an upload never silently invalidates a plan).
 *  - any other non-Draft status (Paused included; never reset) -> not_draft.
 *  - any job exists -> execution_history (also for a Draft campaign).
 *  - another session Processing -> import_in_progress.
 *  - idempotency key seen with another campaign or another upload
 *    configuration (phone column, country code, operation) ->
 *    idempotency_mismatch; same key + same config after completion -> replay.
 */
export async function initializeContactImport(
  input: InitializeContactImportInput,
): Promise<InitializeContactImportResult> {
  const operation: ContactImportOperation = input.operation ?? "append";
  return withCampaignLifecycleLock(input.campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${String(input.organizationId)}),
        hashtext(${input.idempotencyKey})
      )
    `);
    const [campaign] = await tx.select({
      id: campaignsTable.id,
      status: campaignsTable.status,
      audienceGeneration: campaignsTable.audienceGeneration,
    }).from(campaignsTable).where(and(
      eq(campaignsTable.id, input.campaignId),
      eq(campaignsTable.organizationId, input.organizationId),
    )).for("update");
    if (!campaign) return { ok: false, status: 404, message: "Campaign not found" };

    let [session] = await tx.select().from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.organizationId, input.organizationId),
      eq(contactImportSessionsTable.idempotencyKey, input.idempotencyKey),
    ));
    if (session && session.campaignId !== input.campaignId) {
      return { ok: false, status: 409, code: "idempotency_mismatch", message: "This import idempotency key belongs to a different campaign" };
    }
    if (session && !sameConfig(session, input)) {
      return {
        ok: false,
        status: 409,
        code: "idempotency_mismatch",
        message: "This import idempotency key was already used with a different upload configuration (phone column, country code or operation); use a new key",
      };
    }
    if (session?.status === "Completed") {
      return { ok: true, replay: true, campaign, session };
    }

    if (campaign.status !== "Draft") {
      if (campaign.status === "Ready") {
        const history = await hasExecutionHistory(tx, input.organizationId, input.campaignId);
        return history
          ? { ok: false, status: 409, code: "execution_history", message: "This campaign already has execution history; its audience can no longer change" }
          : { ok: false, status: 409, code: "reopen_required", message: "This campaign is Ready; reopen it to edit the audience (its frozen plan will be invalidated)" };
      }
      return {
        ok: false,
        status: 409,
        code: "not_draft",
        message: campaign.status === "Paused"
          ? "A paused campaign keeps its audience; it cannot be edited or reset to Draft"
          : `Contacts can only be imported while the campaign is Draft (current status: ${campaign.status})`,
      };
    }
    if (await hasExecutionHistory(tx, input.organizationId, input.campaignId)) {
      return { ok: false, status: 409, code: "execution_history", message: "This campaign already has execution history; its audience can no longer change" };
    }

    const [activeImport] = await tx.select({ id: contactImportSessionsTable.id })
      .from(contactImportSessionsTable)
      .where(and(
        eq(contactImportSessionsTable.organizationId, input.organizationId),
        eq(contactImportSessionsTable.campaignId, input.campaignId),
        eq(contactImportSessionsTable.status, "Processing"),
      ))
      .limit(1);
    if (activeImport) {
      return {
        ok: false,
        status: 409,
        code: "import_in_progress",
        message: activeImport.id === session?.id
          ? "This contact import is already processing"
          : "Another contact import is already processing for this campaign",
      };
    }

    if (!session) {
      let audienceGeneration = campaign.audienceGeneration;
      if (operation === "replace") {
        const [{ maxStaged }] = await tx.select({
          maxStaged: sql<number>`coalesce(max(${contactImportSessionsTable.audienceGeneration}), 0)`,
        }).from(contactImportSessionsTable).where(and(
          eq(contactImportSessionsTable.organizationId, input.organizationId),
          eq(contactImportSessionsTable.campaignId, input.campaignId),
        ));
        audienceGeneration = Math.max(campaign.audienceGeneration, maxStaged) + 1;
      }
      [session] = await tx.insert(contactImportSessionsTable).values({
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        idempotencyKey: input.idempotencyKey,
        fileName: input.fileName,
        phoneColumn: input.phoneColumn,
        defaultCountryCode: input.defaultCountryCode,
        operation,
        audienceGeneration,
      }).returning();
    } else {
      // Resuming a Failed/interrupted session: its generation must still be
      // writable, otherwise the rows it already wrote belong to a superseded
      // audience and continuing would be a stale batch.
      const resumable = session.operation === "replace"
        ? campaign.audienceGeneration < session.audienceGeneration
        : campaign.audienceGeneration === session.audienceGeneration;
      if (!resumable) {
        return { ok: false, status: 409, code: "fenced", message: "The campaign audience changed since this upload started; start a new import" };
      }
      [session] = await tx.update(contactImportSessionsTable).set({
        status: "Processing",
        error: null,
      }).where(eq(contactImportSessionsTable.id, session.id)).returning();
    }
    return { ok: true, replay: false, campaign, session: session! };
  }));
}

/**
 * Cumulative audience counts over the completed sessions of one generation
 * (cheap: sums session counters; never scans contacts).
 */
export async function audienceTotals(
  tx: Pick<typeof db, "select">,
  organizationId: number,
  campaignId: number,
  audienceGeneration: number,
): Promise<{ rows: number; valid: number; invalid: number; duplicates: number; suppressed: number; sessions: number }> {
  const [totals] = await tx.select({
    rows: sql<number>`coalesce(sum(greatest(${contactImportSessionsTable.rowsProcessed} - 1, 0)), 0)::int`,
    valid: sql<number>`coalesce(sum(${contactImportSessionsTable.validRows}), 0)::int`,
    invalid: sql<number>`coalesce(sum(${contactImportSessionsTable.invalidRows}), 0)::int`,
    duplicates: sql<number>`coalesce(sum(${contactImportSessionsTable.duplicateRows}), 0)::int`,
    suppressed: sql<number>`coalesce(sum(${contactImportSessionsTable.suppressedRows}), 0)::int`,
    sessions: sql<number>`count(*)::int`,
  }).from(contactImportSessionsTable).where(and(
    eq(contactImportSessionsTable.organizationId, organizationId),
    eq(contactImportSessionsTable.campaignId, campaignId),
    eq(contactImportSessionsTable.audienceGeneration, audienceGeneration),
    eq(contactImportSessionsTable.status, "Completed"),
  ));
  return totals!;
}

/**
 * Completion transaction of a streaming import: re-checks the fence, marks
 * the session Completed, and -- for a replace -- atomically activates the
 * staged generation (the previous audience stays the campaign's audience
 * right up to this commit, and remains if the upload fails before it).
 * Metrics and audienceSize are recomputed from the active generation's
 * completed sessions so append and replace both leave consistent totals.
 */
export async function completeContactImport(
  organizationId: number,
  campaignId: number,
  sessionId: number,
  bytesProcessed: number,
  actorUserId?: number,
): Promise<ContactImportSession> {
  return db.transaction(async (tx) => {
    const fence = await assertContactImportWritable(tx, organizationId, campaignId, sessionId);
    const now = new Date();
    const [session] = await tx.update(contactImportSessionsTable)
      .set({ status: "Completed", bytesProcessed, activatedAt: fence.operation === "replace" ? now : null })
      .where(and(
        eq(contactImportSessionsTable.id, sessionId),
        eq(contactImportSessionsTable.status, "Processing"),
      ))
      .returning();
    if (!session) throw new CampaignImportFencedError();
    const [before] = await tx.select({
      status: campaignsTable.status,
      audienceGeneration: campaignsTable.audienceGeneration,
    }).from(campaignsTable).where(eq(campaignsTable.id, campaignId));
    if (fence.operation === "replace") {
      await tx.update(campaignsTable).set({ audienceGeneration: session.audienceGeneration }).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.status, "Draft"),
      ));
    }
    const totals = await audienceTotals(tx, organizationId, campaignId, session.audienceGeneration);
    const [queueCounts] = await tx.select({
      queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
    }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));
    const metrics = {
      total: totals.rows,
      valid: totals.valid,
      invalid: totals.invalid,
      deduplicated: totals.duplicates,
      suppressed: totals.suppressed,
      queued: queueCounts?.queued ?? 0,
    };
    await tx.insert(campaignMetricsTable).values({ organizationId, campaignId, ...metrics }).onConflictDoUpdate({
      target: campaignMetricsTable.campaignId,
      set: { ...metrics, updatedAt: now },
    });
    await tx.update(campaignsTable).set({ audienceSize: totals.valid }).where(and(
      eq(campaignsTable.id, campaignId),
      eq(campaignsTable.status, "Draft"),
    ));
    await tx.insert(campaignAuditTable).values({
      organizationId,
      campaignId,
      actorUserId,
      action: fence.operation === "replace" ? "audience_replaced" : "audience_appended",
      fromStatus: before?.status ?? "Draft",
      toStatus: before?.status ?? "Draft",
      metadata: {
        importSessionId: session.id,
        audienceGeneration: session.audienceGeneration,
        previousAudienceGeneration: before?.audienceGeneration ?? 0,
        valid: totals.valid,
        invalid: totals.invalid,
        duplicates: totals.duplicates,
        suppressed: totals.suppressed,
      },
    });
    return session;
  });
}

export class CampaignReopenError extends Error {
  constructor(public readonly code: AudienceConflictCode | "not_found", message: string) {
    super(message);
    this.name = "CampaignReopenError";
  }
}

/**
 * Ready -> Draft under the lifecycle lock: supersedes the active plan so a
 * later schedule/execute can only run against a fresh plan of the edited
 * audience/setup. Refused once any job exists (the plan is then history
 * that jobs reference) and never applied to Scheduled/Running/Paused.
 * Idempotent on Draft.
 */
export async function reopenCampaign(
  organizationId: number,
  campaignId: number,
  actorUserId?: number,
): Promise<{ status: string; changed: boolean }> {
  return withCampaignLifecycleLock(campaignId, (scopedDb) => scopedDb.transaction(async (tx) => {
    const [campaign] = await tx.select({ id: campaignsTable.id, status: campaignsTable.status })
      .from(campaignsTable).where(and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.organizationId, organizationId),
      )).for("update");
    if (!campaign) throw new CampaignReopenError("not_found", "Campaign not found");
    if (campaign.status === "Draft") return { status: "Draft", changed: false };
    if (campaign.status !== "Ready") {
      throw new CampaignReopenError(
        "not_draft",
        campaign.status === "Paused"
          ? "A paused campaign cannot be reset to Draft"
          : `Only a Ready campaign can be reopened (current status: ${campaign.status})`,
      );
    }
    if (await hasExecutionHistory(tx, organizationId, campaignId)) {
      throw new CampaignReopenError("execution_history", "This campaign already has execution history and cannot be reopened");
    }
    const superseded = await tx.update(campaignPlansTable).set({ status: "Superseded" }).where(and(
      eq(campaignPlansTable.campaignId, campaignId),
      eq(campaignPlansTable.status, "Active"),
    )).returning({ id: campaignPlansTable.id });
    await tx.update(campaignsTable).set({ status: "Draft" }).where(and(
      eq(campaignsTable.id, campaignId),
      eq(campaignsTable.status, "Ready"),
    ));
    await tx.insert(campaignAuditTable).values({
      organizationId,
      campaignId,
      actorUserId,
      action: "reopen",
      fromStatus: "Ready",
      toStatus: "Draft",
      metadata: { supersededPlanIds: superseded.map((plan) => plan.id) },
    });
    return { status: "Draft", changed: true };
  }));
}

/**
 * Pre-execution setup edits (routes, Rocket setup) inside a transaction that
 * already holds the campaign lifecycle lock. Allowed while Draft or Ready
 * with no execution history and no import processing; a Ready campaign is
 * moved back to Draft with its plan superseded in the same transaction, so
 * a stale plan can never be scheduled/executed against the edited setup.
 * Imported recipients are untouched. Returns an error (with a stable code)
 * instead of throwing so callers keep their existing response shape.
 */
export async function assertSetupEditable(
  tx: CampaignTransaction,
  organizationId: number,
  campaignId: number,
  actorUserId?: number,
): Promise<{ ok: true } | { ok: false; code: AudienceConflictCode | "setup_locked"; message: string }> {
  const [campaign] = await tx.select({ status: campaignsTable.status }).from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  )).for("update");
  if (!campaign) return { ok: false, code: "setup_locked", message: "Campaign not found" };
  if (!["Draft", "Ready"].includes(campaign.status)) {
    return { ok: false, code: "setup_locked", message: `Setup can only change while the campaign is Draft or Ready (current status: ${campaign.status})` };
  }
  if (await hasExecutionHistory(tx, organizationId, campaignId)) {
    return { ok: false, code: "execution_history", message: "This campaign already has execution history; its setup can no longer change" };
  }
  const [activeImport] = await tx.select({ id: contactImportSessionsTable.id })
    .from(contactImportSessionsTable)
    .where(and(
      eq(contactImportSessionsTable.organizationId, organizationId),
      eq(contactImportSessionsTable.campaignId, campaignId),
      eq(contactImportSessionsTable.status, "Processing"),
    ))
    .limit(1);
  if (activeImport) {
    return { ok: false, code: "import_in_progress", message: "Wait for the active contact import to finish before changing setup" };
  }
  if (campaign.status === "Ready") {
    const superseded = await tx.update(campaignPlansTable).set({ status: "Superseded" }).where(and(
      eq(campaignPlansTable.campaignId, campaignId),
      eq(campaignPlansTable.status, "Active"),
    )).returning({ id: campaignPlansTable.id });
    await tx.update(campaignsTable).set({ status: "Draft" }).where(and(
      eq(campaignsTable.id, campaignId),
      eq(campaignsTable.status, "Ready"),
    ));
    await tx.insert(campaignAuditTable).values({
      organizationId,
      campaignId,
      actorUserId,
      action: "reopen",
      fromStatus: "Ready",
      toStatus: "Draft",
      metadata: { reason: "setup_changed", supersededPlanIds: superseded.map((plan) => plan.id) },
    });
  }
  return { ok: true };
}

export async function getCampaignAudience(organizationId: number, campaignId: number) {
  const [campaign] = await db.select({
    id: campaignsTable.id,
    status: campaignsTable.status,
    audienceGeneration: campaignsTable.audienceGeneration,
  }).from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  ));
  if (!campaign) return null;
  const sessions = await db.select().from(contactImportSessionsTable).where(and(
    eq(contactImportSessionsTable.organizationId, organizationId),
    eq(contactImportSessionsTable.campaignId, campaignId),
  )).orderBy(contactImportSessionsTable.createdAt, contactImportSessionsTable.id);
  const executionHistory = await hasExecutionHistory(db, organizationId, campaignId);
  const active = sessions.find((session) => session.status === "Processing");
  const totals = await audienceTotals(db, organizationId, campaignId, campaign.audienceGeneration);
  return {
    campaignId: campaign.id,
    status: campaign.status,
    audienceGeneration: campaign.audienceGeneration,
    editable: campaign.status === "Draft" && !executionHistory && !active,
    reopenRequired: campaign.status === "Ready" && !executionHistory,
    executionHistory,
    importInProgress: Boolean(active),
    activeSessionId: active?.id ?? null,
    totals,
    sessions,
  };
}
