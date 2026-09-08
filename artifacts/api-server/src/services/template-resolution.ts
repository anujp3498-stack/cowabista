import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  templatesTable,
  type CampaignJob,
  type CampaignPlan,
} from "@workspace/db";
import { describeTemplate, type TemplateDescriptor } from "./template-mapping";

export type ResolvableMapping = {
  component: string;
  variable: string;
  source: string;
  sourceValue: string;
  optional?: boolean | null;
  fallbackValue?: string | null;
};

const FROZEN_PLAN_CACHE_TTL_MS = 10 * 60_000;
const FROZEN_PLAN_CACHE_MAX_ENTRIES = 512;
const frozenPlanCache = new Map<string, {
  plan?: CampaignPlan;
  expiresAt: number;
  pending?: Promise<CampaignPlan | undefined>;
}>();

/**
 * Executed plans are immutable snapshots. Cache only explicit job.planId
 * lookups; legacy jobs still resolve the current Active plan on every call.
 * Pending entries also coalesce the first refill read when multiple phone
 * lanes warm up at the same time.
 */
async function frozenPlanById(
  organizationId: number,
  campaignId: number,
  planId: number,
): Promise<CampaignPlan | undefined> {
  const key = `${organizationId}:${campaignId}:${planId}`;
  const now = Date.now();
  const cached = frozenPlanCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.pending ?? cached.plan;
  }
  if (frozenPlanCache.size >= FROZEN_PLAN_CACHE_MAX_ENTRIES) {
    const oldest = frozenPlanCache.keys().next().value;
    if (oldest) frozenPlanCache.delete(oldest);
  }
  const pending = db.select().from(campaignPlansTable).where(and(
    eq(campaignPlansTable.id, planId),
    eq(campaignPlansTable.organizationId, organizationId),
    eq(campaignPlansTable.campaignId, campaignId),
  )).then(([plan]) => plan);
  frozenPlanCache.set(key, { expiresAt: now + FROZEN_PLAN_CACHE_TTL_MS, pending });
  try {
    const plan = await pending;
    frozenPlanCache.set(key, { plan, expiresAt: Date.now() + FROZEN_PLAN_CACHE_TTL_MS });
    return plan;
  } catch (error) {
    frozenPlanCache.delete(key);
    throw error;
  }
}

/**
 * Resolves the exact plan a job was created from (by job.planId), falling
 * back to the campaign's current Active plan only for jobs that predate the
 * planId column or were created directly against the live tables (e.g.
 * fixtures that bypass plan/execute). A replan can supersede and activate a
 * new plan while an older job is still in flight -- resolving against
 * "whatever is Active now" instead of the job's own plan would silently
 * swap that job onto a different plan's frozen mappings/templates.
 */
async function planForJob(job: CampaignJob): Promise<CampaignPlan | undefined> {
  const [plan] = job.planId
    ? [await frozenPlanById(job.organizationId, job.campaignId, job.planId)]
    : await db.select().from(campaignPlansTable).where(and(
      eq(campaignPlansTable.organizationId, job.organizationId),
      eq(campaignPlansTable.campaignId, job.campaignId),
      eq(campaignPlansTable.status, "Active"),
    ))
      .orderBy(desc(campaignPlansTable.version))
      .limit(1);
  return plan;
}

/**
 * Recovers the template a job's frozen plan actually assigned it to, and
 * that template's frozen content -- WITHOUT touching the live `templates`,
 * `campaign_template_selections`, or `campaign_template_mappings` tables.
 * Those are org-editable at any time (including template PATCH/DELETE and
 * mapping/selection replacement), so a planned/executing job must never
 * depend on them for identity or content: a template edited or deleted
 * after planning must not change what an already-planned job resolves to,
 * and must not break resolution when the row is gone entirely (e.g. the FK
 * from campaign_jobs.template_id to templates sets it null on delete).
 */
function frozenTemplateForJob(job: CampaignJob, plan: CampaignPlan): { id: number; descriptor: TemplateDescriptor; mappings: ResolvableMapping[] } | undefined {
  const frozenRoute = plan.routes.find((route) => route.routeId === job.routeId);
  const effectiveTemplateId = frozenRoute?.templateId ?? job.templateId ?? undefined;
  if (!effectiveTemplateId) return undefined;
  const snapshot = plan.templatesSnapshot.find((template) => template.id === effectiveTemplateId);
  if (!snapshot) return undefined;
  return {
    id: effectiveTemplateId,
    descriptor: { id: snapshot.id, body: snapshot.body, components: snapshot.components },
    mappings: plan.mappingsSnapshot.filter((mapping) => mapping.templateId === effectiveTemplateId),
  };
}

/**
 * Pure resolution core shared by the live job-resolution path
 * (resolveJobTemplate below, which persists the result onto a leased job)
 * and the read-only plan-preview path (campaign-plan-preview.ts, which
 * shows support/ops exactly what a frozen plan will send without touching
 * any job or lease). Throws the same errors either caller would need to
 * surface: a required variable with no mapping, or one that resolves empty
 * with no usable fallback.
 */
export function resolveTemplateVariables(
  descriptor: TemplateDescriptor,
  mappingRows: ResolvableMapping[],
  contactData: Record<string, string>,
): Record<string, Record<string, string>> {
  const described = describeTemplate(descriptor);
  const byKey = new Map(mappingRows.map((mapping) => [`${mapping.component}:${mapping.variable}`, mapping]));
  const resolved: Record<string, Record<string, string>> = { header: {}, body: {}, button: {} };
  for (const requirement of described.requiredVariables) {
    const [component, ...variableParts] = requirement.split(":");
    const variable = variableParts.join(":");
    const mapping = byKey.get(`${component}:${variable}`);
    if (!mapping) throw new Error(`Missing mapping ${requirement} for template ${descriptor.id}`);
    const raw = mapping.source === "csv" ? contactData[mapping.sourceValue] : mapping.sourceValue;
    const value = raw === undefined || raw === ""
      ? (mapping.optional && mapping.fallbackValue ? mapping.fallbackValue : undefined)
      : raw;
    if (value === undefined) throw new Error(`Mapping ${requirement} resolved to an empty value`);
    resolved[component]![variable] = value;
  }
  return resolved;
}

export async function resolveJobTemplate(job: CampaignJob): Promise<CampaignJob> {
  if (!job.leaseToken) throw new Error("Template resolution requires an active job lease");

  const [contact] = await db.select({ data: campaignContactsTable.data }).from(campaignContactsTable).where(and(
    eq(campaignContactsTable.id, job.contactId ?? -1),
    eq(campaignContactsTable.organizationId, job.organizationId),
  ));
  if (!contact) throw new Error("Campaign contact is missing or not tenant-owned");

  const plan = await planForJob(job);
  const frozen = plan ? frozenTemplateForJob(job, plan) : undefined;

  let effectiveTemplateId: number;
  let rawDescriptor: TemplateDescriptor;
  let mappingRows: ResolvableMapping[];
  if (frozen) {
    effectiveTemplateId = frozen.id;
    rawDescriptor = frozen.descriptor;
    mappingRows = frozen.mappings;
  } else {
    // Legacy path for jobs created without going through plan/execute (no
    // plan, or a plan predating the templatesSnapshot column): fall back to
    // the live tables exactly as before.
    const effectiveTemplateIdExpr = sql<number>`coalesce(${campaignJobsTable.templateId}, ${campaignRoutesTable.templateId})`;
    const [context] = await db.select({
      routeTemplateId: effectiveTemplateIdExpr,
      templateBody: templatesTable.body,
      templateComponents: templatesTable.components,
      selectedTemplateId: campaignTemplateSelectionsTable.templateId,
    }).from(campaignJobsTable)
      .innerJoin(campaignRoutesTable, and(
        eq(campaignRoutesTable.id, campaignJobsTable.routeId),
        eq(campaignRoutesTable.organizationId, campaignJobsTable.organizationId),
      ))
      .innerJoin(templatesTable, and(
        eq(templatesTable.id, effectiveTemplateIdExpr),
        eq(templatesTable.organizationId, campaignJobsTable.organizationId),
      ))
      .leftJoin(campaignTemplateSelectionsTable, and(
        eq(campaignTemplateSelectionsTable.campaignId, campaignJobsTable.campaignId),
        eq(campaignTemplateSelectionsTable.templateId, templatesTable.id),
        eq(campaignTemplateSelectionsTable.organizationId, campaignJobsTable.organizationId),
      ))
      .where(and(eq(campaignJobsTable.id, job.id), eq(campaignJobsTable.status, "Processing")));
    if (!context?.routeTemplateId) throw new Error("Route template is missing or not tenant-owned");
    if (!context.selectedTemplateId) throw new Error(`Route template ${context.routeTemplateId} is not selected`);
    effectiveTemplateId = context.routeTemplateId;
    rawDescriptor = { id: context.routeTemplateId, body: context.templateBody, components: context.templateComponents };
    mappingRows = await db.select().from(campaignTemplateMappingsTable).where(and(
      eq(campaignTemplateMappingsTable.organizationId, job.organizationId),
      eq(campaignTemplateMappingsTable.campaignId, job.campaignId),
      eq(campaignTemplateMappingsTable.templateId, context.routeTemplateId),
    ));
  }
  const resolved = resolveTemplateVariables(rawDescriptor, mappingRows, contact.data);
  const payload = { ...job.payload, templateId: effectiveTemplateId, resolvedParameters: resolved };
  const [updated] = await db.update(campaignJobsTable).set({ payload }).where(and(
    eq(campaignJobsTable.id, job.id),
    eq(campaignJobsTable.status, "Processing"),
    eq(campaignJobsTable.leaseToken, job.leaseToken),
  )).returning();
  if (!updated) throw new Error("Job lease was revoked before template resolution");
  // Claim-time context may supply the route's locked effective TPS for
  // legacy/fixture jobs whose persisted frozen value is null. Preserve that
  // in-memory pacing metadata across the payload update/RETURNING round-trip.
  return {
    ...updated,
    configuredTps: job.configuredTps ?? updated.configuredTps,
  };
}

export type JobTemplateResolution = {
  job: CampaignJob;
  resolvedJob?: CampaignJob;
  error?: unknown;
};

/**
 * Production Plan→Execute batches share an organization/campaign and carry a
 * frozen planId. Resolve those jobs with one contact read, one plan read, and
 * one lease-fenced payload update instead of three database round trips per
 * job. Legacy/directly-created jobs retain the exact single-job resolver.
 */
export async function resolveJobTemplates(jobs: CampaignJob[]): Promise<JobTemplateResolution[]> {
  if (!jobs.length) return [];
  const first = jobs[0]!;
  const productionBatch = jobs.every((job) =>
    Boolean(job.planId)
    && job.organizationId === first.organizationId
    && job.campaignId === first.campaignId
    && Boolean(job.leaseToken));
  if (!productionBatch) {
    return Promise.all(jobs.map(async (job) => {
      try {
        return { job, resolvedJob: await resolveJobTemplate(job) };
      } catch (error) {
        return { job, error };
      }
    }));
  }

  const contactIds = [...new Set(jobs.flatMap((job) => job.contactId ? [job.contactId] : []))];
  const planIds = [...new Set(jobs.flatMap((job) => job.planId ? [job.planId] : []))];
  const [contacts, plans] = await Promise.all([
    contactIds.length
      ? db.select({
        id: campaignContactsTable.id,
        data: campaignContactsTable.data,
      }).from(campaignContactsTable).where(and(
        eq(campaignContactsTable.organizationId, first.organizationId),
        inArray(campaignContactsTable.id, contactIds),
      ))
      : Promise.resolve([]),
    Promise.all(planIds.map((planId) =>
      frozenPlanById(first.organizationId, first.campaignId, planId),
    )).then((resolvedPlans) => resolvedPlans.filter((plan): plan is CampaignPlan => Boolean(plan))),
  ]);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact.data]));
  const plansById = new Map(plans.map((plan) => [plan.id, plan]));
  const results: JobTemplateResolution[] = [];
  const updates: Array<{
    id: number;
    organizationId: number;
    campaignId: number;
    routeId: number | null;
    leaseToken: string;
    payload: Record<string, unknown>;
  }> = [];
  for (const job of jobs) {
    try {
      const contact = job.contactId ? contactsById.get(job.contactId) : undefined;
      if (!contact) throw new Error("Campaign contact is missing or not tenant-owned");
      const plan = job.planId ? plansById.get(job.planId) : undefined;
      if (!plan) throw new Error("Frozen campaign plan is missing or not tenant-owned");
      const frozen = frozenTemplateForJob(job, plan);
      if (!frozen) throw new Error("Frozen route template is missing");
      const resolved = resolveTemplateVariables(frozen.descriptor, frozen.mappings, contact);
      const payload = {
        ...(job.payload as Record<string, unknown>),
        templateId: frozen.id,
        resolvedParameters: resolved,
      };
      const resolvedJob = { ...job, templateId: frozen.id, payload };
      results.push({ job, resolvedJob });
      updates.push({
        id: job.id,
        organizationId: job.organizationId,
        campaignId: job.campaignId,
        routeId: job.routeId,
        leaseToken: job.leaseToken!,
        payload,
      });
    } catch (error) {
      results.push({ job, error });
    }
  }
  if (!updates.length) return results;
  const updated = await db.execute<{ id: number }>(sql`
    with input as (
      select *
      from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as item(
        id int,
        "organizationId" int,
        "campaignId" int,
        "routeId" int,
        "leaseToken" text,
        payload jsonb
      )
    )
    update campaign_jobs as job
    set payload = input.payload,
        updated_at = statement_timestamp()
    from input
    where job.id = input.id
      and job.organization_id = input."organizationId"
      and job.campaign_id = input."campaignId"
      and job.route_id is not distinct from input."routeId"
      and job.status = 'Processing'
      and job.lease_token = input."leaseToken"
    returning job.id
  `);
  const updatedIds = new Set(updated.rows.map(({ id }) => id));
  return results.map((result) => {
    if (!result.resolvedJob || updatedIds.has(result.job.id)) return result;
    return {
      job: result.job,
      error: new Error("Job lease was revoked before template resolution"),
    };
  });
}