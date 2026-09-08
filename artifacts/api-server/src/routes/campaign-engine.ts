import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import {
  campaignAuditTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  phoneNumbersTable,
  providerMessagesTable,
  suppressionsTable,
  templatesTable,
} from "@workspace/db";
import {
  DownloadRejectedImportRowsParams,
  ExportCampaignMessagesParams,
  GetCampaignMonitoringParams,
  GetCampaignMonitoringResponse,
  GetCampaignPlanParams,
  GetCampaignPlanResponse,
  GetCampaignReadinessParams,
  GetCampaignReadinessResponse,
  GetCampaignTemplateMappingsParams,
  GetCampaignTemplateMappingsResponse,
  ListContactImportsParams,
  ListContactImportsResponse,
  PreviewCampaignPlanContactBody,
  PreviewCampaignPlanContactParams,
  PreviewCampaignPlanContactResponse,
  ReplaceCampaignTemplateMappingsBody,
  ReplaceCampaignTemplateMappingsParams,
  ReplaceCampaignTemplateMappingsResponse,
  SearchCampaignContactsBody,
  SearchCampaignContactsParams,
  SearchCampaignContactsResponse,
  SearchCampaignMessagesBody,
  SearchCampaignMessagesParams,
  SearchCampaignMessagesResponse,
  SearchCampaignPlanRecipientsBody,
  SearchCampaignPlanRecipientsParams,
  SearchCampaignPlanRecipientsResponse,
  StreamContactImportHeader,
  StreamContactImportParams,
  StreamContactImportResponse,
  TransitionCampaignBody,
  TransitionCampaignParams,
  TransitionCampaignResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireActiveOrganization,
  requireAuth,
  requireRole,
} from "../middlewares/auth";
import { csvRow, normalizePhone, parseCsv, stableContactKey } from "../services/contact-processing";
import { describeTemplate, expandCompatibleMappings } from "../services/template-mapping";
import { validateCampaignReady } from "../services/campaign-preflight";
import { inFlightRegistry } from "../services/campaign-inflight";
import { reconcileCampaignJobs } from "../services/campaign-reconciliation";
import { CampaignNotReadyError, executeCampaignPlan, planCampaign, withCampaignLifecycleLock } from "../services/campaign-planning";
import { getActivePlanSummary, PlanPreviewNotFoundError, previewPlanContact, searchPlanRecipients } from "../services/campaign-plan-preview";
import {
  assertContactImportWritable,
  CampaignImportFencedError,
  initializeContactImport,
} from "../services/campaign-import-lifecycle";

const router: IRouter = Router();
// Sized for the 10-20M contact scale this campaign engine targets, not an
// arbitrary "development" cap. A realistic WhatsApp campaign row (phone +
// name + a few short template variables) runs roughly 100-200 bytes; at
// 20M rows that's ~2-4 GB, so 6 GB leaves headroom without being unbounded
// (this endpoint streams the body and inserts in fixed-size batches, so
// memory use does not scale with file size -- see guardedBody()/flush()).
const MAX_CSV_BYTES = 6 * 1024 * 1024 * 1024;
const MAX_CSV_LABEL = "6 GB";
const BATCH_SIZE = 500;

// "plan" and "execute" are handled separately below (they freeze/activate an
// execution snapshot rather than just flip a status column); this table
// governs the remaining, simpler status transitions.
const allowedTransitions: Record<string, Record<string, string>> = {
  schedule: { Ready: "Scheduled" },
  pause: { Running: "Paused" },
  resume: { Paused: "Running" },
  cancel: { Draft: "Cancelled", Ready: "Cancelled", Scheduled: "Cancelled", Running: "Cancelled", Paused: "Cancelled" },
  "emergency-kill": { Draft: "Cancelled", Ready: "Cancelled", Scheduled: "Cancelled", Running: "Cancelled", Paused: "Cancelled" },
};

// The status each action settles a campaign into once it has actually taken
// effect. Used to make pause/resume/cancel/emergency-kill/schedule
// retry-safe: if a client resends an action after a lost response, the
// campaign is often already in this status (the first attempt did apply),
// and that must report success with the current state -- not a 409 -- or a
// caller cannot safely retry an ambiguous network failure. cancel and
// emergency-kill share Cancelled as their settled status: retrying either
// one against an already-cancelled campaign (regardless of which action
// cancelled it first) is a safe no-op.
const settledStatusForAction: Record<string, string> = {
  schedule: "Scheduled",
  pause: "Paused",
  resume: "Running",
  cancel: "Cancelled",
  "emergency-kill": "Cancelled",
};

async function campaignResponse(organizationId: number, campaignId: number) {
  const [row] = await db.select({
    id: campaignsTable.id,
    organizationId: campaignsTable.organizationId,
    name: campaignsTable.name,
    status: campaignsTable.status,
    audienceSize: campaignsTable.audienceSize,
    sent: campaignsTable.sent,
    delivered: campaignsTable.delivered,
    read: campaignsTable.read,
    failed: campaignsTable.failed,
    scheduleLabel: campaignsTable.scheduleLabel,
    priority: campaignsTable.priority,
    scheduledAt: campaignsTable.scheduledAt,
    startedAt: campaignsTable.startedAt,
    completedAt: campaignsTable.completedAt,
    killSwitch: campaignsTable.killSwitch,
    routeCount: sql<number>`(select count(*)::int from ${campaignRoutesTable} where ${campaignRoutesTable.campaignId} = ${campaignsTable.id})`,
    createdAt: campaignsTable.createdAt,
    updatedAt: campaignsTable.updatedAt,
  }).from(campaignsTable).where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId)));
  return row;
}

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/actions",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = TransitionCampaignParams.safeParse(req.params);
    const body = TransitionCampaignBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
      return;
    }
    const [campaign] = await db.select().from(campaignsTable).where(and(
      eq(campaignsTable.id, params.data.campaignId),
      eq(campaignsTable.organizationId, params.data.organizationId),
    ));
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    if (body.data.action === "plan" || body.data.action === "execute") {
      try {
        if (body.data.action === "plan") await planCampaign(campaign.organizationId, campaign.id);
        else await executeCampaignPlan(campaign.organizationId, campaign.id);
      } catch (error) {
        if (error instanceof CampaignNotReadyError) {
          res.status(409).json({ error: "Campaign is not ready", details: error.errors });
          return;
        }
        res.status(409).json({ error: error instanceof Error ? error.message : `Unable to ${body.data.action} campaign` });
        return;
      }
      res.json(TransitionCampaignResponse.parse(await campaignResponse(params.data.organizationId, params.data.campaignId)));
      return;
    }
    if (body.data.action === "schedule" && !body.data.scheduledAt) {
      res.status(409).json({ error: "Action schedule requires a scheduledAt" });
      return;
    }
    // Fast-fail against the pre-lock snapshot so an action that is obviously
    // invalid for this campaign's last known status doesn't have to wait for
    // the lock at all. This is only a heuristic: the authoritative check
    // (and the status actually acted on) is the fresh, lock-protected read
    // below, since this snapshot can go stale while a concurrent plan(),
    // execute(), or other transition holds the lock first. A campaign
    // already sitting in this action's settled status is not rejected here
    // either -- it may be a retry of a request whose response was lost, and
    // that must be allowed through to the idempotent-no-op check below
    // rather than fast-failing as invalid.
    if (!allowedTransitions[body.data.action]?.[campaign.status] && campaign.status !== settledStatusForAction[body.data.action]) {
      res.status(409).json({ error: `Action ${body.data.action} is not valid from ${campaign.status}` });
      return;
    }
    const now = new Date();
    let transitionError: string | undefined;
    let transitionDetails: string[] | undefined;
    let alreadySettled = false;
    // Share the same per-campaign advisory lock plan()/execute() use, so a
    // pause/resume/cancel/emergency-kill/schedule can never interleave with
    // an in-progress execute() paging through job creation -- otherwise
    // execute() could keep inserting Queued jobs after a concurrent cancel
    // already ran, leaving stale jobs and inflated queue counters even
    // though the campaign correctly ended up Cancelled. Because acquiring
    // this lock can now block for as long as a concurrent plan()/execute()
    // takes, this callback always recomputes nextStatus from the freshly
    // locked row rather than trusting the pre-lock snapshot above -- a
    // legitimate status change made by whichever transition ran first (e.g.
    // execute() moving Ready -> Running) must not be reported as a conflict.
    await withCampaignLifecycleLock(campaign.id, (scopedDb) => scopedDb.transaction(async (tx) => {
      const [lockedCampaign] = await tx.select().from(campaignsTable).where(and(
        eq(campaignsTable.id, campaign.id),
        eq(campaignsTable.organizationId, campaign.organizationId),
      )).for("update");
      if (!lockedCampaign) {
        transitionError = "Campaign not found";
        return;
      }
      const nextStatus = allowedTransitions[body.data.action]?.[lockedCampaign.status];
      if (!nextStatus) {
        // A client retrying this exact action after a lost response (e.g. a
        // timeout) must not see this as an error if the first attempt
        // already applied it -- that would make the action impossible to
        // retry safely. Treat "already in this action's settled status" as
        // a no-op success instead of a conflict; anything else is a genuine
        // invalid transition.
        if (lockedCampaign.status === settledStatusForAction[body.data.action]) {
          alreadySettled = true;
          return;
        }
        transitionError = `Action ${body.data.action} is not valid from ${lockedCampaign.status}`;
        return;
      }
      if (["schedule", "resume"].includes(body.data.action)) {
        const errors = await validateCampaignReady(campaign.organizationId, campaign.id);
        if (errors.length) {
          transitionError = "Campaign is not ready";
          transitionDetails = errors;
          return;
        }
        const [activeImport] = await tx.select({ id: contactImportSessionsTable.id })
          .from(contactImportSessionsTable)
          .where(and(
            eq(contactImportSessionsTable.organizationId, campaign.organizationId),
            eq(contactImportSessionsTable.campaignId, campaign.id),
            eq(contactImportSessionsTable.status, "Processing"),
          ))
          .limit(1);
        if (activeImport) {
          transitionError = "Wait for the active contact import to finish";
          return;
        }
      }
      await tx.update(campaignsTable).set({
        status: nextStatus,
        scheduledAt: body.data.action === "schedule" ? body.data.scheduledAt : lockedCampaign.scheduledAt,
        scheduleLabel: body.data.action === "schedule" ? body.data.scheduledAt!.toISOString() : lockedCampaign.scheduleLabel,
        startedAt: nextStatus === "Running" && !lockedCampaign.startedAt ? now : lockedCampaign.startedAt,
        completedAt: ["Cancelled", "Completed", "Failed"].includes(nextStatus) ? now : null,
        killSwitch: body.data.action === "emergency-kill",
      }).where(and(eq(campaignsTable.id, campaign.id), eq(campaignsTable.status, lockedCampaign.status)));
      if (["pause", "cancel", "emergency-kill"].includes(body.data.action)) {
        await tx.update(campaignRoutesTable).set({ status: "Paused", currentTps: 0 })
          .where(eq(campaignRoutesTable.campaignId, campaign.id));
      } else if (body.data.action === "resume") {
        await tx.update(campaignRoutesTable).set({ status: "Active" })
          .where(and(eq(campaignRoutesTable.campaignId, campaign.id), eq(campaignRoutesTable.status, "Paused")));
      }
      if (["cancel", "emergency-kill"].includes(body.data.action)) {
        await tx.update(contactImportSessionsTable).set({
          status: "Failed",
          error: body.data.action === "emergency-kill"
            ? "Campaign emergency-killed during contact import"
            : "Campaign cancelled during contact import",
        }).where(and(
          eq(contactImportSessionsTable.campaignId, campaign.id),
          eq(contactImportSessionsTable.organizationId, campaign.organizationId),
          eq(contactImportSessionsTable.status, "Processing"),
        ));
        const rows = await tx.update(campaignJobsTable).set({
          status: "Cancelled",
          lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
          errorReason: body.data.reason ?? (body.data.action === "emergency-kill" ? "Emergency kill" : "Campaign cancelled"),
        })
          .where(and(eq(campaignJobsTable.campaignId, campaign.id), eq(campaignJobsTable.status, "Queued")))
          .returning({ status: campaignJobsTable.status });
        if (rows.length) {
          await tx.update(campaignMetricsTable).set({ queued: sql`greatest(0, ${campaignMetricsTable.queued} - ${rows.length})` })
            .where(eq(campaignMetricsTable.campaignId, campaign.id));
        }
      }
      await tx.insert(campaignAuditTable).values({
        organizationId: campaign.organizationId,
        campaignId: campaign.id,
        actorUserId: req.authUser?.id,
        action: body.data.action,
        fromStatus: lockedCampaign.status,
        toStatus: nextStatus,
        metadata: body.data.reason ? { reason: body.data.reason } : {},
      });
    }));
    if (transitionError) {
      res.status(409).json({ error: transitionError, ...(transitionDetails ? { details: transitionDetails } : {}) });
      return;
    }
    // An idempotent retry that found the campaign already settled did not
    // write anything (no new audit row, no route/job mutation) -- skip the
    // abort/reconcile side effects too, since nothing changed, and just
    // report the current, already-correct state.
    if (!alreadySettled && ["pause", "cancel", "emergency-kill"].includes(body.data.action)) {
      inFlightRegistry.abortCampaign(campaign.id, `Campaign ${body.data.action}`);
      await inFlightRegistry.waitForIdle(250);
      await reconcileCampaignJobs(campaign.id);
    }
    res.json(TransitionCampaignResponse.parse(await campaignResponse(params.data.organizationId, params.data.campaignId)));
  },
);

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/imports",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = ListContactImportsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const rows = await db.select().from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.organizationId, params.data.organizationId),
      eq(contactImportSessionsTable.campaignId, params.data.campaignId),
    )).orderBy(asc(contactImportSessionsTable.createdAt));
    res.json(ListContactImportsResponse.parse(rows));
  },
);

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/imports",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = StreamContactImportParams.safeParse(req.params);
    const headers = StreamContactImportHeader.safeParse(req.headers);
    if (!params.success || !headers.success) {
      res.status(400).json({ error: !params.success ? params.error.message : headers.error?.message });
      return;
    }
    const declaredSize = Number(req.headers["content-length"] ?? 0);
    if (declaredSize > MAX_CSV_BYTES) {
      res.status(413).json({ error: `CSV exceeds the ${MAX_CSV_LABEL} limit` });
      return;
    }
    const headerData = headers.data;
    let [session] = await db.select().from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.organizationId, params.data.organizationId),
      eq(contactImportSessionsTable.idempotencyKey, headerData["idempotency-key"]),
    ));
    if (session && session.campaignId !== params.data.campaignId) {
      res.status(409).json({ error: "This import idempotency key belongs to a different campaign" });
      return;
    }
    if (session?.status === "Completed") {
      res.status(202).json(StreamContactImportResponse.parse(session));
      return;
    }
    const initialized = await initializeContactImport({
      organizationId: params.data.organizationId,
      campaignId: params.data.campaignId,
      idempotencyKey: headerData["idempotency-key"],
      fileName: headerData["x-file-name"],
      phoneColumn: headerData["x-phone-column"],
      defaultCountryCode: headerData["x-default-country-code"],
    });
    if (!initialized.ok) {
      res.status(initialized.status).json({ error: initialized.message });
      return;
    }
    const campaign = initialized.campaign;
    session = initialized.session;
    if (initialized.replay) {
      res.status(202).json(StreamContactImportResponse.parse(session));
      return;
    }
    const importCampaign = campaign;
    await db.insert(campaignMetricsTable).values({
      organizationId: params.data.organizationId,
      campaignId: importCampaign.id,
    }).onConflictDoNothing();
    let bytes = 0;
    async function* guardedBody() {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_CSV_BYTES) throw new Error(`CSV exceeds the ${MAX_CSV_LABEL} limit`);
        yield chunk;
      }
    }
    let columns: string[] = [];
    let rowNumber = 0;
    let batch: (typeof campaignContactsTable.$inferInsert)[] = [];
    let valid = session.validRows;
    let invalid = session.invalidRows;
    let duplicates = session.duplicateRows;
    let suppressed = session.suppressedRows;
    const flush = async () => {
      if (!batch.length) return;
      const phones = batch.flatMap((row) => row.normalizedPhone ? [row.normalizedPhone] : []);
      const suppressionRows = phones.length ? await db.select({ phone: suppressionsTable.normalizedPhone }).from(suppressionsTable)
        .where(and(eq(suppressionsTable.organizationId, params.data.organizationId), inArray(suppressionsTable.normalizedPhone, phones))) : [];
      const suppressedPhones = new Set(suppressionRows.map((row) => row.phone));
      batch = batch.map((row) => suppressedPhones.has(row.normalizedPhone ?? "") ? {
        ...row, status: "Suppressed", invalidReason: "Suppression list", routeId: null,
      } : row);
      const currentBatch = batch;
      await db.transaction(async (tx) => {
        await assertContactImportWritable(
          tx,
          params.data.organizationId,
          importCampaign.id,
          session.id,
        );
        const inserted = await tx
          .insert(campaignContactsTable)
          .values(currentBatch)
          .onConflictDoNothing({
            target: [
              campaignContactsTable.campaignId,
              campaignContactsTable.idempotencyKey,
            ],
          })
          .returning({
            status: campaignContactsTable.status,
          });
        duplicates += currentBatch.length - inserted.length;
        valid += inserted.filter((row) => row.status === "Valid").length;
        invalid += inserted.filter((row) => row.status === "Invalid").length;
        suppressed += inserted.filter((row) => row.status === "Suppressed").length;

        // Partition/route/template assignment and job creation happen later,
        // deterministically, against the frozen route list captured when the
        // campaign is planned (see services/campaign-planning.ts). Importing
        // never creates jobs directly.
        await tx.update(contactImportSessionsTable).set({
          columns, bytesProcessed: bytes, rowsProcessed: rowNumber, validRows: valid,
          invalidRows: invalid, duplicateRows: duplicates, suppressedRows: suppressed,
        }).where(eq(contactImportSessionsTable.id, session.id));
      });
      batch = [];
    };
    try {
      for await (const values of parseCsv(guardedBody())) {
        if (rowNumber === 0) {
          columns = values.map((value) => value.trim());
          if (!columns.includes(headerData["x-phone-column"])) throw new Error("Configured phone column is missing from CSV header");
          rowNumber++;
          continue;
        }
        rowNumber++;
        if (rowNumber <= session.rowsProcessed) continue;
        const data = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
        const rawPhone = data[headerData["x-phone-column"]] ?? "";
        const normalized = normalizePhone(rawPhone, headerData["x-default-country-code"]);
        batch.push({
          organizationId: params.data.organizationId,
          campaignId: importCampaign.id,
          importSessionId: session.id,
          rowNumber,
          rawPhone,
          normalizedPhone: normalized.value,
          data,
          status: normalized.value ? "Valid" : "Invalid",
          invalidReason: normalized.error,
          partitionKey: null,
          routeId: null,
          idempotencyKey: normalized.value ? stableContactKey(campaign.id, normalized.value) : `${session.id}:row:${rowNumber}`,
        });
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      await db.transaction(async (tx) => {
        await assertContactImportWritable(
          tx,
          params.data.organizationId,
          importCampaign.id,
          session.id,
        );
        [session] = await tx.update(contactImportSessionsTable)
          .set({ status: "Completed", bytesProcessed: bytes })
          .where(and(
            eq(contactImportSessionsTable.id, session.id),
            eq(contactImportSessionsTable.status, "Processing"),
          ))
          .returning();
        if (!session) throw new CampaignImportFencedError();
        const [queueCounts] = await tx.select({
          queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
        }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
        await tx.insert(campaignMetricsTable).values({
          organizationId: params.data.organizationId, campaignId: importCampaign.id,
          total: rowNumber - 1, valid, invalid, deduplicated: duplicates, suppressed, queued: queueCounts?.queued ?? 0,
        }).onConflictDoUpdate({
          target: campaignMetricsTable.campaignId,
          set: { total: rowNumber - 1, valid, invalid, deduplicated: duplicates, suppressed, queued: queueCounts?.queued ?? 0, updatedAt: new Date() },
        });
        await tx.update(campaignsTable).set({ audienceSize: valid }).where(and(
          eq(campaignsTable.id, importCampaign.id),
          eq(campaignsTable.status, "Draft"),
        ));
      });
      res.status(202).json(StreamContactImportResponse.parse(session));
    } catch (error) {
      const message = error instanceof Error ? error.message : "CSV processing failed";
      await db.update(contactImportSessionsTable).set({ status: "Failed", error: message, bytesProcessed: bytes }).where(and(
        eq(contactImportSessionsTable.id, session.id),
        eq(contactImportSessionsTable.status, "Processing"),
      ));
      req.log.warn({ error: message, importSessionId: session.id }, "CSV import failed");
      res.status(message.includes(`${MAX_CSV_LABEL} limit`) ? 413 : error instanceof CampaignImportFencedError ? 409 : 400).json({ error: message });
    }
  },
);

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/imports/:importSessionId/rejected.csv",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = DownloadRejectedImportRowsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [session] = await db.select().from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.id, params.data.importSessionId),
      eq(contactImportSessionsTable.organizationId, params.data.organizationId),
      eq(contactImportSessionsTable.campaignId, params.data.campaignId),
    ));
    if (!session) {
      res.status(404).json({ error: "Import session not found" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${session.fileName.replace(/[^\w.-]/g, "_")}-rejected.csv"`);
    res.write(csvRow(["import_row_number", "import_status", "import_rejection_reason", ...session.columns]));
    // Keyset-paginated so a session with millions of rejected rows never
    // buffers more than one page in memory -- required to stay safe at the
    // 10-20M contact scale this campaign engine is built for.
    const PAGE_SIZE = 2000;
    let cursor = 0;
    for (;;) {
      const rows: (typeof campaignContactsTable.$inferSelect)[] = await db.select().from(campaignContactsTable).where(and(
        eq(campaignContactsTable.importSessionId, session.id),
        inArray(campaignContactsTable.status, ["Invalid", "Suppressed"]),
        sql`${campaignContactsTable.rowNumber} > ${cursor}`,
      )).orderBy(asc(campaignContactsTable.rowNumber)).limit(PAGE_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        res.write(csvRow([
          String(row.rowNumber),
          row.status,
          row.invalidReason ?? "",
          ...session.columns.map((column) => row.data[column] ?? ""),
        ]));
      }
      cursor = rows[rows.length - 1].rowNumber;
      if (rows.length < PAGE_SIZE) break;
    }
    res.end();
  },
);

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/contacts/search",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = SearchCampaignContactsParams.safeParse(req.params);
    const body = SearchCampaignContactsBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
      return;
    }
    const after = body.data.after ?? 0;
    const limit = Math.min(Math.max(body.data.limit ?? 500, 1), 2000);
    // Keyset (rowNumber) pagination, not offset/count(*) -- an unbounded or
    // offset-based scan here would degrade badly once a campaign's imported
    // rows reach the 10-20M contact scale this engine targets.
    const rows = await db.select().from(campaignContactsTable).where(and(
      eq(campaignContactsTable.organizationId, params.data.organizationId),
      eq(campaignContactsTable.campaignId, params.data.campaignId),
      sql`${campaignContactsTable.rowNumber} > ${after}`,
    )).orderBy(asc(campaignContactsTable.rowNumber)).limit(limit);
    const nextCursor = rows.length === limit ? rows[rows.length - 1].rowNumber : null;
    res.json(SearchCampaignContactsResponse.parse({ items: rows, nextCursor }));
  },
);

async function mappingReport(organizationId: number, campaignId: number, selectedTemplateIds?: number[]) {
  const mappings = await db.select().from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, organizationId),
    eq(campaignTemplateMappingsTable.campaignId, campaignId),
  ));
  const selections = await db.select({ templateId: campaignTemplateSelectionsTable.templateId })
    .from(campaignTemplateSelectionsTable).where(and(
      eq(campaignTemplateSelectionsTable.organizationId, organizationId),
      eq(campaignTemplateSelectionsTable.campaignId, campaignId),
    ));
  const ids = selectedTemplateIds ?? selections.map((selection) => selection.templateId);
  const templates = ids.length ? await db.select({
    id: templatesTable.id, body: templatesTable.body, components: templatesTable.components,
  }).from(templatesTable).where(and(eq(templatesTable.organizationId, organizationId), inArray(templatesTable.id, ids))) : [];
  const descriptors = templates.map(describeTemplate);
  const mapped = new Set(mappings.map((mapping) => `${mapping.templateId}:${mapping.component}:${mapping.variable}`));
  const missing = descriptors.flatMap((template) => template.requiredVariables
    .filter((variable) => {
      const [component, ...rest] = variable.split(":");
      return !mapped.has(`${template.templateId}:${component}:${rest.join(":")}`);
    }).map((variable) => `${template.templateId}:${variable}`));
  const headerKinds = new Set(descriptors.map((template) => template.headerKind).filter((kind) => kind !== "none"));
  return {
    mappings: mappings.map(({ templateId, component, variable, source, sourceValue, optional, fallbackValue }) => ({
      templateId, component, variable, source, sourceValue, optional, fallbackValue,
    })),
    templates: descriptors.map((template) => ({ ...template, compatible: headerKinds.size <= 1 || template.headerKind === "none" })),
    missing,
  };
}

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/template-mappings",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = GetCampaignTemplateMappingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    res.json(GetCampaignTemplateMappingsResponse.parse(await mappingReport(params.data.organizationId, params.data.campaignId)));
  },
);

router.put(
  "/organizations/:organizationId/campaigns/:campaignId/template-mappings",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = ReplaceCampaignTemplateMappingsParams.safeParse(req.params);
    const body = ReplaceCampaignTemplateMappingsBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
      return;
    }
    let httpError: { status: number; body: unknown } | undefined;
    // Share the same per-campaign advisory lock plan()/execute() use. Without
    // this, planCampaign() reads the selection and mapping tables as two
    // separate statements while only holding this lock on its own side; a
    // concurrent replacement (this endpoint) that isn't serialized the same
    // way can commit in between those reads (or between validateCampaignReady
    // and the actual snapshot read), so planCampaign() freezes a snapshot
    // pairing a selection from one write with mappings from another --
    // selections and mappings that never coexisted in the live tables. That
    // snapshot can report Ready while its jobs deterministically fail
    // resolution. See withCampaignLifecycleLock's doc comment.
    await withCampaignLifecycleLock(params.data.campaignId, async (scopedDb) => {
      const [campaign] = await scopedDb.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
        eq(campaignsTable.id, params.data.campaignId),
        eq(campaignsTable.organizationId, params.data.organizationId),
      ));
      if (!campaign) {
        httpError = { status: 404, body: { error: "Campaign not found" } };
        return;
      }
      const templates = body.data.templateIds.length ? await scopedDb.select({
        id: templatesTable.id,
        body: templatesTable.body,
        components: templatesTable.components,
      }).from(templatesTable).where(and(
        eq(templatesTable.organizationId, params.data.organizationId),
        inArray(templatesTable.id, body.data.templateIds),
      )) : [];
      if (templates.length !== new Set(body.data.templateIds).size || body.data.mappings.some((mapping) => !body.data.templateIds.includes(mapping.templateId))) {
        httpError = { status: 400, body: { error: "Every template and mapping must belong to this organization and selection" } };
        return;
      }
      const descriptors = templates.map(describeTemplate);
      let normalizedMappings: typeof body.data.mappings;
      try {
        normalizedMappings = expandCompatibleMappings(descriptors, body.data.mappings)
          .map((mapping) => ({ ...mapping, optional: mapping.optional ?? false }));
      } catch (error) {
        httpError = { status: 400, body: { error: error instanceof Error ? error.message : "Invalid shared mapping" } };
        return;
      }
      const requiredKeys = new Set(templates.flatMap((template) =>
        describeTemplate(template).requiredVariables.map((requirement) => {
          const [component, ...variable] = requirement.split(":");
          return `${template.id}:${component}:${variable.join(":")}`;
        }),
      ));
      const suppliedKeys = new Set<string>();
      const mappingErrors: string[] = [];
      for (const mapping of normalizedMappings) {
        const key = `${mapping.templateId}:${mapping.component}:${mapping.variable}`;
        if (suppliedKeys.has(key)) mappingErrors.push(`Duplicate mapping ${key}`);
        suppliedKeys.add(key);
        if (!requiredKeys.has(key)) mappingErrors.push(`Unknown mapping ${key}`);
        if (!mapping.sourceValue.trim()) mappingErrors.push(`${mapping.source} mapping ${key} requires a non-empty value`);
        if (mapping.optional && !(mapping.fallbackValue ?? "").trim()) mappingErrors.push(`Optional mapping ${key} requires a non-empty fallback value`);
      }
      if (mappingErrors.length) {
        httpError = { status: 400, body: { error: "Invalid template mappings", details: [...new Set(mappingErrors)] } };
        return;
      }
      await scopedDb.transaction(async (tx) => {
        await tx.delete(campaignTemplateMappingsTable).where(and(
          eq(campaignTemplateMappingsTable.organizationId, params.data.organizationId),
          eq(campaignTemplateMappingsTable.campaignId, params.data.campaignId),
        ));
        await tx.delete(campaignTemplateSelectionsTable).where(and(
          eq(campaignTemplateSelectionsTable.organizationId, params.data.organizationId),
          eq(campaignTemplateSelectionsTable.campaignId, params.data.campaignId),
        ));
        if (body.data.templateIds.length) await tx.insert(campaignTemplateSelectionsTable).values(body.data.templateIds.map((templateId) => ({
          organizationId: params.data.organizationId, campaignId: params.data.campaignId, templateId,
        })));
        if (normalizedMappings.length) await tx.insert(campaignTemplateMappingsTable).values(normalizedMappings.map((mapping) => ({
          ...mapping, organizationId: params.data.organizationId, campaignId: params.data.campaignId,
        })));
      });
    });
    if (httpError) {
      res.status(httpError.status).json(httpError.body);
      return;
    }
    res.json(ReplaceCampaignTemplateMappingsResponse.parse(await mappingReport(
      params.data.organizationId, params.data.campaignId, body.data.templateIds,
    )));
  },
);

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/plan",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = GetCampaignPlanParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const summary = await getActivePlanSummary(params.data.organizationId, params.data.campaignId);
    if (!summary) {
      res.status(404).json({ error: "Campaign has no active frozen plan yet" });
      return;
    }
    res.json(GetCampaignPlanResponse.parse(summary));
  },
);

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/plan/preview",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = PreviewCampaignPlanContactParams.safeParse(req.params);
    const body = PreviewCampaignPlanContactBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
      return;
    }
    if (body.data.contactId === undefined && !body.data.phone) {
      res.status(400).json({ error: "Provide either contactId or phone" });
      return;
    }
    try {
      const preview = await previewPlanContact(
        params.data.organizationId,
        params.data.campaignId,
        body.data.contactId !== undefined ? { contactId: body.data.contactId } : { phone: body.data.phone! },
      );
      res.json(PreviewCampaignPlanContactResponse.parse(preview));
    } catch (error) {
      if (error instanceof PlanPreviewNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/plan/recipients",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = SearchCampaignPlanRecipientsParams.safeParse(req.params);
    const body = SearchCampaignPlanRecipientsBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
      return;
    }
    try {
      const page = await searchPlanRecipients(params.data.organizationId, params.data.campaignId, body.data);
      res.json(SearchCampaignPlanRecipientsResponse.parse(page));
    } catch (error) {
      if (error instanceof PlanPreviewNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/organizations/:organizationId/campaigns/:campaignId/messages/search",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = SearchCampaignMessagesParams.safeParse(req.params);
    const body = SearchCampaignMessagesBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
      return;
    }
    const limit = body.data.limit ?? 25;
    const offset = body.data.offset ?? 0;
    const baseConditions = [
      eq(campaignJobsTable.organizationId, params.data.organizationId),
      eq(campaignJobsTable.campaignId, params.data.campaignId),
    ];
    if (body.data.status) baseConditions.push(eq(campaignJobsTable.status, body.data.status));
    const search = body.data.search?.trim();
    const conditions = [...baseConditions];
    if (search) {
      const term = `%${search}%`;
      // A single OR across three different joined tables' text columns
      // can't be driven by any one index: once a campaign has millions of
      // jobs, Postgres has to walk every job row for this campaign before
      // it can even evaluate the filter. Each branch below is instead
      // resolved as its own trigram-indexed lookup scoped to this campaign
      // (job error reason, contact phone, provider error reason), and the
      // matching job ids are combined with UNION -- so a selective search
      // term (a phone number, an error string) stays index-driven no
      // matter how large the campaign's job history is.
      const jobReasonMatches = db.select({ id: campaignJobsTable.id }).from(campaignJobsTable)
        .where(and(...baseConditions, ilike(campaignJobsTable.errorReason, term)));
      const phoneMatches = db.select({ id: campaignJobsTable.id }).from(campaignJobsTable)
        .innerJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignJobsTable.contactId))
        .where(and(...baseConditions, ilike(campaignContactsTable.normalizedPhone, term)));
      const providerReasonMatches = db.select({ id: campaignJobsTable.id }).from(campaignJobsTable)
        .innerJoin(providerMessagesTable, eq(providerMessagesTable.campaignJobId, campaignJobsTable.id))
        .where(and(...baseConditions, ilike(providerMessagesTable.errorReason, term)));
      conditions.push(inArray(campaignJobsTable.id, union(jobReasonMatches, phoneMatches, providerReasonMatches)));
    }
    const whereClause = and(...conditions);
    // total comes from a window function on the same query instead of a
    // separate count(*) query, so a page with results only pays for one
    // pass over the (now index-driven) matching set, not two.
    const rows = await db.select({
      jobId: campaignJobsTable.id,
      contactId: campaignJobsTable.contactId,
      phone: campaignContactsTable.normalizedPhone,
      routeId: campaignJobsTable.routeId,
      phoneNumberId: campaignRoutesTable.phoneNumberId,
      templateId: campaignJobsTable.templateId,
      templateName: templatesTable.name,
      jobStatus: campaignJobsTable.status,
      attempts: campaignJobsTable.attempts,
      maxAttempts: campaignJobsTable.maxAttempts,
      jobErrorReason: campaignJobsTable.errorReason,
      providerStatus: providerMessagesTable.status,
      providerErrorReason: providerMessagesTable.errorReason,
      providerMessageId: providerMessagesTable.providerMessageId,
      acceptedAt: providerMessagesTable.acceptedAt,
      lastStatusAt: providerMessagesTable.lastStatusAt,
      total: sql<number>`count(*) over()::int`,
    }).from(campaignJobsTable)
      .leftJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignJobsTable.contactId))
      .leftJoin(campaignRoutesTable, eq(campaignRoutesTable.id, campaignJobsTable.routeId))
      .leftJoin(templatesTable, eq(templatesTable.id, campaignJobsTable.templateId))
      .leftJoin(providerMessagesTable, eq(providerMessagesTable.campaignJobId, campaignJobsTable.id))
      .where(whereClause)
      .orderBy(desc(campaignJobsTable.id))
      .limit(limit).offset(offset);
    // The window function only carries a total on returned rows -- an
    // empty page (offset past the end of the matching set, or no matches
    // at all) still needs the real total, so that one edge case falls back
    // to a plain count query rather than reporting a false zero.
    const total = rows.length > 0
      ? rows[0].total
      : (await db.select({ count: sql<number>`count(*)::int` }).from(campaignJobsTable).where(whereClause))[0]?.count ?? 0;
    res.json(SearchCampaignMessagesResponse.parse({
      total,
      limit,
      offset,
      messages: rows.map(({ total: _total, ...row }) => ({
        ...row,
        acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
        lastStatusAt: row.lastStatusAt ? row.lastStatusAt.toISOString() : null,
      })),
    }));
  },
);

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/messages/export.csv",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = ExportCampaignMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [campaign] = await db.select({ id: campaignsTable.id, name: campaignsTable.name }).from(campaignsTable).where(and(
      eq(campaignsTable.id, params.data.campaignId),
      eq(campaignsTable.organizationId, params.data.organizationId),
    ));
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found in this organization" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${campaign.name.replace(/[^\w.-]/g, "_")}-delivery-log.csv"`);
    res.write(csvRow([
      "job_id", "contact_phone", "phone_number", "template_name", "job_status",
      "attempts", "max_attempts", "job_error_reason", "provider_status",
      "provider_error_reason", "provider_message_id", "accepted_at", "last_status_at",
    ]));
    // Keyset-paginated on the job's own primary key so a campaign with
    // millions of jobs never buffers more than one page in memory -- the
    // same scale-safe pattern as the rejected-rows import download above.
    const PAGE_SIZE = 2000;
    let cursor = 0;
    for (;;) {
      const rows = await db.select({
        jobId: campaignJobsTable.id,
        phone: campaignContactsTable.normalizedPhone,
        phoneNumber: phoneNumbersTable.phone,
        templateName: templatesTable.name,
        jobStatus: campaignJobsTable.status,
        attempts: campaignJobsTable.attempts,
        maxAttempts: campaignJobsTable.maxAttempts,
        jobErrorReason: campaignJobsTable.errorReason,
        providerStatus: providerMessagesTable.status,
        providerErrorReason: providerMessagesTable.errorReason,
        providerMessageId: providerMessagesTable.providerMessageId,
        acceptedAt: providerMessagesTable.acceptedAt,
        lastStatusAt: providerMessagesTable.lastStatusAt,
      }).from(campaignJobsTable)
        .leftJoin(campaignContactsTable, eq(campaignContactsTable.id, campaignJobsTable.contactId))
        .leftJoin(campaignRoutesTable, eq(campaignRoutesTable.id, campaignJobsTable.routeId))
        .leftJoin(phoneNumbersTable, eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId))
        .leftJoin(templatesTable, eq(templatesTable.id, campaignJobsTable.templateId))
        .leftJoin(providerMessagesTable, eq(providerMessagesTable.campaignJobId, campaignJobsTable.id))
        .where(and(
          eq(campaignJobsTable.organizationId, params.data.organizationId),
          eq(campaignJobsTable.campaignId, params.data.campaignId),
          sql`${campaignJobsTable.id} > ${cursor}`,
        ))
        .orderBy(asc(campaignJobsTable.id))
        .limit(PAGE_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        res.write(csvRow([
          String(row.jobId),
          row.phone ?? "",
          row.phoneNumber ?? "",
          row.templateName ?? "",
          row.jobStatus,
          String(row.attempts),
          String(row.maxAttempts),
          row.jobErrorReason ?? "",
          row.providerStatus ?? "",
          row.providerErrorReason ?? "",
          row.providerMessageId ?? "",
          row.acceptedAt ? row.acceptedAt.toISOString() : "",
          row.lastStatusAt ? row.lastStatusAt.toISOString() : "",
        ]));
      }
      cursor = rows[rows.length - 1].jobId;
      if (rows.length < PAGE_SIZE) break;
    }
    res.end();
  },
);

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/readiness",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = GetCampaignReadinessParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    // Reuses the exact same rule set Plan/Execute enforce (validateCampaignReady)
    // so this can never drift from what actually blocks a launch -- a manager
    // checking readiness here sees precisely what would happen if they clicked
    // Plan right now, before committing to that action.
    const errors = await validateCampaignReady(params.data.organizationId, params.data.campaignId);
    res.json(GetCampaignReadinessResponse.parse({ campaignId: params.data.campaignId, ready: errors.length === 0, errors }));
  },
);

router.get(
  "/organizations/:organizationId/campaigns/:campaignId/monitoring",
  requireAuth,
  attachOrgContext,
  requireActiveOrganization,
  async (req, res): Promise<void> => {
    const params = GetCampaignMonitoringParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [metrics] = await db.select().from(campaignMetricsTable).where(and(
      eq(campaignMetricsTable.organizationId, params.data.organizationId),
      eq(campaignMetricsTable.campaignId, params.data.campaignId),
    ));
    const routes = await db.select({
      routeId: campaignRoutesTable.id,
      configuredTps: campaignRoutesTable.configuredTps,
      currentTps: campaignRoutesTable.currentTps,
      queueDepth: campaignRoutesTable.queueDepth,
      status: campaignRoutesTable.status,
      phoneNumberId: campaignRoutesTable.phoneNumberId,
      providerTpsLimit: phoneNumbersTable.tpsLimit,
      sent: sql<number>`count(${campaignJobsTable.id}) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
      failed: sql<number>`count(${campaignJobsTable.id}) filter (where ${campaignJobsTable.status} = 'Failed')::int`,
      errorReasons: sql<Record<string, number>>`coalesce((
        select jsonb_object_agg(reason, occurrences) from (
          select error_reason as reason, count(*)::int as occurrences
          from campaign_jobs
          where route_id = ${campaignRoutesTable.id} and error_reason is not null
          group by error_reason
        ) route_errors
      ), '{}'::jsonb)`,
    }).from(campaignRoutesTable).innerJoin(phoneNumbersTable, and(
      eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId),
      eq(phoneNumbersTable.organizationId, campaignRoutesTable.organizationId),
    )).leftJoin(campaignJobsTable, and(
      eq(campaignJobsTable.routeId, campaignRoutesTable.id),
      eq(campaignJobsTable.organizationId, campaignRoutesTable.organizationId),
    ))
      .where(and(eq(campaignRoutesTable.organizationId, params.data.organizationId), eq(campaignRoutesTable.campaignId, params.data.campaignId)))
      // Postgres only infers other columns of a table are functionally
      // dependent on a GROUP BY column when that column is the table's own
      // primary key -- selecting phoneNumbersTable.tpsLimit (a joined
      // table's column) requires phoneNumbersTable.id in the GROUP BY too,
      // or every call to this endpoint fails with "column ... must appear
      // in the GROUP BY clause".
      .groupBy(campaignRoutesTable.id, phoneNumbersTable.id);
    if (!metrics) {
      const [campaign] = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
        eq(campaignsTable.organizationId, params.data.organizationId), eq(campaignsTable.id, params.data.campaignId),
      ));
      if (!campaign) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
    }
    const data = metrics ?? {
      campaignId: params.data.campaignId, total: 0, valid: 0, invalid: 0, deduplicated: 0, suppressed: 0,
      queued: 0, processing: 0, sent: 0, delivered: 0, read: 0, failed: 0, retryCount: 0, errorReasons: {},
    };
    const pending = Math.max(0, data.valid - data.sent - data.failed);
    const phoneBudgets = new Map<number, { configured: number; provider: number }>();
    for (const route of routes) {
      if (!["Active", "Throttled"].includes(route.status)) continue;
      const budget = phoneBudgets.get(route.phoneNumberId) ?? { configured: 0, provider: route.providerTpsLimit };
      budget.configured += route.configuredTps;
      budget.provider = Math.min(budget.provider, route.providerTpsLimit);
      phoneBudgets.set(route.phoneNumberId, budget);
    }
    const tps = [...phoneBudgets.values()].reduce(
      (sum, budget) => sum + Math.min(budget.configured, budget.provider),
      0,
    );
    const [operations] = await db.select({
      delayedRetries: sql<number>`count(*) filter (
        where ${campaignJobsTable.status} = 'Queued'
          and ${campaignJobsTable.attempts} > 0
          and ${campaignJobsTable.availableAt} > statement_timestamp()
      )::int`,
      staleLeases: sql<number>`count(*) filter (
        where ${campaignJobsTable.status} = 'Processing'
          and (${campaignJobsTable.leaseExpiresAt} is null or ${campaignJobsTable.leaseExpiresAt} <= statement_timestamp())
      )::int`,
      deliveryUnknown: sql<number>`count(*) filter (
        where exists (
          select 1 from ${providerMessagesTable}
          where ${providerMessagesTable.organizationId} = ${params.data.organizationId}
            and ${providerMessagesTable.campaignJobId} = ${campaignJobsTable.id}
            and ${providerMessagesTable.status} = 'delivery_unknown'
        )
      )::int`,
    }).from(campaignJobsTable).where(and(
      eq(campaignJobsTable.organizationId, params.data.organizationId),
      eq(campaignJobsTable.campaignId, params.data.campaignId),
    ));
    const [reconciliation] = await db.select({
      runs: sql<number>`count(*)::int`,
    }).from(campaignAuditTable).where(and(
      eq(campaignAuditTable.organizationId, params.data.organizationId),
      eq(campaignAuditTable.campaignId, params.data.campaignId),
      eq(campaignAuditTable.action, "reconciled"),
    ));
    const estimatedCompletionAt = pending > 0 && tps > 0 ? new Date(Date.now() + Math.ceil(pending / tps) * 1000) : null;
    res.json(GetCampaignMonitoringResponse.parse({
      ...data,
      pending,
      delayedRetries: operations?.delayedRetries ?? 0,
      staleLeases: operations?.staleLeases ?? 0,
      deliveryUnknown: operations?.deliveryUnknown ?? 0,
      throttledRoutes: routes.filter((route) => route.status === "Throttled").length,
      reconciliationRuns: reconciliation?.runs ?? 0,
      effectiveConfiguredTps: tps,
      estimatedCompletionAt,
      routes,
    }));
  },
);

export default router;