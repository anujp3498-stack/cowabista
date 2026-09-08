// Turns a Draft campaign's live configuration into a frozen, reproducible
// execution plan (`plan`), then activates bounded persistent work from that
// frozen plan (`execute`). See replit.md / task docs for the full contract:
// readiness freezes an immutable snapshot of routes/TPS/templates/mappings,
// every valid contact is allocated to a persistent partition/route/template
// deterministically before execution, and re-running plan or execute is
// always safe (idempotent) so retries, restarts, and concurrent workers
// cannot duplicate or reassign work.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  campaignAllocationsTable,
  campaignAuditTable,
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  phoneNumbersTable,
  pool,
  templatesTable,
  type Campaign,
  type CampaignPlan,
} from "@workspace/db";
import { validateCampaignReady } from "./campaign-preflight";
import { assignRoute, partitionFor } from "./contact-processing";

export const ALLOCATOR_VERSION = "v1";
const ALLOCATION_PAGE_SIZE = 500;
const EXECUTE_PAGE_SIZE = 500;
const PLANNABLE_STATUSES = ["Draft", "Ready"] as const;
const EXECUTABLE_STATUSES = ["Ready", "Scheduled", "Running"] as const;

// Arbitrary fixed namespace for the campaign-lifecycle advisory lock (first
// argument of the two-key pg_advisory_lock form), so this lock never
// collides with an advisory lock taken elsewhere in the codebase for a
// different purpose (e.g. per-job provider-send locks).
const CAMPAIGN_LIFECYCLE_LOCK_NAMESPACE = 875_611_204;

/**
 * Serializes every plan() and execute() call for one campaign, across
 * processes and workers, using a session-scoped Postgres advisory lock held
 * for the whole operation (not just one of its internal transactions).
 *
 * This is what makes "frozen plan" a real guarantee: without it, two
 * concurrent plan() calls can interleave their allocation writes so the
 * campaign's Active plan ends up with allocation rows stamped with a
 * different (superseded) plan's id -- silently dropping those contacts from
 * execute(), which strictly filters allocations by the Active plan's id.
 * Likewise, execute() must not be able to run concurrently with a replan of
 * the same campaign, or it can create jobs from a plan that is superseded
 * moments later. A plain in-transaction lock would only cover one of
 * plan()'s several round trips (snapshot creation, then paginated
 * allocation writes), so a session-held advisory lock is used instead to
 * cover the entire logical operation.
 *
 * The callback receives a `scopedDb` bound to the SAME connection that holds
 * the lock, and must use it for every query -- not the shared pool-backed
 * `db` -- so a single held connection covers the whole operation instead of
 * competing with it for a second connection from the same pool.
 */
export async function withCampaignLifecycleLock<T>(campaignId: number, fn: (scopedDb: typeof db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1, $2)", [CAMPAIGN_LIFECYCLE_LOCK_NAMESPACE, campaignId]);
    try {
      const scopedDb = drizzle(client) as unknown as typeof db;
      return await fn(scopedDb);
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [CAMPAIGN_LIFECYCLE_LOCK_NAMESPACE, campaignId]);
    }
  } finally {
    client.release();
  }
}

export class CampaignNotReadyError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; ") || "Campaign is not ready");
    this.name = "CampaignNotReadyError";
  }
}

export type FrozenRoute = {
  routeId: number;
  phoneNumberId: number;
  templateId: number;
  configuredTps: number;
  providerTpsLimit: number;
  phone: string;
  displayName: string;
};

/**
 * Validates readiness, then freezes an immutable snapshot (routes with their
 * TPS/provider-cap evidence, selected templates, expanded mappings) and
 * deterministically allocates every currently-Valid contact to a persistent
 * partition/route/template. Safe to call again on a Draft or Ready campaign
 * (e.g. after fixing a configuration issue): it supersedes the prior plan,
 * freezes a new one, and reproduces the exact same allocation for any
 * contact whose inputs (routes, partition count) have not changed.
 */
export async function planCampaign(organizationId: number, campaignId: number): Promise<{ plan: CampaignPlan; allocated: number }> {
  return withCampaignLifecycleLock(campaignId, (scopedDb) => planCampaignLocked(scopedDb, organizationId, campaignId));
}

async function planCampaignLocked(db: typeof import("@workspace/db").db, organizationId: number, campaignId: number): Promise<{ plan: CampaignPlan; allocated: number }> {
  const [campaign] = await db.select().from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  ));
  if (!campaign) throw new Error("Campaign not found");
  if (!(PLANNABLE_STATUSES as readonly string[]).includes(campaign.status)) {
    throw new Error(`Campaign cannot be planned from status ${campaign.status}`);
  }

  const [activeImport] = await db.select({ id: contactImportSessionsTable.id })
    .from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.organizationId, organizationId),
      eq(contactImportSessionsTable.campaignId, campaignId),
      eq(contactImportSessionsTable.status, "Processing"),
    ));
  if (activeImport) throw new CampaignNotReadyError(["A contact import is still processing"]);

  const errors = await validateCampaignReady(organizationId, campaignId);
  if (errors.length) throw new CampaignNotReadyError(errors);

  const routes = await db.select({
    id: campaignRoutesTable.id,
    phoneNumberId: campaignRoutesTable.phoneNumberId,
    templateId: campaignRoutesTable.templateId,
    configuredTps: campaignRoutesTable.configuredTps,
    providerTpsLimit: phoneNumbersTable.tpsLimit,
    phone: phoneNumbersTable.phone,
    displayName: phoneNumbersTable.displayName,
  }).from(campaignRoutesTable)
    .innerJoin(phoneNumbersTable, and(
      eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId),
      eq(phoneNumbersTable.organizationId, organizationId),
    ))
    .where(and(eq(campaignRoutesTable.organizationId, organizationId), eq(campaignRoutesTable.campaignId, campaignId)))
    .orderBy(asc(campaignRoutesTable.id));

  const frozenRoutes: FrozenRoute[] = [];
  for (const route of routes) {
    if (route.templateId === null) continue;
    frozenRoutes.push({
      routeId: route.id,
      phoneNumberId: route.phoneNumberId,
      templateId: route.templateId,
      configuredTps: route.configuredTps,
      providerTpsLimit: route.providerTpsLimit,
      phone: route.phone,
      displayName: route.displayName,
    });
  }
  if (!frozenRoutes.length) throw new CampaignNotReadyError(["No routes with an assigned template are available to plan"]);
  const routeIds = frozenRoutes.map((route) => route.routeId);
  const partitionCount = Math.max(routeIds.length, 64);

  const selections = await db.select({ templateId: campaignTemplateSelectionsTable.templateId })
    .from(campaignTemplateSelectionsTable).where(and(
      eq(campaignTemplateSelectionsTable.organizationId, organizationId),
      eq(campaignTemplateSelectionsTable.campaignId, campaignId),
    ));
  const mappings = await db.select().from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, organizationId),
    eq(campaignTemplateMappingsTable.campaignId, campaignId),
  ));

  // Freeze every selected template's content (name/language/wabaId for the
  // send payload, body/components for variable resolution) -- validated
  // readiness already guarantees every route's templateId is one of these
  // selections, so this snapshot covers every template a job can ever need.
  // See campaignPlansTable comment: resolution/sending must never fall back
  // to the live `templates` table for a planned job.
  const selectedTemplateIds = [...new Set(selections.map((selection) => selection.templateId))];
  const templatesSnapshot = selectedTemplateIds.length
    ? await db.select({
      id: templatesTable.id,
      name: templatesTable.name,
      language: templatesTable.language,
      wabaId: templatesTable.wabaId,
      body: templatesTable.body,
      components: templatesTable.components,
    }).from(templatesTable).where(and(
      eq(templatesTable.organizationId, organizationId),
      inArray(templatesTable.id, selectedTemplateIds),
    ))
    : [];

  const plan = await db.transaction(async (tx) => {
    await tx.update(campaignPlansTable).set({ status: "Superseded" }).where(and(
      eq(campaignPlansTable.campaignId, campaignId),
      eq(campaignPlansTable.status, "Active"),
    ));
    const [{ maxVersion }] = await tx.select({
      maxVersion: sql<number>`coalesce(max(${campaignPlansTable.version}), 0)`,
    }).from(campaignPlansTable).where(eq(campaignPlansTable.campaignId, campaignId));
    const [created] = await tx.insert(campaignPlansTable).values({
      organizationId,
      campaignId,
      version: maxVersion + 1,
      allocatorVersion: ALLOCATOR_VERSION,
      partitionCount,
      routes: frozenRoutes,
      templateIds: selections.map((selection) => selection.templateId),
      templatesSnapshot,
      mappingsSnapshot: mappings.map(({ templateId, component, variable, source, sourceValue, optional, fallbackValue }) => ({
        templateId, component, variable, source, sourceValue, optional, fallbackValue,
      })),
      status: "Active",
    }).returning();
    return created!;
  });

  let allocated = 0;
  let cursor = 0;
  for (;;) {
    const contacts = await db.select({
      id: campaignContactsTable.id,
      normalizedPhone: campaignContactsTable.normalizedPhone,
    }).from(campaignContactsTable).where(and(
      eq(campaignContactsTable.organizationId, organizationId),
      eq(campaignContactsTable.campaignId, campaignId),
      eq(campaignContactsTable.status, "Valid"),
      sql`${campaignContactsTable.id} > ${cursor}`,
    )).orderBy(asc(campaignContactsTable.id)).limit(ALLOCATION_PAGE_SIZE);
    if (!contacts.length) break;
    cursor = contacts[contacts.length - 1]!.id;

    const rows = contacts.flatMap((contact) => {
      if (!contact.normalizedPhone) return [];
      const partitionKey = partitionFor(contact.normalizedPhone, partitionCount);
      const routeId = assignRoute(partitionKey, routeIds);
      const route = frozenRoutes.find((candidate) => candidate.routeId === routeId);
      if (!routeId || !route) return [];
      return [{
        organizationId,
        campaignId,
        planId: plan.id,
        contactId: contact.id,
        partitionKey,
        routeId,
        phoneNumberId: route.phoneNumberId,
        templateId: route.templateId,
      }];
    });
    if (!rows.length) continue;

    await db.transaction(async (tx) => {
      await tx.insert(campaignAllocationsTable).values(rows).onConflictDoUpdate({
        target: [campaignAllocationsTable.campaignId, campaignAllocationsTable.contactId],
        set: {
          planId: sql`excluded.plan_id`,
          partitionKey: sql`excluded.partition_key`,
          routeId: sql`excluded.route_id`,
          phoneNumberId: sql`excluded.phone_number_id`,
          templateId: sql`excluded.template_id`,
          updatedAt: sql`now()`,
        },
      });
      for (const row of rows) {
        await tx.update(campaignContactsTable).set({
          routeId: row.routeId,
          partitionKey: row.partitionKey,
        }).where(eq(campaignContactsTable.id, row.contactId));
      }
    });
    allocated += rows.length;
  }

  await db.update(campaignsTable).set({ status: "Ready" }).where(and(
    eq(campaignsTable.id, campaignId),
    inArray(campaignsTable.status, [...PLANNABLE_STATUSES]),
  ));
  await db.insert(campaignAuditTable).values({
    organizationId,
    campaignId,
    action: "planned",
    fromStatus: campaign.status,
    toStatus: "Ready",
    metadata: { planId: plan.id, version: plan.version, allocated, routeCount: frozenRoutes.length },
  });

  return { plan, allocated };
}

/**
 * Creates bounded, persistent campaign_jobs rows from the campaign's active
 * frozen plan and moves the campaign into Running. Idempotent: every job is
 * inserted with `onConflictDoNothing` on the same (organizationId,
 * idempotencyKey) contract the CSV import path already used, so calling
 * execute again after a partial failure, a worker crash, or a server
 * restart only creates whatever jobs are still missing -- it never
 * duplicates a send. Only flips the campaign to Running once every
 * allocation-derived job has been created.
 */
export async function executeCampaignPlan(organizationId: number, campaignId: number): Promise<{ campaign: Campaign; plan: CampaignPlan; queuedNew: number }> {
  return withCampaignLifecycleLock(campaignId, (scopedDb) => executeCampaignPlanLocked(scopedDb, organizationId, campaignId));
}

async function executeCampaignPlanLocked(db: typeof import("@workspace/db").db, organizationId: number, campaignId: number): Promise<{ campaign: Campaign; plan: CampaignPlan; queuedNew: number }> {
  const [campaign] = await db.select().from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  ));
  if (!campaign) throw new Error("Campaign not found");
  if (!(EXECUTABLE_STATUSES as readonly string[]).includes(campaign.status)) {
    throw new Error(`Campaign cannot be executed from status ${campaign.status}`);
  }
  const [plan] = await db.select().from(campaignPlansTable).where(and(
    eq(campaignPlansTable.organizationId, organizationId),
    eq(campaignPlansTable.campaignId, campaignId),
    eq(campaignPlansTable.status, "Active"),
  ));
  if (!plan) throw new CampaignNotReadyError(["Campaign has no frozen execution plan; run plan before execute"]);

  const frozenRouteById = new Map((plan.routes as FrozenRoute[]).map((route) => [route.routeId, route]));

  let queuedNew = 0;
  let cursor = 0;
  for (;;) {
    const page = await db.select({
      contactId: campaignAllocationsTable.contactId,
      routeId: campaignAllocationsTable.routeId,
      idempotencyKey: campaignContactsTable.idempotencyKey,
    }).from(campaignAllocationsTable)
      .innerJoin(campaignContactsTable, and(
        eq(campaignContactsTable.id, campaignAllocationsTable.contactId),
        eq(campaignContactsTable.organizationId, campaignAllocationsTable.organizationId),
      ))
      .where(and(
        eq(campaignAllocationsTable.organizationId, organizationId),
        eq(campaignAllocationsTable.campaignId, campaignId),
        eq(campaignAllocationsTable.planId, plan.id),
        eq(campaignContactsTable.status, "Valid"),
        sql`${campaignAllocationsTable.contactId} > ${cursor}`,
      ))
      .orderBy(asc(campaignAllocationsTable.contactId))
      .limit(EXECUTE_PAGE_SIZE);
    if (!page.length) break;
    cursor = page[page.length - 1]!.contactId;

    const created = await db.transaction(async (tx) => {
      const inserted = await tx.insert(campaignJobsTable).values(page.map((row) => {
        const frozenRoute = row.routeId != null ? frozenRouteById.get(row.routeId) : undefined;
        return {
          organizationId,
          campaignId,
          routeId: row.routeId,
          contactId: row.contactId,
          // Copy the plan's frozen TPS/template evidence onto the job itself
          // so a live route edit made after planning (even mid-campaign,
          // e.g. while Paused) can never change what this already-created
          // job sends or how fast it sends -- see campaignJobsTable comment.
          configuredTps: frozenRoute?.configuredTps ?? null,
          templateId: frozenRoute?.templateId ?? null,
          // Stamp the exact plan this job came from -- resolution must
          // always read mappings from THIS plan, never whichever plan is
          // currently "Active" (a replan can activate a newer plan while
          // this job is still in flight).
          planId: plan.id,
          type: "ResolveTemplateAndSend",
          idempotencyKey: `send:${row.idempotencyKey}`,
          payload: { contactId: row.contactId },
        };
      })).onConflictDoNothing({
        target: [campaignJobsTable.organizationId, campaignJobsTable.idempotencyKey],
      }).returning({ routeId: campaignJobsTable.routeId });
      if (!inserted.length) return 0;
      const perRoute = new Map<number, number>();
      for (const row of inserted) {
        if (row.routeId === null) continue;
        perRoute.set(row.routeId, (perRoute.get(row.routeId) ?? 0) + 1);
      }
      for (const [routeId, count] of perRoute) {
        await tx.update(campaignRoutesTable).set({
          queueDepth: sql`${campaignRoutesTable.queueDepth} + ${count}`,
        }).where(eq(campaignRoutesTable.id, routeId));
      }
      await tx.update(campaignMetricsTable).set({
        queued: sql`${campaignMetricsTable.queued} + ${inserted.length}`,
      }).where(eq(campaignMetricsTable.campaignId, campaignId));
      return inserted.length;
    });
    queuedNew += created;
  }

  const now = new Date();
  const [activated] = await db.update(campaignsTable).set({
    status: "Running",
    startedAt: campaign.startedAt ?? now,
  }).where(and(
    eq(campaignsTable.id, campaignId),
    inArray(campaignsTable.status, ["Ready", "Scheduled"]),
  )).returning();
  if (activated) {
    await db.insert(campaignAuditTable).values({
      organizationId,
      campaignId,
      action: "executed",
      fromStatus: campaign.status,
      toStatus: "Running",
      metadata: { planId: plan.id, version: plan.version, queuedNew },
    });
  }

  const [finalCampaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  return { campaign: finalCampaign!, plan, queuedNew };
}
