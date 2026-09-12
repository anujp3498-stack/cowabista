import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignJobsTable,
  campaignMetricDeltasTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  phoneNumbersTable,
  settlementDb,
  type CampaignJob,
} from "@workspace/db";
import { inFlightRegistry } from "./campaign-inflight";
import {
  createCampaignPacingCoordinator,
  type AtomicPacingCoordinator,
} from "./campaign-pacing-coordinator";
import { resolveJobTemplate, resolveJobTemplates } from "./template-resolution";
import { isRetryableProviderError, ProviderRequestError } from "./whatsapp-provider";
import { logger } from "../lib/logger";
import { PhoneDispatchScheduler } from "./campaign-phone-dispatch-scheduler";
import { campaignDispatchMetrics } from "./campaign-dispatch-metrics";
import { CampaignTransportShards, type SerializableTransportPayload } from "./campaign-transport-shards";

export type SendOptions = { signal: AbortSignal; idempotencyKey: string };
export class PreparedProviderFailure {
  constructor(readonly error: unknown) {}
}
export interface ProviderSender {
  /** Implementations must honor signal, enforce a timeout shorter than the lease, and use idempotencyKey at the provider. */
  prepareBatch?(jobs: CampaignJob[], signal?: AbortSignal): Promise<Map<number, unknown>>;
  preparedRecipient?(preparedContext: unknown): { organizationId: number; recipient: string } | undefined;
  validatePrepared?(preparedContext: unknown): Promise<boolean>;
  /**
   * Set-based form of validatePrepared for one prepared batch: returns the job
   * ids whose envelope must be revoked. When a sender provides it, reservoir
   * preparation calls it once per batch instead of validatePrepared once per
   * message; its decisions must be identical to the per-message check.
   */
  validatePreparedBatch?(
    items: ReadonlyArray<{ jobId: number; preparedContext: unknown }>,
  ): Promise<ReadonlySet<number>>;
  revokePrepared?(preparedContext: unknown, reason: unknown): Promise<void>;
  /** Drains asynchronous durable provider-intent outcome writes. */
  flushPreparedOutcomes?(): Promise<void>;
  /** Returns a DB-free structured-clone-safe provider request for shard transport. */
  serializePreparedTransport?(job: CampaignJob, preparedContext: unknown): SerializableTransportPayload | undefined;
  /** Receives worker-clock timestamps after a shard-local provider completion. */
  observeShardTransport?(
    job: CampaignJob,
    timing: { startedAt?: number; completedAt?: number; error?: Error },
  ): void;
  observeShardTransportStart?(job: CampaignJob, startedAt: number): void;
  /**
   * Reservoir transport boundary. Implementations MUST NOT access PostgreSQL,
   * acquire locks, authorize, or update counters before starting HTTP. All of
   * that belongs in prepareBatch; durable result recording belongs in
   * settlePreparedTransport.
   */
  sendPreparedTransport?(
    job: CampaignJob,
    options: SendOptions,
    preparedContext: unknown,
  ): Promise<{ providerMessageId: string }>;
  settlePreparedTransport?(
    job: CampaignJob,
    preparedContext: unknown,
    outcome: { providerMessageId: string } | { error: unknown },
  ): Promise<void>;
  send(job: CampaignJob, options: SendOptions, preparedContext?: unknown): Promise<{ providerMessageId: string }>;
}

export type CampaignWorkerPhase =
  | "queue_wait"
  | "template_resolution"
  | "pacing_wait"
  | "dispatch_handoff"
  | "transport_start"
  | "provider"
  | "success_settlement"
  | "failure_settlement";

export interface CampaignWorkerObserver {
  record(phase: CampaignWorkerPhase, durationMs: number, jobs: number): void;
}

type CampaignJobWithDispatchPhone = CampaignJob & { dispatchPhoneNumberId?: number };

/** A fully resolved, durably armed send which may enter a phone-owned FIFO. */
export type PreparedCampaignEnvelope = {
  job: CampaignJobWithDispatchPhone;
  preparedContext: unknown;
  registration: ReturnType<typeof inFlightRegistry.register>;
};
export type BrokerPreparedCampaignEnvelope = Omit<PreparedCampaignEnvelope, "registration">;

export class SimulatedProviderSender implements ProviderSender {
  async send(job: CampaignJob, { signal, idempotencyKey }: SendOptions): Promise<{ providerMessageId: string }> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 25);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Send aborted"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    return { providerMessageId: `simulated-${idempotencyKey}-${job.attempts}` };
  }
}

export function retryAt(attempt: number, now = new Date()): Date {
  return new Date(now.getTime() + Math.min(3600, 2 ** Math.max(0, attempt) * 5) * 1000);
}

/**
 * A lease-expiry recovery (worker crashed, was killed, or never checked
 * back in) never goes through CampaignWorker.processOne's own catch
 * block -- there's no thrown error to catch, since the whole process died.
 * That block is the ONLY place maxAttempts is normally enforced. Without
 * an equivalent check here, a "poison pill" job -- one whose specific
 * payload/resolution reliably crashes the worker every time it's attempted
 * -- would be requeued to "Queued" forever: attempts increments each time
 * it's re-claimed, but nothing ever compares it to maxAttempts, so it
 * crash-loops the whole runtime indefinitely and starves every other job
 * on its route/phone.
 */
export function isExhaustedByAttempts(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

export class RouteTpsLimiter {
  private readonly coordinator: AtomicPacingCoordinator;
  readonly distributed = true;

  constructor(coordinator: AtomicPacingCoordinator = createCampaignPacingCoordinator()) {
    this.coordinator = coordinator;
  }

  reserveBatch(input: Parameters<AtomicPacingCoordinator["reserveBatch"]>[0]) {
    return this.coordinator.reserveBatch(input);
  }

  close(): Promise<void> {
    return this.coordinator.close();
  }
}

/** Maximum eligible jobs examined by one claim attempt. */
export const CLAIM_CANDIDATE_LIMIT = 100;
const CLAIM_CANDIDATES_PER_ROUTE = 64;
const CLAIM_CANDIDATES_PER_PHONE = 64;
// claimBatch() returns at most `batchSize` jobs from one route, but its global
// candidate prefix used to contain only one batch total. With two equally hot
// numbers that split the prefix into ~128 candidates each, forcing each route
// below its requested batch size and creating an accidental process-wide TPS
// ceiling. Keep the scan bounded while reserving one full 256-job quota for
// each of the runtime's maximum eight independent route lanes.
const BATCH_CANDIDATE_LIMIT = 256 * 8;
/** Claim a short future horizon so provider calls can be evenly staggered without holding a DB transaction open. */
// Keep the deterministic phone timeline filled to the same bounded three
// seconds allowed by maxInFlightForRoute(). A one-second horizon is exhausted
// by four 256-job lanes at 1000 TPS; every later lane then claims only the few
// milliseconds that opened since its previous transaction, turning claims
// back into per-message DB work. Three seconds restores full-batch refills
// while staying far inside the 30s production lease. Short leases reduce this
// automatically below via LEASE_DISPATCH_SAFETY_MS.
export const PACING_LOOKAHEAD_MS = 3_000;
export const PACING_PREPARE_MS = 250;
const LEASE_DISPATCH_SAFETY_MS = 250;

const METRIC_DELTA_FLUSH_LIMIT = 4_096;

/**
 * Atomically consumes durable runtime deltas and folds each campaign once.
 * Claims append independent rows, so four hot routes no longer serialize on
 * campaign_metrics. SKIP LOCKED also lets shutdown/completion and the periodic
 * flusher cooperate without applying any delta twice.
 */
export async function flushCampaignMetricDeltas(
  campaignId?: number,
  limit = METRIC_DELTA_FLUSH_LIMIT,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(limit, METRIC_DELTA_FLUSH_LIMIT));
  const result = await settlementDb.execute<{ consumed: number }>(sql`
    with claimed as materialized (
      select delta.id
      from campaign_metric_deltas as delta
      inner join campaign_metrics as metrics
        on metrics.campaign_id = delta.campaign_id
       and metrics.organization_id = delta.organization_id
      where (${campaignId ?? null}::int is null or delta.campaign_id = ${campaignId ?? null})
      order by delta.id
      limit ${boundedLimit}
      for update of delta skip locked
    ),
    consumed as materialized (
      delete from campaign_metric_deltas as delta
      using claimed
      where delta.id = claimed.id
      returning
        delta.organization_id,
        delta.campaign_id,
        delta.queued_delta,
        delta.processing_delta,
        delta.sent_delta,
        delta.failed_delta,
        delta.retry_delta
    ),
    aggregated as materialized (
      select
        organization_id,
        campaign_id,
        sum(queued_delta)::int as queued_delta,
        sum(processing_delta)::int as processing_delta,
        sum(sent_delta)::int as sent_delta,
        sum(failed_delta)::int as failed_delta,
        sum(retry_delta)::int as retry_delta
      from consumed
      group by organization_id, campaign_id
    ),
    updated_metrics as (
      update campaign_metrics as metrics
      set queued = greatest(0, metrics.queued + aggregated.queued_delta),
          processing = greatest(0, metrics.processing + aggregated.processing_delta),
          sent = greatest(0, metrics.sent + aggregated.sent_delta),
          failed = greatest(0, metrics.failed + aggregated.failed_delta),
          retry_count = greatest(0, metrics.retry_count + aggregated.retry_delta),
          updated_at = statement_timestamp()
      from aggregated
      where metrics.organization_id = aggregated.organization_id
        and metrics.campaign_id = aggregated.campaign_id
      returning metrics.campaign_id
    ),
    updated_campaigns as (
      update campaigns as campaign
      set sent = greatest(0, campaign.sent + aggregated.sent_delta),
          failed = greatest(0, campaign.failed + aggregated.failed_delta),
          updated_at = statement_timestamp()
      from aggregated
      where campaign.organization_id = aggregated.organization_id
        and campaign.id = aggregated.campaign_id
      returning campaign.id
    )
    select count(*)::int as consumed from consumed
  `);
  return result.rows[0]?.consumed ?? 0;
}

export async function deleteOrphanedCampaignMetricDeltas(): Promise<void> {
  await settlementDb.execute(sql`
    delete from campaign_metric_deltas as delta
    where not exists (
      select 1
      from campaign_metrics as metrics
      where metrics.campaign_id = delta.campaign_id
        and metrics.organization_id = delta.organization_id
    )
  `);
}

export async function flushAllCampaignMetricDeltas(campaignId?: number): Promise<void> {
  for (;;) {
    const consumed = await flushCampaignMetricDeltas(campaignId);
    if (consumed < METRIC_DELTA_FLUSH_LIMIT) return;
  }
}

/**
 * Postgres deadlock_detected (40P01) and serialization_failure (40001) are
 * expected, transient outcomes of running many concurrent claim() lanes
 * that lock the same small set of campaign/route/phone rows in overlapping
 * transactions -- not evidence of a stuck job. Postgres itself picks one
 * transaction to abort and resolves the cycle; the caller's job is only to
 * retry, not to treat it as a hard failure.
 */
function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code
    ?? (error as { code?: unknown })?.code;
  return code === "40P01" || code === "40001";
}

async function retryTransaction<T>(
  operation: () => Promise<T>,
  maxAttempts = 8,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * attempt * 10));
    }
  }
}

export class DatabaseJobQueue {
  async enqueue(values: typeof campaignJobsTable.$inferInsert): Promise<CampaignJob> {
    const [created] = await db.insert(campaignJobsTable).values(values).onConflictDoNothing().returning();
    if (created) return created;
    const [existing] = await db.select().from(campaignJobsTable).where(and(
      eq(campaignJobsTable.organizationId, values.organizationId),
      eq(campaignJobsTable.idempotencyKey, values.idempotencyKey),
    ));
    if (!existing) throw new Error("Unable to enqueue idempotent campaign job");
    if (existing.campaignId !== values.campaignId) {
      throw new Error("Campaign job idempotency key belongs to a different campaign");
    }
    return existing;
  }

  async renewBrokerLeases(
    leases: ReadonlyArray<{
      jobId: number;
      organizationId: number;
      campaignId: number;
      leaseToken: string;
    }>,
    leaseMs: number,
  ): Promise<number> {
    if (!leases.length) return 0;
    const input = leases.map((lease) => ({
      jobId: lease.jobId,
      organizationId: lease.organizationId,
      campaignId: lease.campaignId,
      leaseToken: lease.leaseToken,
    }));
    const result = await db.execute<{ id: number }>(sql`
      with input as (
        select *
        from jsonb_to_recordset(${JSON.stringify(input)}::jsonb) as item(
          "jobId" int,
          "organizationId" int,
          "campaignId" int,
          "leaseToken" text
        )
      )
      update campaign_jobs as job
      set lease_expires_at = statement_timestamp() + (${leaseMs} * interval '1 millisecond'),
          updated_at = statement_timestamp()
      from input
      where job.id = input."jobId"
        and job.organization_id = input."organizationId"
        and job.campaign_id = input."campaignId"
        and job.status = 'Processing'
        and job.lease_token = input."leaseToken"
        and job.lease_expires_at > statement_timestamp()
      returning job.id
    `);
    return result.rows.length;
  }

  /**
   * Candidates whose routeId is in `busyRouteIds` are skipped in-process,
   * without an extra DB round trip. This process's own concurrent lanes
   * (CONCURRENT_SEND_LANES) will typically outnumber the distinct routes a
   * runtime is servicing; without this, every lane races the same
   * candidate list, and most of them collide on the same handful of
   * campaign/route/phone rows that CampaignWorker.processOne's completion
   * transaction locks, serializing behind each other and starving whatever
   * route happens to need the most throughput. Capping how many of THIS
   * process's own lanes work one route at a time removes that
   * self-inflicted contention while still letting many distinct routes run
   * fully in parallel -- it never limits cross-process throughput, since
   * the actual TPS ceiling remains the atomic pacing-coordinator reservation
   * below, not this in-memory set.
   */
  async claim(
    limiter: RouteTpsLimiter,
    workerId: string,
    leaseMs: number,
    now = new Date(),
    busyRouteIds?: ReadonlyMap<number, number>,
    getMaxInFlight?: (configuredTps: number) => number,
    claimingRouteIds?: Set<number>,
  ): Promise<CampaignJob | undefined> {
    const [job] = await this.claimBatch(
      limiter,
      workerId,
      leaseMs,
      1,
      now,
      busyRouteIds,
      getMaxInFlight,
      claimingRouteIds,
    );
    if (job) {
      // Preserve claim()'s historical synchronous aggregate-counter contract
      // for single-job callers and crash-recovery tests. Production workers
      // use claimBatch(), whose deltas stay off the pacing hot path.
      await flushCampaignMetricDeltas(job.campaignId);
    }
    return job;
  }

  async claimBatch(
    limiter: RouteTpsLimiter,
    workerId: string,
    leaseMs: number,
    batchSize: number,
    now = new Date(),
    busyRouteIds?: ReadonlyMap<number, number>,
    getMaxInFlight?: (configuredTps: number) => number,
    claimingRouteIds?: Set<number>,
    phoneNumberId?: number,
  ): Promise<CampaignJob[]> {
    const boundedSize = Math.max(1, Math.min(batchSize, BATCH_CANDIDATE_LIMIT));
    const batchRouteCandidates = db.select({
      id: campaignJobsTable.id,
      organizationId: campaignJobsTable.organizationId,
      campaignId: campaignJobsTable.campaignId,
      jobConfiguredTps: sql<number | null>`${campaignJobsTable.configuredTps}`.as("batch_job_configured_tps"),
      availableAt: campaignJobsTable.availableAt,
    }).from(campaignJobsTable)
      .where(and(
        eq(campaignJobsTable.routeId, campaignRoutesTable.id),
        eq(campaignJobsTable.organizationId, campaignRoutesTable.organizationId),
        eq(campaignJobsTable.status, "Queued"),
        lte(campaignJobsTable.availableAt, now),
         ...(phoneNumberId === undefined
           ? []
           : [eq(campaignRoutesTable.phoneNumberId, phoneNumberId)]),
        ...(phoneNumberId === undefined ? [] : [sql`exists (
          select 1 from campaign_routes as phone_route
          where phone_route.id = ${campaignJobsTable.routeId}
            and phone_route.organization_id = ${campaignJobsTable.organizationId}
            and phone_route.phone_number_id = ${phoneNumberId}
        )`]),
      ))
      .orderBy(asc(campaignJobsTable.availableAt), asc(campaignJobsTable.id))
      .limit(BATCH_CANDIDATE_LIMIT)
      .as("batch_route_candidates");
    const batchEligible = db.select({
      id: batchRouteCandidates.id,
      organizationId: batchRouteCandidates.organizationId,
      campaignId: batchRouteCandidates.campaignId,
      routeId: sql<number>`${campaignRoutesTable.id}`.as("batch_route_id"),
      jobConfiguredTps: batchRouteCandidates.jobConfiguredTps,
      routeConfiguredTps: sql<number>`${campaignRoutesTable.configuredTps}`.as("batch_route_configured_tps"),
      phoneNumberId: campaignRoutesTable.phoneNumberId,
      phoneTpsLimit: phoneNumbersTable.tpsLimit,
      routeSchedulingAt: campaignRoutesTable.updatedAt,
      availableAt: batchRouteCandidates.availableAt,
      priority: campaignsTable.priority,
    }).from(campaignRoutesTable)
      .innerJoin(campaignsTable, and(
        eq(campaignsTable.id, campaignRoutesTable.campaignId),
        eq(campaignsTable.organizationId, campaignRoutesTable.organizationId),
      ))
      .innerJoin(phoneNumbersTable, and(
        eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId),
        eq(phoneNumbersTable.organizationId, campaignRoutesTable.organizationId),
      ))
      .crossJoinLateral(batchRouteCandidates)
      .where(and(
        eq(campaignsTable.status, "Running"),
        eq(campaignsTable.killSwitch, false),
        eq(campaignRoutesTable.status, "Active"),
        sql`coalesce(${batchRouteCandidates.jobConfiguredTps}, ${campaignRoutesTable.configuredTps}) >= 1`,
        sql`${phoneNumbersTable.tpsLimit} >= 1`,
        sql`coalesce(${batchRouteCandidates.jobConfiguredTps}, ${campaignRoutesTable.configuredTps}) <= ${phoneNumbersTable.tpsLimit}`,
      ))
      .as("batch_eligible_campaign_jobs");
    const batchPhoneFair = db.select({
      id: batchEligible.id,
      organizationId: batchEligible.organizationId,
      campaignId: batchEligible.campaignId,
      routeId: batchEligible.routeId,
      jobConfiguredTps: batchEligible.jobConfiguredTps,
      routeConfiguredTps: batchEligible.routeConfiguredTps,
      phoneNumberId: batchEligible.phoneNumberId,
      phoneTpsLimit: batchEligible.phoneTpsLimit,
      routeSchedulingAt: batchEligible.routeSchedulingAt,
      availableAt: batchEligible.availableAt,
      priority: batchEligible.priority,
      phoneRank: sql<number>`row_number() over (
        partition by ${batchEligible.organizationId}, ${batchEligible.phoneNumberId}
        order by ${batchEligible.routeSchedulingAt}, ${batchEligible.availableAt}, ${batchEligible.id}
      )`.as("batch_phone_rank"),
    }).from(batchEligible).as("batch_phone_fair_campaign_jobs");
    const candidates = await db.select({
      id: batchPhoneFair.id,
      organizationId: batchPhoneFair.organizationId,
      campaignId: batchPhoneFair.campaignId,
      routeId: batchPhoneFair.routeId,
      jobConfiguredTps: batchPhoneFair.jobConfiguredTps,
      routeConfiguredTps: batchPhoneFair.routeConfiguredTps,
      phoneNumberId: batchPhoneFair.phoneNumberId,
      phoneTpsLimit: batchPhoneFair.phoneTpsLimit,
    }).from(batchPhoneFair)
      // One batch quota per phone keeps independent numbers fed without
      // materializing the full eight-route ceiling for a one-route campaign.
      .where(and(
        lte(batchPhoneFair.phoneRank, boundedSize),
        ...(phoneNumberId === undefined ? [] : [eq(batchPhoneFair.phoneNumberId, phoneNumberId)]),
      ))
      .orderBy(
        asc(batchPhoneFair.phoneRank),
        asc(batchPhoneFair.routeSchedulingAt),
        asc(batchPhoneFair.availableAt),
        sql`case ${batchPhoneFair.priority} when 'High' then 0 when 'Normal' then 1 else 2 end`,
        asc(batchPhoneFair.id),
      )
      .limit(Math.min(BATCH_CANDIDATE_LIMIT, boundedSize * 8));

    const byRoute = new Map<number, typeof candidates>();
    for (const candidate of candidates) {
      if (candidate.routeId === null) continue;
      const configuredTps = candidate.jobConfiguredTps ?? candidate.routeConfiguredTps ?? 0;
      if (getMaxInFlight && (busyRouteIds?.get(candidate.routeId) ?? 0) >= getMaxInFlight(configuredTps)) continue;
      const routeQueue = byRoute.get(candidate.routeId) ?? [];
      routeQueue.push(candidate);
      byRoute.set(candidate.routeId, routeQueue);
    }
    const routeQueues = [...byRoute.values()].sort((left, right) => {
      const leftSeed = left[0];
      const rightSeed = right[0];
      if (!leftSeed || leftSeed.routeId === null) return 1;
      if (!rightSeed || rightSeed.routeId === null) return -1;
      const leftTps = Math.max(1, leftSeed.jobConfiguredTps ?? leftSeed.routeConfiguredTps ?? 1);
      const rightTps = Math.max(1, rightSeed.jobConfiguredTps ?? rightSeed.routeConfiguredTps ?? 1);
      const leftLoad = (busyRouteIds?.get(leftSeed.routeId) ?? 0) / leftTps;
      const rightLoad = (busyRouteIds?.get(rightSeed.routeId) ?? 0) / rightTps;
      return leftLoad - rightLoad;
    });
    for (const routeQueue of routeQueues) {
      const selected = routeQueue.slice(0, boundedSize);
      const seed = selected[0];
      if (!seed || seed.routeId === null) continue;
      if (claimingRouteIds?.has(seed.routeId)) continue;
      const effectiveConfiguredTps = seed.jobConfiguredTps ?? seed.routeConfiguredTps;
      const matching = selected.filter((candidate) =>
        (candidate.jobConfiguredTps ?? candidate.routeConfiguredTps) === effectiveConfiguredTps);
      const inFlightAllowance = getMaxInFlight
        ? Math.max(0, getMaxInFlight(effectiveConfiguredTps) - (busyRouteIds?.get(seed.routeId) ?? 0))
        : matching.length;
      const requested = Math.min(matching.length, inFlightAllowance);
      if (requested < 1) continue;

      // Redis (or the equivalent atomic coordinator) owns the hot pacing
      // timeline. Reserve before entering PostgreSQL so no database row is
      // locked while waiting for the limiter. A claim race may waste a few
      // temporary permits, but they are never replayed; safety is asymmetric
      // toward underfill rather than a catch-up burst.
      const pacing = await limiter.reserveBatch({
        organizationId: seed.organizationId,
        phoneNumberId: seed.phoneNumberId,
        routeId: seed.routeId,
        phoneTps: seed.phoneTpsLimit,
        routeTps: effectiveConfiguredTps,
        requested,
        prepareMs: PACING_PREPARE_MS,
        // A short test/recovery lease must never own a slot whose not-before
        // time consumes the whole lease. Production's 30s lease retains the
        // full one-second prefetch horizon; shorter leases automatically
        // reduce it and leave time for the provider handoff before reaping.
        maxLookaheadMs: Math.min(
          PACING_LOOKAHEAD_MS,
          Math.max(0, leaseMs - PACING_PREPARE_MS - LEASE_DISPATCH_SAFETY_MS),
        ),
      });
      if (!pacing.slots.length) continue;
      const reservedCandidates = matching.slice(0, pacing.slots.length);

      claimingRouteIds?.add(seed.routeId);
      let claimed: CampaignJob[];
      try {
        claimed = await retryTransaction(() => db.transaction(async (tx) => {
        const [context] = await tx.select({
          campaignStatus: campaignsTable.status,
          campaignKillSwitch: campaignsTable.killSwitch,
          routeStatus: campaignRoutesTable.status,
          routeConfiguredTps: campaignRoutesTable.configuredTps,
          phoneNumberId: campaignRoutesTable.phoneNumberId,
          phoneTpsLimit: phoneNumbersTable.tpsLimit,
        }).from(campaignsTable)
          .innerJoin(campaignRoutesTable, and(
            eq(campaignRoutesTable.id, seed.routeId!),
            eq(campaignRoutesTable.organizationId, campaignsTable.organizationId),
            eq(campaignRoutesTable.campaignId, campaignsTable.id),
          ))
          .innerJoin(phoneNumbersTable, and(
            eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId),
            eq(phoneNumbersTable.organizationId, campaignsTable.organizationId),
          ))
          .where(and(
            eq(campaignsTable.id, seed.campaignId),
            eq(campaignsTable.organizationId, seed.organizationId),
          ))
          // This shared lock only fences a concurrent provider-cap edit. It is
          // compatible across claimers and is not a pacing counter.
          .for("share", { of: [phoneNumbersTable] });
        if (
          !context
          || context.campaignStatus !== "Running"
          || context.campaignKillSwitch
          || context.routeStatus !== "Active"
          || (phoneNumberId !== undefined && context.phoneNumberId !== phoneNumberId)
        ) return [];

        if (
          effectiveConfiguredTps < 1
          || context.phoneTpsLimit < 1
          || pacing.effectiveRouteTps > context.phoneTpsLimit
        ) return [];
        // The outer candidate scan is lock-free and may be stale. Redis
        // reservations are intentionally not refunded when another process
        // wins these rows: missed permits expire naturally and never become a
        // later burst.
        const lockedRows = await tx.select({ id: campaignJobsTable.id })
          .from(campaignJobsTable)
          .where(and(
            inArray(campaignJobsTable.id, reservedCandidates.map((candidate) => candidate.id)),
            eq(campaignJobsTable.organizationId, seed.organizationId),
            eq(campaignJobsTable.campaignId, seed.campaignId),
            eq(campaignJobsTable.routeId, seed.routeId),
            eq(campaignJobsTable.status, "Queued"),
          ))
          .orderBy(asc(campaignJobsTable.availableAt), asc(campaignJobsTable.id))
          .limit(reservedCandidates.length)
          .for("update", { skipLocked: true });
        const lockedIds = new Set(lockedRows.map(({ id }: { id: number }) => id));
        const claimCandidates = reservedCandidates.filter((candidate) => lockedIds.has(candidate.id));
        if (!claimCandidates.length) return [];
        const claimInput = claimCandidates.map((candidate) => {
          const reservationIndex = reservedCandidates.findIndex(({ id }) => id === candidate.id);
          return {
          id: candidate.id,
          organizationId: candidate.organizationId,
          campaignId: candidate.campaignId,
          routeId: seed.routeId!,
          leaseToken: randomUUID(),
          scheduledSendAt: new Date(pacing.slots[reservationIndex]!).toISOString(),
        };
        });
        const updated = await tx.execute<{ id: number }>(sql`
          with input as (
            select *
            from jsonb_to_recordset(${JSON.stringify(claimInput)}::jsonb) as item(
              id int,
              "organizationId" int,
              "campaignId" int,
              "routeId" int,
              "leaseToken" text,
              "scheduledSendAt" timestamptz
            )
          )
          update campaign_jobs as job
          set status = 'Processing',
              locked_at = statement_timestamp(),
              locked_by = ${workerId},
              lease_token = input."leaseToken",
              lease_expires_at = statement_timestamp() + ${leaseMs} * interval '1 millisecond',
              scheduled_send_at = input."scheduledSendAt",
              attempts = job.attempts + 1,
              updated_at = statement_timestamp()
          from input
          where job.id = input.id
            and job.organization_id = input."organizationId"
            and job.campaign_id = input."campaignId"
            and job.route_id = input."routeId"
            and job.status = 'Queued'
          returning job.id
        `);
        const updatedIds = updated.rows.map(({ id }) => id);
        // lockedRows are held through this transaction, so every selected job
        // should update. Throwing rolls back both slots and hard-window counts
        // rather than leaking capacity if that invariant is ever violated.
        if (updatedIds.length !== claimInput.length) throw new Error("Locked campaign jobs changed during claim");
        const jobs = await tx.select().from(campaignJobsTable).where(and(
          inArray(campaignJobsTable.id, updatedIds),
          eq(campaignJobsTable.organizationId, seed.organizationId),
          eq(campaignJobsTable.campaignId, seed.campaignId),
          eq(campaignJobsTable.routeId, seed.routeId),
        ));
        const configuredJobs = jobs.map((job) => ({
          ...job,
          configuredTps: job.configuredTps ?? effectiveConfiguredTps,
          dispatchPhoneNumberId: seed.phoneNumberId,
        }));
        if (!jobs.length) return [];
        await tx.insert(campaignMetricDeltasTable).values({
          organizationId: seed.organizationId,
          campaignId: seed.campaignId,
          queuedDelta: -jobs.length,
          processingDelta: jobs.length,
        });
        return configuredJobs;
        }));
      } finally {
        claimingRouteIds?.delete(seed.routeId);
      }
      if (claimed.length) return claimed;
    }
    return [];
  }
}

function leaseWhere(job: CampaignJob) {
  if (!job.leaseToken) throw new Error("Claimed job has no lease token");
  return and(
    eq(campaignJobsTable.id, job.id),
    eq(campaignJobsTable.status, "Processing"),
    eq(campaignJobsTable.leaseToken, job.leaseToken),
  );
}

async function campaignStatus(job: CampaignJob): Promise<{ status: string; killSwitch: boolean; routeActive: boolean } | undefined> {
  if (!job.routeId) return undefined;
  const [state] = await db.select({
    status: campaignsTable.status,
    killSwitch: campaignsTable.killSwitch,
    routeStatus: campaignRoutesTable.status,
  }).from(campaignsTable).leftJoin(campaignRoutesTable, and(
    eq(campaignRoutesTable.id, job.routeId),
    eq(campaignRoutesTable.organizationId, job.organizationId),
    eq(campaignRoutesTable.campaignId, job.campaignId),
  )).where(and(eq(campaignsTable.id, job.campaignId), eq(campaignsTable.organizationId, job.organizationId)));
  return state ? { status: state.status, killSwitch: state.killSwitch, routeActive: state.routeStatus === "Active" } : undefined;
}

async function dispatchStillAllowed(job: CampaignJob): Promise<boolean> {
  if (!job.routeId || !job.leaseToken) return false;
  const [state] = await db.select({ id: campaignJobsTable.id })
    .from(campaignJobsTable)
    .innerJoin(campaignsTable, and(
      eq(campaignsTable.id, campaignJobsTable.campaignId),
      eq(campaignsTable.organizationId, campaignJobsTable.organizationId),
    ))
    .innerJoin(campaignRoutesTable, and(
      eq(campaignRoutesTable.id, campaignJobsTable.routeId),
      eq(campaignRoutesTable.organizationId, campaignJobsTable.organizationId),
      eq(campaignRoutesTable.campaignId, campaignJobsTable.campaignId),
    ))
    .where(and(
      eq(campaignJobsTable.id, job.id),
      eq(campaignJobsTable.organizationId, job.organizationId),
      eq(campaignJobsTable.status, "Processing"),
      eq(campaignJobsTable.leaseToken, job.leaseToken),
      eq(campaignsTable.status, "Running"),
      eq(campaignsTable.killSwitch, false),
      eq(campaignRoutesTable.status, "Active"),
    ));
  return Boolean(state);
}

async function settleAborted(job: CampaignJob, now: Date): Promise<void> {
  await settlementDb.transaction(async (tx) => {
    // Keep every queue mutation in parent-to-child order. In particular, do
    // not let an aborted send hold its job row while another worker is claiming
    // (campaign -> route -> phone -> job -> metrics).
    const [campaign] = await tx.select({
      status: campaignsTable.status,
      killSwitch: campaignsTable.killSwitch,
    }).from(campaignsTable).where(and(
      eq(campaignsTable.id, job.campaignId),
      eq(campaignsTable.organizationId, job.organizationId),
    )).for("update");
    if (!campaign) return;
    if (job.routeId) {
      // Phone row isn't read or written here either -- dropped for the
      // same reason as the completion transactions above.
      await tx.select({
        phoneNumberId: campaignRoutesTable.phoneNumberId,
      }).from(campaignRoutesTable).where(and(
        eq(campaignRoutesTable.id, job.routeId),
        eq(campaignRoutesTable.organizationId, job.organizationId),
        eq(campaignRoutesTable.campaignId, job.campaignId),
      )).for("update");
    }
    const requeue = !campaign.killSwitch && (campaign.status === "Running" || campaign.status === "Paused");
    const [updated] = await tx.update(campaignJobsTable).set(requeue ? {
      status: "Queued", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
      availableAt: new Date(now.getTime() + 250),
    } : {
      status: "Cancelled", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
      errorReason: campaign.killSwitch ? "Emergency kill" : "Campaign cancelled",
    }).where(leaseWhere(job)).returning();
    if (!updated) return;
    await tx.update(campaignMetricsTable).set({
      processing: sql`greatest(0, ${campaignMetricsTable.processing} - 1)`,
      ...(requeue ? { queued: sql`${campaignMetricsTable.queued} + 1` } : {}),
    }).where(eq(campaignMetricsTable.campaignId, job.campaignId));
    if (!requeue && job.routeId) await tx.update(campaignRoutesTable)
      .set({ queueDepth: sql`greatest(0, ${campaignRoutesTable.queueDepth} - 1)` })
      .where(eq(campaignRoutesTable.id, job.routeId));
  });
}

async function completeIfDrained(campaignId: number, now: Date): Promise<void> {
  // Settlement calls this for every campaign it touched, not for campaigns it
  // proved drained, so on a busy campaign it ran an unbounded delta-flush loop
  // plus a second locking transaction after every batch. Gate that on a cheap
  // necessary condition first: completion requires queued == 0 AND
  // processing == 0, so a single non-terminal job proves the campaign cannot
  // complete right now. The probe is an index-only scan of
  // (campaign_id, status) that stops at the first row.
  //
  // Safety: this can only SKIP work -- it never completes a campaign and never
  // relaxes the predicate. The transaction below is untouched and remains the
  // sole authority on completion, re-reading the folded metrics under
  // campaigns + campaign_metrics locks. A drainable campaign cannot be lost
  // either: whatever terminalises its last non-terminal job calls this
  // function again, and by then the probe finds nothing outstanding. A job
  // appearing between the probe and the lock is likewise safe, because the
  // locked check sees queued/processing > 0 and declines to complete.
  const [outstanding] = await settlementDb.select({ id: campaignJobsTable.id })
    .from(campaignJobsTable)
    .where(and(
      eq(campaignJobsTable.campaignId, campaignId),
      inArray(campaignJobsTable.status, ["Queued", "Processing"]),
    ))
    .limit(1);
  if (outstanding) return;
  await flushAllCampaignMetricDeltas(campaignId);
  await settlementDb.transaction(async (tx) => {
    const [campaign] = await tx.select({ id: campaignsTable.id }).from(campaignsTable)
      .where(eq(campaignsTable.id, campaignId)).for("update");
    if (!campaign) return;
    const [metrics] = await tx.select({
      valid: campaignMetricsTable.valid,
      queued: campaignMetricsTable.queued,
      processing: campaignMetricsTable.processing,
      sent: campaignMetricsTable.sent,
      failed: campaignMetricsTable.failed,
    }).from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaignId)).for("update");
    const terminal = (metrics?.sent ?? 0) + (metrics?.failed ?? 0);
    if (!metrics || metrics.valid <= 0 || metrics.queued !== 0 || metrics.processing !== 0 || terminal < metrics.valid) return;
    await tx.update(campaignMetricsTable).set({
      queued: 0,
      processing: 0,
    }).where(eq(campaignMetricsTable.campaignId, campaignId));
    const [updated] = await tx.update(campaignsTable).set({ status: "Completed", completedAt: now })
      .where(and(eq(campaignsTable.id, campaignId), eq(campaignsTable.status, "Running"))).returning();
    if (updated) await tx.insert(campaignAuditTable).values({
      organizationId: updated.organizationId, campaignId, action: "completed",
      fromStatus: "Running", toStatus: "Completed", metadata: { reason: "Queue drained" },
    });
  });
}

async function settleSent(
  job: CampaignJob,
  payload: Record<string, unknown>,
  providerMessageId: string,
): Promise<{ sent: boolean; maybeDrained: boolean }> {
  return retryTransaction(async () => {
    const aggregateResult = await settlementDb.execute<{
      valid: number;
      queued: number;
      processing: number;
      sent: number;
      failed: number;
    }>(sql`
      with updated_job as (
        update campaign_jobs
        set status = 'Sent',
            locked_at = null,
            locked_by = null,
            lease_token = null,
            lease_expires_at = null,
            payload = ${JSON.stringify({ ...payload, providerMessageId })}::jsonb,
            updated_at = statement_timestamp()
        where id = ${job.id}
          and status = 'Processing'
          and lease_token = ${job.leaseToken!}
        returning id
      ),
      updated_route as (
        update campaign_routes
        set queue_depth = greatest(0, queue_depth - 1)
        where id = ${job.routeId!}
          and organization_id = ${job.organizationId}
          and campaign_id = ${job.campaignId}
          and exists (select 1 from updated_job)
        returning id
      ),
      updated_metrics as (
        update campaign_metrics
        set processing = greatest(0, processing - 1),
            sent = sent + 1,
            updated_at = statement_timestamp()
        where campaign_id = ${job.campaignId}
          and organization_id = ${job.organizationId}
          and exists (select 1 from updated_route)
        returning valid, queued, processing, sent, failed
      ),
      updated_campaign as (
        update campaigns
        set sent = sent + 1,
            updated_at = statement_timestamp()
        where id = ${job.campaignId}
          and organization_id = ${job.organizationId}
          and exists (select 1 from updated_metrics)
        returning id
      )
      select valid, queued, processing, sent, failed
      from updated_metrics
      where exists (select 1 from updated_campaign)
    `);
    const metrics = aggregateResult.rows[0];
    if (!metrics) {
      const [current] = await settlementDb.select({ status: campaignJobsTable.status })
        .from(campaignJobsTable)
        .where(and(
          eq(campaignJobsTable.id, job.id),
          eq(campaignJobsTable.organizationId, job.organizationId),
        ));
      return { sent: current?.status === "Sent", maybeDrained: false };
    }
    const terminal = metrics.sent + metrics.failed;
    return {
      sent: true,
      maybeDrained: metrics.valid > 0
        && metrics.queued === 0
        && metrics.processing === 0
        && terminal >= metrics.valid,
    };
  });
}

type SuccessfulSend = {
  job: CampaignJob;
  resolvedJob: CampaignJob;
  providerMessageId: string;
};

type RouteLockKey = { organizationId: number; campaignId: number; routeId: number };
type RouteQueueDecrement = RouteLockKey & { count: number };
type SettlementExecutor = { execute: (typeof settlementDb)["execute"] };

function byRouteLockOrder(a: RouteLockKey, b: RouteLockKey): number {
  return a.organizationId - b.organizationId || a.campaignId - b.campaignId || a.routeId - b.routeId;
}

/**
 * Locks every listed route row in ONE statement. The rows are the exact set
 * the former per-route `select … for update` loop locked (a missing row is
 * simply absent, as before), and `order by` makes PostgreSQL's LockRows node
 * take them in the same (organization, campaign, route) order the loop used,
 * so lock ordering against claims and other settlements is unchanged. Each
 * avoided statement was a full client round trip on a saturated runtime.
 */
export async function lockCampaignRoutes(executor: SettlementExecutor, locks: readonly RouteLockKey[]): Promise<number[]> {
  if (!locks.length) return [];
  const keys = [...locks].sort(byRouteLockOrder);
  const result = await executor.execute<{ id: number }>(sql`
    select route.id
    from campaign_routes as route
    where (route.organization_id, route.campaign_id, route.id) in (${sql.join(
      keys.map((key) => sql`(${key.organizationId}, ${key.campaignId}, ${key.routeId})`),
      sql`, `,
    )})
    order by route.organization_id, route.campaign_id, route.id
    for update
  `);
  return result.rows.map((row) => row.id);
}

/**
 * Applies every route's queue-depth decrement in ONE set-based statement.
 * Effect is identical to the former per-route updates: each listed route is
 * decremented once by its own count, floored at zero. Callers hold the route
 * locks from lockCampaignRoutes, so statement-internal row order is moot.
 */
export async function decrementRouteQueueDepths(
  executor: SettlementExecutor,
  decrements: readonly RouteQueueDecrement[],
): Promise<number> {
  if (!decrements.length) return 0;
  const input = [...decrements].sort(byRouteLockOrder).map((entry) => ({
    organizationId: entry.organizationId,
    campaignId: entry.campaignId,
    routeId: entry.routeId,
    count: entry.count,
  }));
  const result = await executor.execute(sql`
    update campaign_routes as route
    set queue_depth = greatest(0, route.queue_depth - input.count)
    from jsonb_to_recordset(${JSON.stringify(input)}::jsonb) as input(
      "organizationId" int,
      "campaignId" int,
      "routeId" int,
      count int
    )
    where route.id = input."routeId"
      and route.organization_id = input."organizationId"
      and route.campaign_id = input."campaignId"
  `);
  return result.rowCount ?? 0;
}

async function settleSentBatch(sends: SuccessfulSend[]): Promise<Set<number>> {
  if (!sends.length) return new Set();
  return retryTransaction(() => settlementDb.transaction(async (tx) => {
    const campaignLocks = [...new Set(sends.map(({ job }) => `${job.organizationId}:${job.campaignId}`))]
      .map((key) => {
        const [organizationId, campaignId] = key.split(":").map(Number);
        return { organizationId, campaignId };
      })
      .sort((a, b) => a.organizationId - b.organizationId || a.campaignId - b.campaignId);
    for (const lock of campaignLocks) {
      await tx.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
        eq(campaignsTable.id, lock.campaignId),
        eq(campaignsTable.organizationId, lock.organizationId),
      )).for("update");
    }
    const routeLocks = [...new Set(sends.flatMap(({ job }) =>
      job.routeId ? [`${job.organizationId}:${job.campaignId}:${job.routeId}`] : []))]
      .map((key) => {
        const [organizationId, campaignId, routeId] = key.split(":").map(Number);
        return { organizationId: organizationId!, campaignId: campaignId!, routeId: routeId! };
      })
      .sort(byRouteLockOrder);
    await lockCampaignRoutes(tx, routeLocks);

    const input = sends.map(({ job, resolvedJob, providerMessageId }) => ({
      id: job.id,
      organizationId: job.organizationId,
      campaignId: job.campaignId,
      routeId: job.routeId,
      leaseToken: job.leaseToken,
      payload: { ...(resolvedJob.payload as Record<string, unknown>), providerMessageId },
    }));
    const updated = await tx.execute<{
      id: number;
      organization_id: number;
      campaign_id: number;
      route_id: number | null;
    }>(sql`
      with input as (
        select *
        from jsonb_to_recordset(${JSON.stringify(input)}::jsonb) as item(
          id int,
          "organizationId" int,
          "campaignId" int,
          "routeId" int,
          "leaseToken" text,
          payload jsonb
        )
      )
      update campaign_jobs as job
      set status = 'Sent',
          locked_at = null,
          locked_by = null,
          lease_token = null,
          lease_expires_at = null,
          payload = input.payload,
          updated_at = statement_timestamp()
      from input
      where job.id = input.id
        and job.organization_id = input."organizationId"
        and job.campaign_id = input."campaignId"
        and job.route_id = input."routeId"
        and job.status = 'Processing'
        and job.lease_token = input."leaseToken"
      returning job.id, job.organization_id, job.campaign_id, job.route_id
    `);
    const routeCounts = new Map<string, { organizationId: number; campaignId: number; routeId: number; count: number }>();
    const campaignCounts = new Map<string, { organizationId: number; campaignId: number; count: number }>();
    for (const row of updated.rows) {
      if (row.route_id !== null) {
        const routeKey = `${row.organization_id}:${row.campaign_id}:${row.route_id}`;
        const route = routeCounts.get(routeKey) ?? {
          organizationId: row.organization_id,
          campaignId: row.campaign_id,
          routeId: row.route_id,
          count: 0,
        };
        route.count += 1;
        routeCounts.set(routeKey, route);
      }
      const campaignKey = `${row.organization_id}:${row.campaign_id}`;
      const campaign = campaignCounts.get(campaignKey) ?? {
        organizationId: row.organization_id,
        campaignId: row.campaign_id,
        count: 0,
      };
      campaign.count += 1;
      campaignCounts.set(campaignKey, campaign);
    }
    await decrementRouteQueueDepths(tx, [...routeCounts.values()]);
    const affectedCampaigns = new Set<number>();
    for (const campaign of campaignCounts.values()) {
      await tx.insert(campaignMetricDeltasTable).values({
        organizationId: campaign.organizationId,
        campaignId: campaign.campaignId,
        processingDelta: -campaign.count,
        sentDelta: campaign.count,
      });
      affectedCampaigns.add(campaign.campaignId);
    }
    return affectedCampaigns;
  }));
}

type FailedSend = {
  job: CampaignJob;
  error: unknown;
  /**
   * The clock a batched failure was observed on. Retry backoff is computed
   * from the moment the provider failed, not from whenever the settlement
   * batch happens to run, so coalescing failures never delays or advances a
   * job's next attempt. Defaults to the batch's own `now`.
   */
  at?: Date;
};

type FailedSettlementTask = {
  campaignId: number;
  job: CampaignJob;
  error: unknown;
  now: Date;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type FailedSettlement = {
  updated: boolean;
  exhausted: boolean;
};

type SuccessfulSettlementTask = {
  campaignId: number;
  successful: SuccessfulSend[];
  now: Date;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Settle provider failures in one transaction per batch. The old batch path
 * settled each failed provider call independently, so a 5% retry rate turned
 * every batch into several campaign/route lock transactions that raced the
 * grouped success settlement. The input still carries one lease token and
 * backoff decision per job, so retries remain individually fenced and timed.
 */
async function settleFailedBatch(
  failures: FailedSend[],
  now: Date,
): Promise<{ updated: number; exhausted: number; campaigns: Set<number> }> {
  if (!failures.length) return { updated: 0, exhausted: 0, campaigns: new Set() };
  const result = await retryTransaction(() => settlementDb.transaction(async (tx) => {
    const campaignLocks = [...new Set(failures.map(({ job }) => `${job.organizationId}:${job.campaignId}`))]
      .map((key) => {
        const [organizationId, campaignId] = key.split(":").map(Number);
        return { organizationId, campaignId };
      })
      .sort((a, b) => a.organizationId - b.organizationId || a.campaignId - b.campaignId);
    for (const lock of campaignLocks) {
      await tx.select({ id: campaignsTable.id }).from(campaignsTable).where(and(
        eq(campaignsTable.id, lock.campaignId),
        eq(campaignsTable.organizationId, lock.organizationId),
      )).for("update");
    }
    const routeLocks = [...new Set(failures.flatMap(({ job }) =>
      job.routeId ? [`${job.organizationId}:${job.campaignId}:${job.routeId}`] : []))]
      .map((key) => {
        const [organizationId, campaignId, routeId] = key.split(":").map(Number);
        return { organizationId, campaignId, routeId };
      })
      .sort((a, b) => a.organizationId - b.organizationId
        || a.campaignId - b.campaignId
        || a.routeId - b.routeId);
    for (const lock of routeLocks) {
      await tx.select({ id: campaignRoutesTable.id }).from(campaignRoutesTable).where(and(
        eq(campaignRoutesTable.id, lock.routeId),
        eq(campaignRoutesTable.organizationId, lock.organizationId),
        eq(campaignRoutesTable.campaignId, lock.campaignId),
      )).for("update");
    }

    const input = failures.map(({ job, error, at }) => {
      const exhausted = !isRetryableProviderError(error) || job.attempts >= job.maxAttempts;
      const observedAt = at ?? now;
      return {
        id: job.id,
        organizationId: job.organizationId,
        campaignId: job.campaignId,
        routeId: job.routeId,
        leaseToken: job.leaseToken,
        exhausted,
        message: error instanceof Error ? error.message : "Provider send failed",
        availableAt: (exhausted ? observedAt : retryAt(job.attempts, observedAt)).toISOString(),
      };
    });
    const updated = await tx.execute<{
      id: number;
      organization_id: number;
      campaign_id: number;
      route_id: number | null;
      exhausted: boolean;
    }>(sql`
      with input as (
        select *
        from jsonb_to_recordset(${JSON.stringify(input)}::jsonb) as item(
          id int,
          "organizationId" int,
          "campaignId" int,
          "routeId" int,
          "leaseToken" text,
          exhausted boolean,
          message text,
          "availableAt" timestamptz
        )
      )
      update campaign_jobs as job
      set status = case when input.exhausted then 'Failed' else 'Queued' end,
          error_reason = input.message,
          locked_at = null,
          locked_by = null,
          lease_token = null,
          lease_expires_at = null,
          available_at = input."availableAt",
          updated_at = statement_timestamp()
      from input
      where job.id = input.id
        and job.organization_id = input."organizationId"
        and job.campaign_id = input."campaignId"
        and job.route_id = input."routeId"
        and job.status = 'Processing'
        and job.lease_token = input."leaseToken"
      returning job.id, job.organization_id, job.campaign_id, job.route_id, input.exhausted
    `);
    const routeCounts = new Map<string, { organizationId: number; campaignId: number; routeId: number; count: number }>();
    const campaignCounts = new Map<string, {
      organizationId: number;
      campaignId: number;
      retryCount: number;
      failedCount: number;
    }>();
    const campaigns = new Set<number>();
    for (const row of updated.rows) {
      campaigns.add(row.campaign_id);
      const campaignKey = `${row.organization_id}:${row.campaign_id}`;
      const campaign = campaignCounts.get(campaignKey) ?? {
        organizationId: row.organization_id,
        campaignId: row.campaign_id,
        retryCount: 0,
        failedCount: 0,
      };
      if (row.exhausted) {
        campaign.failedCount += 1;
        if (row.route_id !== null) {
          const routeKey = `${row.organization_id}:${row.campaign_id}:${row.route_id}`;
          const route = routeCounts.get(routeKey) ?? {
            organizationId: row.organization_id,
            campaignId: row.campaign_id,
            routeId: row.route_id,
            count: 0,
          };
          route.count += 1;
          routeCounts.set(routeKey, route);
        }
      } else {
        campaign.retryCount += 1;
      }
      campaignCounts.set(campaignKey, campaign);
    }
    for (const route of routeCounts.values()) {
      await tx.update(campaignRoutesTable).set({
        queueDepth: sql`greatest(0, ${campaignRoutesTable.queueDepth} - ${route.count})`,
      }).where(and(
        eq(campaignRoutesTable.id, route.routeId),
        eq(campaignRoutesTable.organizationId, route.organizationId),
        eq(campaignRoutesTable.campaignId, route.campaignId),
      ));
    }
    for (const campaign of campaignCounts.values()) {
      await tx.insert(campaignMetricDeltasTable).values({
        organizationId: campaign.organizationId,
        campaignId: campaign.campaignId,
        processingDelta: -(campaign.retryCount + campaign.failedCount),
        queuedDelta: campaign.retryCount,
        retryDelta: campaign.retryCount,
        failedDelta: campaign.failedCount,
      });
    }
    return {
      updated: updated.rows.length,
      exhausted: updated.rows.filter((row) => row.exhausted).length,
      campaigns,
    };
  }));
  for (const campaignId of result.campaigns) {
    await flushAllCampaignMetricDeltas(campaignId);
  }
  return result;
}

async function settleFailed(
  job: CampaignJob,
  now: Date,
  error: unknown,
): Promise<FailedSettlement> {
  const result = await settleFailedBatch([{ job, error }], now);
  return {
    updated: result.updated > 0,
    exhausted: result.exhausted > 0,
  };
}

// How many jobs from the SAME route this single process's lanes may have
// claimed-but-not-yet-settled at once. CONCURRENT_SEND_LANES is sized for
// spreading across many distinct numbers, not for piling onto one; without
// this cap, whenever lanes outnumber active routes (the common case for a
// small or newly-ramping number pool) every lane converges on the same
// campaign/route/phone rows that the completion transaction locks, and
// they serialize behind each other instead of making progress -- starving
// exactly the high-TPS numbers that need the most throughput. This never
// caps cross-process/global throughput: the real ceiling stays the atomic
// Redis pacing-coordinator reservation made before the claim transaction.
//
// The allowance scales with the route's own configured TPS rather than
// being flat: a shared DB/connection ceiling means several routes racing
// for candidates split it roughly evenly per-route when each gets the same
// slot count, which silently disadvantages a high-TPS number sharing a
// runtime with lower-TPS ones even though nothing is over-sending. Scaling
// the slot count with configuredTps gives a high-TPS route proportionally
// more of that shared ceiling, matching what it's actually configured to
// need.
function maxInFlightForRoute(configuredTps: number): number {
  // Batch settlement releases all jobs together after the final scheduled
  // send in that batch. Two seconds of headroom can therefore sawtooth to an
  // empty dispatch queue while a large settlement is still committing at
  // 750–1000 TPS. Three seconds keeps one resolved second ready without
  // changing the one-second schedule horizon or provider hard window.
  return Math.min(4_096, Math.max(32, Math.ceil(configuredTps * 3)));
}

export class CampaignWorker {
  // Provider transport is released before these durable outcome writes. Keep
  // a bounded but sufficiently deep queue so one hot campaign can coalesce
  // completions into set-based settlement transactions without retaining an
  // unbounded list of detached waiters when the database is slow.
  private static readonly MAX_PENDING_SUCCESS_SETTLEMENTS = 4_096;
  private static readonly SUCCESS_SETTLEMENT_WORKERS = 4;
  private static readonly SUCCESS_SETTLEMENT_BATCH_SIZE = 1_024;
  // Provider failures from the reservoir path settle through the same
  // batched, per-campaign-serialized pipeline as successes. Settling each
  // failure in its own transaction took the campaigns row once per retry --
  // at a 5% retry rate that queued ~200 small lock cycles per second ahead of
  // every 1,024-job success batch, and the batch spent ~90% of its time
  // waiting for the row instead of writing. A failure holds the settlement
  // slot the reservoir already reserved until its outcome is durable, so this
  // queue is bounded by the same 4,096-slot cap and drained by waitForIdle().
  private static readonly FAILURE_SETTLEMENT_BATCH_SIZE = 256;
  private readonly routeInFlight = new Map<number, number>();
  private readonly activeBatches = new Set<Promise<void>>();
  private readonly claimingRouteIds = new Set<number>();
  private readonly campaignSettlementTails = new Map<number, Promise<void>>();
  private readonly successSettlementQueue: SuccessfulSettlementTask[] = [];
  private readonly activeSuccessSettlementCampaigns = new Set<number>();
  private successSettlementsPending = 0;
  private activeSuccessSettlementWorkers = 0;
  private successSettlementPumpScheduled = false;
  private readonly failureSettlementQueue: FailedSettlementTask[] = [];
  private readonly activeFailureSettlementCampaigns = new Set<number>();
  private activeFailureSettlementWorkers = 0;
  private failureSettlementPumpScheduled = false;
  private readonly dispatchScheduler = new PhoneDispatchScheduler();
  private readonly transportShards = new CampaignTransportShards();
  private readonly dispatchFenceByRoute = new Map<number, {
    refreshAt: number;
    validUntil: number;
    allowed?: boolean;
    refresh?: Promise<boolean>;
  }>();
  /**
   * Concurrent runtime lanes may claim different routes in parallel, but
   * claimingRouteIds permits only one local claim transaction per route at a
   * time. This avoids self-inflicted SKIP LOCKED misses on a hot route without
   * turning one multi-route campaign into a global in-process mutex. Provider
   * sends and completion transactions overlap after a lane has claimed a job;
   * The pacing coordinator remains the global cross-process TPS ceiling.
   */
  constructor(
    private readonly queue: DatabaseJobQueue,
    private readonly sender: ProviderSender,
    private readonly limiter: RouteTpsLimiter,
    private readonly workerId: string,
    private readonly leaseMs = 30_000,
    private readonly observer?: CampaignWorkerObserver,
  ) {}

  get brokerLeaseRenewalIntervalMs(): number {
    return Math.max(250, Math.floor(this.leaseMs / 3));
  }

  /**
   * Settlement capacity is taken by the reservoir *before* an envelope leaves
   * its lane queue, so a saturated settlement plane stops work entering
   * transport instead of aborting work that is already claimed, prepared and
   * leased. Aborting at the dispatch boundary took `campaigns FOR UPDATE` --
   * the exact row settlement must hold to commit and release capacity -- so
   * the backpressure blocked its own recovery and saturation became collapse.
   */
  tryReserveSettlementSlot(): boolean {
    return this.reserveSuccessfulSettlementSlot();
  }

  /** Total durable-outcome capacity the reservoir partitions across its lanes. */
  settlementSlotCapacity(): number {
    return CampaignWorker.MAX_PENDING_SUCCESS_SETTLEMENTS;
  }

  releaseSettlementSlot(): void {
    this.releaseSuccessfulSettlementSlot();
  }

  async renewBrokerLeases(
    envelopes: ReadonlyArray<BrokerPreparedCampaignEnvelope>,
  ): Promise<number> {
    return this.queue.renewBrokerLeases(
      envelopes.flatMap(({ job }) => job.leaseToken ? [{
        jobId: job.id,
        organizationId: job.organizationId,
        campaignId: job.campaignId,
        leaseToken: job.leaseToken,
      }] : []),
      this.leaseMs,
    );
  }

  private async claimNext(now: Date): Promise<CampaignJob | undefined> {
    const job = await this.queue.claim(
      this.limiter,
      this.workerId,
      this.leaseMs,
      now,
      this.routeInFlight,
      maxInFlightForRoute,
      this.claimingRouteIds,
    );
    if (job?.routeId) {
      this.routeInFlight.set(job.routeId, (this.routeInFlight.get(job.routeId) ?? 0) + 1);
    }
    return job;
  }

  private async claimNextBatch(now: Date, batchSize: number): Promise<CampaignJob[]> {
    const jobs = await this.queue.claimBatch(
      this.limiter,
      this.workerId,
      this.leaseMs,
      batchSize,
      now,
      this.routeInFlight,
      maxInFlightForRoute,
      this.claimingRouteIds,
    );
    for (const job of jobs) {
      if (!job.routeId) continue;
      this.routeInFlight.set(job.routeId, (this.routeInFlight.get(job.routeId) ?? 0) + 1);
    }
    return jobs;
  }

  /**
   * Reservoir-only claim entry point. Capacity is reserved by the owning phone
   * lane before this method is called; the exact phone predicate prevents a
   * hot sibling route from consuming that reservation.
   */
  async claimPhoneBatch(phoneNumberId: number, batchSize: number, now = new Date()): Promise<CampaignJob[]> {
    const started = performance.now();
    const jobs = await this.queue.claimBatch(
      this.limiter, this.workerId, this.leaseMs, batchSize, now,
      this.routeInFlight, maxInFlightForRoute, this.claimingRouteIds, phoneNumberId,
    );
    for (const job of jobs) {
      if (job.routeId) this.routeInFlight.set(job.routeId, (this.routeInFlight.get(job.routeId) ?? 0) + 1);
    }
    campaignDispatchMetrics.supplyClaim(jobs.length, performance.now() - started);
    return jobs;
  }

  /**
   * How long until this phone's earliest not-yet-due queued job becomes
   * claimable, or undefined when it has no future work at all.
   *
   * claimPhoneBatch only ever returns rows whose availableAt has arrived, and
   * pacing deliberately stamps that time forward, so "nothing came back" does
   * not mean "this phone is idle" -- it usually means the next slice of its
   * own paced backlog is a few hundred milliseconds away. The supply
   * scheduler asks this before parking a lane so it can wake exactly when
   * work exists instead of guessing. Reads availableAt, never writes it:
   * pacing still decides when a job may be sent.
   *
   * The interval is computed by PostgreSQL against its own clock so an app
   * clock that drifts from the database cannot park a lane past its work.
   */
  async nextPhoneSupplyDueInMs(phoneNumberId: number): Promise<number | undefined> {
    const [next] = await db.select({
      dueInMs: sql<number>`ceil(extract(epoch from (${campaignJobsTable.availableAt} - now())) * 1000)`.as("due_in_ms"),
    }).from(campaignJobsTable)
      .innerJoin(campaignRoutesTable, and(
        eq(campaignRoutesTable.id, campaignJobsTable.routeId),
        eq(campaignRoutesTable.organizationId, campaignJobsTable.organizationId),
      ))
      .where(and(
        eq(campaignRoutesTable.phoneNumberId, phoneNumberId),
        eq(campaignJobsTable.status, "Queued"),
        gt(campaignJobsTable.availableAt, sql`now()`),
      ))
      // Served by campaign_job_route_queued_available_idx
      // (route_id, available_at, id) WHERE status = 'Queued'.
      .orderBy(asc(campaignJobsTable.availableAt))
      .limit(1);
    return next ? Math.max(0, Number(next.dueInMs)) : undefined;
  }

  /** Does all database/template/intent work before an envelope enters a lane. */
  async prepareReservoirBatch(jobs: CampaignJob[], now = new Date()): Promise<PreparedCampaignEnvelope[]> {
    if (!jobs.length) return [];
    const registrations = new Map<number, ReturnType<typeof inFlightRegistry.register>>();
    for (const job of jobs) registrations.set(job.id, inFlightRegistry.register(job.campaignId, job.id, job.leaseToken!));
    const release = (job: CampaignJob) => {
      const registration = registrations.get(job.id);
      if (registration) inFlightRegistry.release(registration.key);
      this.releaseRoute(job.routeId);
    };
    try {
      const resolutions = await resolveJobTemplates(jobs);
      const resolved = resolutions.flatMap(({ resolvedJob, error }) => resolvedJob && !error ? [resolvedJob] : []);
      let contexts = new Map<number, unknown>();
      let preparationError: unknown;
      const droppedIds = new Set<number>();
      try {
        if (resolved.length && this.sender.prepareBatch) {
          contexts = await this.sender.prepareBatch(resolved, registrations.get(jobs[0]!.id)?.signal);
        }
      } catch (error) {
        preparationError = error;
      }
      // Validation decisions for the whole batch in one round trip when the
      // sender offers it. This is the pre-publication re-check of envelopes the
      // sender has already prepared; per message, validatePrepared() cost one PostgreSQL
      // round trip awaited in series -- ~0.9 ms each, ~230 ms of a 256-job
      // batch -- and halved production supply. Only envelopes that would reach
      // the per-message check below are asked about; every downstream effect
      // of a rejection is unchanged. Senders without the batch hook keep the
      // per-message path exactly as it was.
      let batchRejected: ReadonlySet<number> | undefined;
      if (this.sender.validatePreparedBatch) {
        const candidates = resolutions.flatMap((item) => {
          const context = item.resolvedJob ? contexts.get(item.resolvedJob.id) : undefined;
          if (
            item.error || !item.resolvedJob || preparationError
            || context === undefined || context instanceof PreparedProviderFailure
          ) return [];
          return [{ jobId: item.job.id, preparedContext: context }];
        });
        batchRejected = candidates.length
          ? await this.sender.validatePreparedBatch(candidates)
          : new Set<number>();
      }
      const rejected: FailedSend[] = [];
      for (const item of resolutions) {
        const context = item.resolvedJob ? contexts.get(item.resolvedJob.id) : undefined;
        const contextFailure = context instanceof PreparedProviderFailure ? context.error : undefined;
        if (
          item.error || !item.resolvedJob || preparationError || contextFailure
          || (this.sender.prepareBatch !== undefined && context === undefined)
        ) {
          rejected.push({
            job: item.job,
            error: item.error ?? preparationError ?? contextFailure ?? new Error("Provider preparation returned no envelope"),
          });
          droppedIds.add(item.job.id);
          release(item.job);
          continue;
        }
        const registration = registrations.get(item.job.id)!;
        const recipient = this.sender.preparedRecipient?.(context);
        if (recipient) inFlightRegistry.bindRecipient(registration.key, recipient.organizationId, recipient.recipient);
        const revoked = context !== undefined && (
          batchRejected !== undefined
            ? batchRejected.has(item.job.id)
            : this.sender.validatePrepared !== undefined && !await this.sender.validatePrepared(context)
        );
        if (revoked) {
          await this.sender.revokePrepared?.(context, new Error("Prepared campaign envelope was revoked"));
          await settleAborted(item.job, now);
          droppedIds.add(item.job.id);
          release(item.job);
          continue;
        }
      }
      if (rejected.length) await settleFailedBatch(rejected, now);
      const rejectedIds = new Set(rejected.map(({ job }) => job.id));
      for (const id of droppedIds) rejectedIds.add(id);
      return resolutions.flatMap(({ job, resolvedJob, error }) => {
        if (error || !resolvedJob || rejectedIds.has(job.id)) return [];
        const context = contexts.get(resolvedJob.id);
        const registration = registrations.get(job.id);
        return !registration || (context === undefined && this.sender.prepareBatch !== undefined) ? [] : [{
          job: { ...resolvedJob, dispatchPhoneNumberId: (job as CampaignJobWithDispatchPhone).dispatchPhoneNumberId },
          preparedContext: context,
          registration,
        }];
      });
    } catch (error) {
      await settleFailedBatch(jobs.map((job) => ({ job, error })), now);
      for (const job of jobs) release(job);
      return [];
    }
  }

  handoffPreparedEnvelope(envelope: PreparedCampaignEnvelope): BrokerPreparedCampaignEnvelope {
    inFlightRegistry.release(envelope.registration.key);
    this.releaseRoute(envelope.job.routeId);
    return { job: envelope.job, preparedContext: envelope.preparedContext };
  }

  adoptPreparedEnvelope(envelope: BrokerPreparedCampaignEnvelope): PreparedCampaignEnvelope {
    if (!envelope.job.leaseToken) throw new Error("Broker envelope has no durable lease token");
    if (envelope.job.routeId) {
      this.routeInFlight.set(envelope.job.routeId, (this.routeInFlight.get(envelope.job.routeId) ?? 0) + 1);
    }
    return {
      ...envelope,
      registration: inFlightRegistry.register(
        envelope.job.campaignId,
        envelope.job.id,
        envelope.job.leaseToken,
      ),
    };
  }

  async validatePreparedBrokerEnvelopes(
    envelopes: BrokerPreparedCampaignEnvelope[],
  ): Promise<{ valid: BrokerPreparedCampaignEnvelope[]; stale: BrokerPreparedCampaignEnvelope[] }> {
    if (!envelopes.length) return { valid: [], stale: [] };
    const rows = await db.select({
      id: campaignJobsTable.id,
      leaseToken: campaignJobsTable.leaseToken,
      leaseExpiresAt: campaignJobsTable.leaseExpiresAt,
      organizationId: campaignJobsTable.organizationId,
      campaignId: campaignJobsTable.campaignId,
      routeId: campaignJobsTable.routeId,
    }).from(campaignJobsTable)
      .innerJoin(campaignsTable, and(
        eq(campaignsTable.id, campaignJobsTable.campaignId),
        eq(campaignsTable.organizationId, campaignJobsTable.organizationId),
      ))
      .innerJoin(campaignRoutesTable, and(
        eq(campaignRoutesTable.id, campaignJobsTable.routeId),
        eq(campaignRoutesTable.organizationId, campaignJobsTable.organizationId),
        eq(campaignRoutesTable.campaignId, campaignJobsTable.campaignId),
      ))
      .where(and(
        inArray(campaignJobsTable.id, envelopes.map((envelope) => envelope.job.id)),
        eq(campaignJobsTable.status, "Processing"),
        eq(campaignsTable.status, "Running"),
        eq(campaignsTable.killSwitch, false),
        eq(campaignRoutesTable.status, "Active"),
      ));
    const live = new Map(rows.map((row) => [row.id, row]));
    const now = Date.now();
    const valid: BrokerPreparedCampaignEnvelope[] = [];
    const stale: BrokerPreparedCampaignEnvelope[] = [];
    for (const envelope of envelopes) {
      const row = live.get(envelope.job.id);
      if (
        row
        && row.organizationId === envelope.job.organizationId
        && row.campaignId === envelope.job.campaignId
        && row.routeId === envelope.job.routeId
        && row.leaseToken === envelope.job.leaseToken
        && (row.leaseExpiresAt?.getTime() ?? 0) > now
      ) {
        // Broker payloads are immutable after publication. Use the current
        // database expiry so a renewed broker lease is not rejected using
        // the stale serialized timestamp.
        valid.push({
          ...envelope,
          job: { ...envelope.job, leaseExpiresAt: row.leaseExpiresAt },
        });
      }
      else stale.push(envelope);
    }
    return { valid, stale };
  }

  /**
   * Transport-only lane handoff. There is intentionally no DB call before the
   * dispatch acknowledgement and provider transport invocation.
   */
  async dispatchReservoirEnvelope(
    envelope: PreparedCampaignEnvelope,
    now = new Date(),
    /** Reserved upstream by the reservoir before the envelope left its lane. */
    settlementSlotReserved = false,
  ): Promise<void> {
    const { job, preparedContext, registration } = envelope;
    let released = false;
    const releaseTransportCapacity = () => {
      if (released) return;
      released = true;
      inFlightRegistry.release(registration.key);
      this.releaseRoute(job.routeId);
    };
    const detachSuccessfulSettlement = (
      providerOutcomePersistence: Promise<void>,
      providerMessageId: string,
      slotReserved: boolean,
    ) => {
      const task = (async () => {
        let queued = false;
        try {
          await providerOutcomePersistence;
          await this.enqueueSuccessfulSettlement({
            campaignId: job.campaignId,
            successful: [{ job, resolvedJob: job, providerMessageId }],
            now,
            slotReserved,
          });
          queued = true;
        } finally {
          if (slotReserved && !queued) this.releaseSuccessfulSettlementSlot();
        }
      })().catch((error) => {
        logger.error({
          error,
          campaignId: job.campaignId,
          jobId: job.id,
          leaseToken: job.leaseToken,
        }, "Detached provider outcome settlement failed; durable intent and exact lease remain for recovery");
      });
      this.activeBatches.add(task);
      void task.finally(() => this.activeBatches.delete(task));
    };
    let successSettlementSlotReserved = settlementSlotReserved;
    try {
      const phoneId = job.dispatchPhoneNumberId;
      if (!phoneId) throw new Error("Prepared envelope has no dispatch phone");
      const intervalMs = 1_000 / Math.max(1, job.configuredTps ?? 1);
      const options = { signal: registration.signal, idempotencyKey: job.idempotencyKey };
      if (registration.signal.aborted) {
        await this.sender.revokePrepared?.(preparedContext, registration.signal.reason);
        await settleAborted(job, now);
        return;
      }
      if (!successSettlementSlotReserved) {
        successSettlementSlotReserved = this.reserveSuccessfulSettlementSlot();
      }
      if (!successSettlementSlotReserved) {
        // Unreachable from the reservoir, which reserves before dequeue. A
        // caller that races the cap fails closed WITHOUT touching PostgreSQL:
        // the exact lease stays Processing and normal lease recovery replays
        // it. Deliberately no settleAborted here -- that takes the campaigns
        // row settlement needs to commit and release capacity, so using it as
        // backpressure prevents the very drain that would relieve the
        // pressure, turning saturation into congestion collapse.
        const backpressure = new ProviderRequestError("Campaign success settlement queue is full", true);
        await this.sender.revokePrepared?.(preparedContext, backpressure);
        campaignDispatchMetrics.settlementBackpressure();
        return;
      }
      let result: { providerMessageId: string };
      let providerOutcomeHandled = false;
      try {
        const transportPayload = this.sender.serializePreparedTransport?.(job, preparedContext);
        if (transportPayload) {
          const outcome = await this.transportShards.dispatch(
            phoneId,
            intervalMs,
            job.scheduledSendAt?.getTime() ?? Date.now(),
            transportPayload,
            registration.signal,
            (startedAt) => this.sender.observeShardTransportStart?.(job, startedAt),
          );
          this.sender.observeShardTransport?.(job, outcome);
          if (outcome.cancelledBeforeStart) {
            await this.sender.revokePrepared?.(preparedContext, outcome.error ?? new Error("Send aborted before provider start"));
            outcome.acknowledge();
            throw registration.signal.reason instanceof Error
              ? registration.signal.reason
              : outcome.error ?? new Error("Send aborted before provider start");
          }
          if (outcome.error) {
            await this.sender.settlePreparedTransport?.(job, preparedContext, { error: outcome.error });
            providerOutcomeHandled = true;
            outcome.acknowledge();
            throw outcome.error;
          }
          result = { providerMessageId: outcome.providerMessageId! };
          const providerOutcomePersistence =
            this.sender.settlePreparedTransport?.(job, preparedContext, result) ?? Promise.resolve();
          providerOutcomeHandled = true;
          outcome.acknowledge();
          releaseTransportCapacity();
          detachSuccessfulSettlement(providerOutcomePersistence, result.providerMessageId, successSettlementSlotReserved);
          successSettlementSlotReserved = false;
          return;
        } else if (this.sender.sendPreparedTransport && preparedContext !== undefined) {
          const permit = await this.dispatchScheduler.wait(phoneId, intervalMs, registration.signal, job.scheduledSendAt);
          permit.acknowledgeDispatch();
          campaignDispatchMetrics.transportStart();
          result = await this.sender.sendPreparedTransport(job, options, preparedContext);
        } else {
          const permit = await this.dispatchScheduler.wait(phoneId, intervalMs, registration.signal, job.scheduledSendAt);
          permit.acknowledgeDispatch();
          campaignDispatchMetrics.transportStart();
          result = await this.sender.send(job, options, preparedContext);
        }
        if (!transportPayload && preparedContext !== undefined) {
          const providerOutcomePersistence =
            this.sender.settlePreparedTransport?.(job, preparedContext, result) ?? Promise.resolve();
          providerOutcomeHandled = true;
          releaseTransportCapacity();
           detachSuccessfulSettlement(providerOutcomePersistence, result.providerMessageId, successSettlementSlotReserved);
           successSettlementSlotReserved = false;
          return;
        }
      } catch (error) {
        if (!providerOutcomeHandled && this.sender.settlePreparedTransport && preparedContext !== undefined) await this.sender.settlePreparedTransport(job, preparedContext, { error });
        throw error;
      }
      releaseTransportCapacity();
      detachSuccessfulSettlement(Promise.resolve(), result.providerMessageId, successSettlementSlotReserved);
      successSettlementSlotReserved = false;
    } catch (error) {
      if (registration.signal.aborted) {
        // STOP / kill-switch / lease loss: unchanged, settled immediately.
        await settleAborted(job, now);
      } else if (this.detachFailedSettlement(job, error, now, successSettlementSlotReserved)) {
        // Ownership of the reserved slot moved to the queued failure task; it
        // is released when that job's retry state is durable.
        successSettlementSlotReserved = false;
      } else {
        // The bounded queue could not take it: settle inline, exactly as
        // before, still holding the slot until the write commits.
        await this.settleFailuresNow([{ job, error, at: now }], now);
      }
    } finally {
      if (successSettlementSlotReserved) this.releaseSuccessfulSettlementSlot();
      releaseTransportCapacity();
    }
  }

  /**
   * Queue one provider failure for batched settlement. Returns false when the
   * queue cannot accept it (no settlement slot could be held for it), in
   * which case the caller must settle inline. Never drops a failure.
   */
  private detachFailedSettlement(
    job: CampaignJob,
    error: unknown,
    now: Date,
    slotReserved: boolean,
  ): boolean {
    if (!slotReserved && !this.reserveSuccessfulSettlementSlot()) return false;
    const task = new Promise<void>((resolve, reject) => {
      this.failureSettlementQueue.push({ campaignId: job.campaignId, job, error, now, resolve, reject });
    }).catch((settlementError) => {
      logger.error({
        error: settlementError,
        campaignId: job.campaignId,
        jobId: job.id,
        leaseToken: job.leaseToken,
      }, "Batched provider failure settlement failed; exact lease remains for recovery");
    });
    this.activeBatches.add(task);
    void task.finally(() => this.activeBatches.delete(task));
    this.scheduleFailedSettlementPump();
    return true;
  }

  /** One failure-settlement transaction under the campaign's serialization. */
  private settleFailuresNow(failures: FailedSend[], now: Date): Promise<void> {
    const started = performance.now();
    return this.withCampaignSettlement(failures[0]!.job.campaignId, async () => {
      const settled = await settleFailedBatch(failures, now);
      // A retry that exhausts its attempts can be the campaign's last open
      // job; completion is still decided by completeIfDrained's own
      // transactional check, exactly as on the batch-processing path.
      if (settled.exhausted > 0) {
        for (const campaignId of settled.campaigns) await completeIfDrained(campaignId, now);
      }
    }).then(() => {
      this.observer?.record("failure_settlement", performance.now() - started, failures.length);
    });
  }

  private scheduleFailedSettlementPump(): void {
    if (this.failureSettlementPumpScheduled) return;
    this.failureSettlementPumpScheduled = true;
    const handle = setImmediate(() => {
      this.failureSettlementPumpScheduled = false;
      this.pumpFailedSettlements();
    });
    handle.unref();
  }

  private pumpFailedSettlements(): void {
    while (
      this.activeFailureSettlementWorkers < CampaignWorker.SUCCESS_SETTLEMENT_WORKERS
      && this.failureSettlementQueue.length
    ) {
      const taskIndex = this.failureSettlementQueue.findIndex(
        (candidate) => !this.activeFailureSettlementCampaigns.has(candidate.campaignId),
      );
      if (taskIndex < 0) return;
      const [first] = this.failureSettlementQueue.splice(taskIndex, 1);
      const tasks = [first!];
      for (
        let index = 0;
        index < this.failureSettlementQueue.length
        && tasks.length < CampaignWorker.FAILURE_SETTLEMENT_BATCH_SIZE;
      ) {
        const candidate = this.failureSettlementQueue[index]!;
        if (candidate.campaignId !== first!.campaignId) {
          index += 1;
          continue;
        }
        tasks.push(candidate);
        this.failureSettlementQueue.splice(index, 1);
      }
      this.activeFailureSettlementCampaigns.add(first!.campaignId);
      this.activeFailureSettlementWorkers += 1;
      void this.runFailedSettlement(tasks);
    }
  }

  private async runFailedSettlement(tasks: FailedSettlementTask[]): Promise<void> {
    const first = tasks[0]!;
    try {
      await this.settleFailuresNow(
        tasks.map(({ job, error, now }) => ({ job, error, at: now })),
        first.now,
      );
      for (const task of tasks) task.resolve();
    } catch (error) {
      for (const task of tasks) task.reject(error);
    } finally {
      for (let index = 0; index < tasks.length; index += 1) {
        this.releaseSuccessfulSettlementSlot();
      }
      this.activeFailureSettlementWorkers -= 1;
      this.activeFailureSettlementCampaigns.delete(first.campaignId);
      this.scheduleFailedSettlementPump();
    }
  }

  async discardReservoirEnvelope(envelope: PreparedCampaignEnvelope, now = new Date()): Promise<void> {
    try {
      await this.sender.revokePrepared?.(envelope.preparedContext, new Error("Campaign runtime stopping"));
      await settleAborted(envelope.job, now);
    } finally {
      inFlightRegistry.release(envelope.registration.key);
      this.releaseRoute(envelope.job.routeId);
    }
  }

  async abandonBrokerEnvelope(envelope: PreparedCampaignEnvelope, now = new Date()): Promise<void> {
    const { failure } = await this.abandonBrokerEnvelopes([envelope], now);
    if (failure !== undefined) throw failure;
  }

  /**
   * Fails a page of reclaimed broker deliveries closed as delivery-unknown.
   * Every envelope here was handed to a consumer that is gone, so the provider
   * may or may not have been called: it is never re-sent (at-most-once).
   *
   * The per-job outcome is exactly abandonBrokerEnvelope's, only batched:
   *   intent    settlePreparedTransport(job, { error }) records the durable
   *             delivery-unknown outcome first; a job whose intent write fails
   *             is left untouched (still Processing under its lease) and is not
   *             reported as settled, so its delivery is reclaimed again later.
   *   settle    one settleFailedBatch transaction per campaign, under that
   *             campaign's settlement serialization: status Processing AND the
   *             envelope's lease token -> Failed (the error is not retryable,
   *             so it is exhausted whatever the attempt count), lease cleared,
   *             attempts unchanged, error_reason set, route queue depth and
   *             campaign counters moved once per updated row. A row that no
   *             longer matches (already Sent under acknowledgement debt,
   *             already Failed by an earlier reclaim, or re-leased) is a no-op
   *             inside a committed transaction, exactly as before.
   *   complete  completeIfDrained for the campaign when a row was exhausted.
   *   release   the in-flight registration and route slot of every envelope,
   *             settled or not.
   * Returns the envelopes whose settlement committed (the caller may
   * acknowledge those deliveries) and the first failure, if any; the caller
   * decides what to do with it after acknowledging what did persist.
   */
  async abandonBrokerEnvelopes(
    envelopes: PreparedCampaignEnvelope[],
    now = new Date(),
  ): Promise<{ settled: PreparedCampaignEnvelope[]; failure?: unknown }> {
    if (!envelopes.length) return { settled: [] };
    const error = new Error("Provider delivery is unknown after broker consumer loss");
    const settled: PreparedCampaignEnvelope[] = [];
    let failure: unknown;
    const fail = (reason: unknown) => {
      failure ??= reason ?? new Error("Broker reclaim settlement failed");
    };
    try {
      const intents = await Promise.allSettled(envelopes.map((envelope) =>
        this.sender.settlePreparedTransport?.(envelope.job, envelope.preparedContext, { error })));
      const byCampaign = new Map<number, PreparedCampaignEnvelope[]>();
      intents.forEach((intent, index) => {
        if (intent.status === "rejected") {
          fail(intent.reason);
          return;
        }
        const envelope = envelopes[index]!;
        const group = byCampaign.get(envelope.job.campaignId) ?? [];
        group.push(envelope);
        byCampaign.set(envelope.job.campaignId, group);
      });
      for (const [campaignId, group] of byCampaign) {
        try {
          const result = await this.withCampaignSettlement(campaignId, () =>
            settleFailedBatch(group.map(({ job }) => ({ job, error })), now));
          if (result.exhausted > 0) {
            for (const drained of result.campaigns) await completeIfDrained(drained, now);
          }
          settled.push(...group);
        } catch (reason) {
          fail(reason);
        }
      }
    } finally {
      for (const envelope of envelopes) {
        inFlightRegistry.release(envelope.registration.key);
        this.releaseRoute(envelope.job.routeId);
      }
    }
    return failure === undefined ? { settled } : { settled, failure };
  }

  async processOne(now = new Date()): Promise<"idle" | "sent" | "retry" | "failed"> {
    const job = await this.claimNext(now);
    if (!job) return "idle";
    return this.processClaimed(job, now);
  }

  async processBatch(batchSize = 8, now = new Date()): Promise<"idle" | "sent" | "retry" | "failed"> {
    const jobs = await this.claimNextBatch(now, batchSize);
    if (!jobs.length) return "idle";
    return this.processClaimedBatch(jobs, now, false);
  }

  /**
   * Claiming is deliberately decoupled from dispatch for the production
   * runtime. A batch's sends can occupy the current pacing horizon while the
   * next batch prefetches future slots. The synchronous processBatch() above
   * remains available for tests and one-shot callers that need settlement
   * completion before returning.
   */
  async processBatchDetached(batchSize = 8, now = new Date()): Promise<"idle" | "sent"> {
    const jobs = await this.claimNextBatch(now, batchSize);
    if (!jobs.length) return "idle";
    const task = this.processClaimedBatch(jobs, now, true).then(
      () => undefined,
      (error) => logger.error({ error }, "Detached campaign batch failed after claim"),
    );
    this.activeBatches.add(task);
    void task.then(() => this.activeBatches.delete(task));
    return "sent";
  }

  async waitForIdle(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.activeBatches.size || this.successSettlementsPending > 0)
      && Date.now() < deadline
    ) {
      await Promise.race([
        ...this.activeBatches,
        new Promise<void>((resolve) => setTimeout(resolve, 10)),
      ]);
    }
    if (this.activeBatches.size === 0 && this.successSettlementsPending === 0) {
      await this.sender.flushPreparedOutcomes?.();
    }
    return this.activeBatches.size === 0 && this.successSettlementsPending === 0;
  }

  closeDispatchScheduler(): Promise<void> {
    return Promise.all([this.dispatchScheduler.close(), this.transportShards.close()]).then(() => undefined);
  }
  updateTransportOwnership(phoneNumberId: number, fencingToken: number, validUntilMs: number): void {
    this.transportShards.updatePhoneOwnership(phoneNumberId, { fencingToken, validUntilMs });
  }
  revokeTransportOwnership(phoneNumberId: number, fencingToken?: number): void {
    this.transportShards.revokePhoneOwnership(phoneNumberId, fencingToken);
  }
  transportShardForPhone(phoneNumberId: number): number {
    return this.transportShards.shardForPhone(phoneNumberId);
  }
  async architectureTransportProbe(phoneNumberId: number): Promise<{
    providerMessageId: string;
    shardId: number;
    startedAt?: number;
    completedAt?: number;
  }> {
    const outcome = await this.transportShards.dispatch(
      phoneNumberId,
      1,
      Date.now(),
      {
        kind: "whatsapp",
        mode: "mock",
        providerPhoneId: `architecture-probe-${phoneNumberId}`,
        payload: { messaging_product: "whatsapp" },
        timeoutMs: 8_000,
      },
      new AbortController().signal,
    );
    try {
      if (outcome.error) throw outcome.error;
      if (!outcome.providerMessageId) throw new Error("Architecture probe returned no provider message ID");
      return {
        providerMessageId: outcome.providerMessageId,
        shardId: this.transportShards.shardForPhone(phoneNumberId),
        startedAt: outcome.startedAt,
        completedAt: outcome.completedAt,
      };
    } finally {
      outcome.acknowledge();
    }
  }

  private async processClaimedBatch(
    jobs: CampaignJob[],
    now: Date,
    deferSuccessfulSettlement: boolean,
  ): Promise<"idle" | "sent" | "retry" | "failed"> {
    for (const job of jobs) {
      this.observer?.record(
        "queue_wait",
        Math.max(0, (job.lockedAt?.getTime() ?? Date.now()) - job.availableAt.getTime()),
        1,
      );
    }
    const successful: SuccessfulSend[] = [];
    const failures: FailedSend[] = [];
    const aborted: CampaignJob[] = [];
    const registrations = new Map<number, ReturnType<typeof inFlightRegistry.register>>();
    const providerTimeouts = new Map<number, NodeJS.Timeout>();
    const providerAccepted = new Set<number>();
    let fallbackOutcome: "idle" | "retry" | "failed" = "idle";
    const batchDispatchStillAllowed = () => this.dispatchStillAllowedCached(jobs[0]!);
    for (const job of jobs) {
      const registration = inFlightRegistry.register(job.campaignId, job.id, job.leaseToken!);
      registrations.set(job.id, registration);
    }
    try {
      const resolutionStarted = performance.now();
      const resolutions = await resolveJobTemplates(jobs);
      this.observer?.record("template_resolution", performance.now() - resolutionStarted, jobs.length);
      const beforeSend = await campaignStatus(jobs[0]!);
      if (!beforeSend || beforeSend.status !== "Running" || beforeSend.killSwitch || !beforeSend.routeActive) {
        await Promise.all(jobs.map((job) => settleAborted(job, now)));
        return "idle";
      }
      let preparedContexts = new Map<number, unknown>();
      let preparationError: unknown;
      const resolvedJobs = resolutions.flatMap(({ resolvedJob, error }) =>
        resolvedJob && !error ? [resolvedJob] : []);
      if (resolvedJobs.length && this.sender.prepareBatch) {
        try {
          preparedContexts = await this.sender.prepareBatch(resolvedJobs, registrations.get(jobs[0]!.id)?.signal);
        } catch (error) {
          preparationError = error;
        }
      }
      if (!preparationError) campaignDispatchMetrics.refill(preparedContexts.size);
      if (this.sender.preparedRecipient) {
        for (const job of resolvedJobs) {
          const context = preparedContexts.get(job.id);
          if (context === undefined) continue;
          const recipient = this.sender.preparedRecipient(context);
          const registration = registrations.get(job.id);
          if (recipient && registration) {
            inFlightRegistry.bindRecipient(
              registration.key,
              recipient.organizationId,
              recipient.recipient,
            );
          }
        }
      }
      if (this.sender.validatePrepared) {
        await Promise.all(resolvedJobs.map(async (job) => {
          const context = preparedContexts.get(job.id);
          const registration = registrations.get(job.id);
          if (
            context !== undefined
            && registration
            && !await this.sender.validatePrepared!(context)
          ) {
            registration.abort("Prepared campaign envelope was revoked");
          }
        }));
      }
      await Promise.all(resolutions.map(async ({ job, resolvedJob, error: resolutionError }) => {
        const registration = registrations.get(job.id)!;
        if (resolutionError || !resolvedJob) {
          failures.push({
            job,
            error: resolutionError ?? new Error("Template resolution failed"),
          });
          fallbackOutcome = "failed";
          return;
        }
        if (preparationError) {
          failures.push({ job, error: preparationError });
          fallbackOutcome = "failed";
          return;
        }
        try {
          const pacingStarted = performance.now();
          const dispatchPermit = await this.waitForDispatchPermit(
            resolvedJob,
            (jobs[0] as CampaignJobWithDispatchPhone).dispatchPhoneNumberId,
            registration.signal,
            batchDispatchStillAllowed,
          );
          if (!dispatchPermit) {
            const preparedContext = preparedContexts.get(resolvedJob.id);
            if (preparedContext !== undefined) {
              await this.sender.revokePrepared?.(
                preparedContext,
                new Error("Campaign dispatch fence revoked"),
              );
            }
            aborted.push(job);
            return;
          }
          this.observer?.record("pacing_wait", performance.now() - pacingStarted, 1);
          const providerTimeout = setTimeout(() => registration.abort("Provider send timed out"), 10_000);
          providerTimeout.unref();
          providerTimeouts.set(job.id, providerTimeout);
          const providerStarted = performance.now();
          const handoffMs = dispatchPermit.acknowledgeDispatch();
          this.observer?.record("dispatch_handoff", handoffMs, 1);
          let result: { providerMessageId: string };
          try {
            const sendOptions = {
              signal: registration.signal,
              idempotencyKey: resolvedJob.idempotencyKey,
            };
            const preparedContext = preparedContexts.get(resolvedJob.id);
            // This branch is the deliberately tiny, mechanically auditable hot
            // path: permit acknowledgement followed directly by transport.
            // No await, database helper, lock, authorization, metric, or
            // settlement operation is allowed between these two statements.
            const transportStarted = performance.now();
            campaignDispatchMetrics.transportStart();
            this.observer?.record(
              "transport_start",
              performance.now() - transportStarted,
              1,
            );
            if (this.sender.sendPreparedTransport && preparedContext !== undefined) {
              try {
                result = await this.sender.sendPreparedTransport(
                  resolvedJob,
                  sendOptions,
                  preparedContext,
                );
                providerAccepted.add(job.id);
                await this.sender.settlePreparedTransport?.(
                  resolvedJob,
                  preparedContext,
                  result,
                );
              } catch (error) {
                await this.sender.settlePreparedTransport?.(
                  resolvedJob,
                  preparedContext,
                  { error },
                );
                throw error;
              }
            } else {
              result = await this.sender.send(resolvedJob, sendOptions, preparedContext);
              providerAccepted.add(job.id);
            }
          } finally {
            clearTimeout(providerTimeout);
            providerTimeouts.delete(job.id);
          }
          this.observer?.record("provider", performance.now() - providerStarted, 1);
          successful.push({ job, resolvedJob, providerMessageId: result.providerMessageId });
        } catch (error) {
          // Never turn a provider-accepted send whose durable outcome write
          // stalled into a retry. Leave its exact lease/intent for recovery;
          // the provider intent prevents another HTTP invocation.
          if (providerAccepted.has(job.id)) throw error;
          if (registration.signal.aborted) {
            const preparedContext = preparedContexts.get(resolvedJob.id);
            if (preparedContext !== undefined) {
              await this.sender.revokePrepared?.(preparedContext, registration.signal.reason);
            }
            aborted.push(job);
            return;
          }
          failures.push({ job, error });
          fallbackOutcome = !isRetryableProviderError(error) || job.attempts >= job.maxAttempts
            ? "failed"
            : "retry";
        }
      }));
      if (aborted.length) await Promise.all(aborted.map((job) => settleAborted(job, now)));
      if (failures.length) {
        const state = await campaignStatus(jobs[0]!);
        if (!state || state.killSwitch || !["Running", "Paused"].includes(state.status)) {
          await Promise.all(failures.map(({ job }) => settleAborted(job, now)));
          failures.length = 0;
        }
      }
      if (failures.length) {
        const settlementStarted = performance.now();
        const failedSettlements = await this.withCampaignSettlement(jobs[0]!.campaignId, async () => {
          const settled = await settleFailedBatch(failures, now);
          if (settled.exhausted > 0) {
            for (const campaignId of settled.campaigns) await completeIfDrained(campaignId, now);
          }
          return settled;
        });
        this.observer?.record("failure_settlement", performance.now() - settlementStarted, failures.length);
        void failedSettlements;
      }
      if (!successful.length) return fallbackOutcome;
      const settlement = this.enqueueSuccessfulSettlement({
        campaignId: jobs[0]!.campaignId,
        successful,
        now,
      });
      if (deferSuccessfulSettlement) {
        void settlement.catch((error) => {
          logger.error({
            error,
            campaignId: jobs[0]!.campaignId,
            jobs: successful.length,
          }, "Deferred successful campaign settlement failed; exact leases remain for recovery");
        });
      } else {
        await settlement;
      }
      return "sent";
    } finally {
      for (const job of jobs) {
        const providerTimeout = providerTimeouts.get(job.id);
        if (providerTimeout) clearTimeout(providerTimeout);
        const registration = registrations.get(job.id);
        if (registration) inFlightRegistry.release(registration.key);
        this.releaseRoute(job.routeId);
      }
    }
  }

  /**
   * Successful provider responses no longer wait on the campaign aggregate
   * transaction while holding route in-flight capacity. Each provider batch
   * gets its own task (never cross-route coalesced), while the campaign tail
   * below preserves FIFO settlement ordering for the shared aggregate row.
   *
   * The queue is bounded so a slow database cannot turn detached dispatch into
   * unbounded memory growth. Producers apply backpressure only after the
   * bounded capacity is full; normal provider dispatch is not held by
   * settlement latency.
   */
  private async enqueueSuccessfulSettlement(input: {
    campaignId: number;
    successful: SuccessfulSend[];
    now: Date;
    slotReserved?: boolean;
  }): Promise<void> {
    if (!input.slotReserved && !this.reserveSuccessfulSettlementSlot()) {
      // The provider outcome/durable intent has already been recorded before
      // this point. Leave the exact Processing lease for reconciliation rather
      // than retaining one detached promise per completed provider call.
      throw new Error("Campaign success settlement queue is full");
    }
    const task = new Promise<void>((resolve, reject) => {
      this.successSettlementQueue.push({
        campaignId: input.campaignId,
        successful: input.successful,
        now: input.now,
        resolve,
        reject,
      });
    });
    this.scheduleSuccessfulSettlementPump();
    return task;
  }

  private reserveSuccessfulSettlementSlot(): boolean {
    if (this.successSettlementsPending >= CampaignWorker.MAX_PENDING_SUCCESS_SETTLEMENTS) {
      campaignDispatchMetrics.settlementBackpressure();
      return false;
    }
    this.successSettlementsPending += 1;
    campaignDispatchMetrics.settlementPending(1);
    return true;
  }

  private releaseSuccessfulSettlementSlot(): void {
    this.successSettlementsPending = Math.max(0, this.successSettlementsPending - 1);
    campaignDispatchMetrics.settlementPending(-1);
  }

  private scheduleSuccessfulSettlementPump(): void {
    if (this.successSettlementPumpScheduled) return;
    this.successSettlementPumpScheduled = true;
    const handle = setImmediate(() => {
      this.successSettlementPumpScheduled = false;
      this.pumpSuccessfulSettlements();
    });
    handle.unref();
  }

  private pumpSuccessfulSettlements(): void {
    while (
      this.activeSuccessSettlementWorkers < CampaignWorker.SUCCESS_SETTLEMENT_WORKERS
      && this.successSettlementQueue.length
    ) {
      const taskIndex = this.successSettlementQueue.findIndex(
        (candidate) => !this.activeSuccessSettlementCampaigns.has(candidate.campaignId),
      );
      if (taskIndex < 0) return;
      const [first] = this.successSettlementQueue.splice(taskIndex, 1);
      const tasks = [first!];
      let jobs = first!.successful.length;
      for (
        let index = 0;
        index < this.successSettlementQueue.length
        && jobs < CampaignWorker.SUCCESS_SETTLEMENT_BATCH_SIZE;
      ) {
        const candidate = this.successSettlementQueue[index]!;
        if (
          candidate.campaignId !== first!.campaignId
          || jobs + candidate.successful.length > CampaignWorker.SUCCESS_SETTLEMENT_BATCH_SIZE
        ) {
          index += 1;
          continue;
        }
        tasks.push(candidate);
        jobs += candidate.successful.length;
        this.successSettlementQueue.splice(index, 1);
      }
      this.activeSuccessSettlementCampaigns.add(first!.campaignId);
      this.activeSuccessSettlementWorkers += 1;
      void this.runSuccessfulSettlement(tasks);
    }
  }

  private async runSuccessfulSettlement(tasks: SuccessfulSettlementTask[]): Promise<void> {
    const first = tasks[0]!;
    const successful = tasks.flatMap((task) => task.successful);
    const started = performance.now();
    try {
      await this.withCampaignSettlement(first.campaignId, async () => {
        const drainedCampaigns = await settleSentBatch(successful);
        for (const campaignId of drainedCampaigns) {
          await completeIfDrained(campaignId, first.now);
        }
      });
      campaignDispatchMetrics.settlementDrained(successful.length, performance.now() - started);
      this.observer?.record(
        "success_settlement",
        performance.now() - started,
        successful.length,
      );
      for (const task of tasks) task.resolve();
    } catch (error) {
      for (const task of tasks) task.reject(error);
    } finally {
      for (let index = 0; index < tasks.length; index += 1) {
        this.releaseSuccessfulSettlementSlot();
      }
      this.activeSuccessSettlementWorkers -= 1;
      this.activeSuccessSettlementCampaigns.delete(first.campaignId);
      // Yield to the high-resolution dispatch scheduler between campaign
      // settlement transactions instead of chaining the next same-campaign
      // JSON preparation and database update in the current microtask turn.
      this.scheduleSuccessfulSettlementPump();
    }
  }

  /**
   * PostgreSQL must serialize campaign aggregate updates, but transactions
   * waiting on that row must not occupy the shared connection pool. Queue
   * them here before db.transaction() checks out a client so independent
   * number claims and template reads retain pool capacity.
   */
  private async withCampaignSettlement<T>(
    campaignId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.campaignSettlementTails.get(campaignId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.campaignSettlementTails.set(campaignId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.campaignSettlementTails.get(campaignId) === tail) {
        this.campaignSettlementTails.delete(campaignId);
      }
    }
  }

  private async processClaimed(job: CampaignJob, now: Date): Promise<"idle" | "sent" | "retry" | "failed"> {
    const routeId = job.routeId!;
    const registration = inFlightRegistry.register(job.campaignId, job.id, job.leaseToken!);
    const providerTimeout = setTimeout(() => registration.abort("Provider send timed out"), 10_000);
    providerTimeout.unref();
    let providerAccepted = false;
    try {
      const resolvedJob = await resolveJobTemplate(job);
      const beforeSend = await campaignStatus(resolvedJob);
      if (!beforeSend || beforeSend.status !== "Running" || beforeSend.killSwitch || !beforeSend.routeActive) {
        await settleAborted(resolvedJob, now);
        return "idle";
      }
      await waitForScheduledSlot(resolvedJob.scheduledSendAt, registration.signal);
      if (!await dispatchStillAllowed(resolvedJob)) {
        await settleAborted(resolvedJob, now);
        return "idle";
      }
      const result = await this.sender.send(resolvedJob, {
        signal: registration.signal,
        idempotencyKey: resolvedJob.idempotencyKey,
      });
      providerAccepted = true;
      const settlement = await settleSent(
        resolvedJob,
        resolvedJob.payload as Record<string, unknown>,
        result.providerMessageId,
      );
      if (settlement.maybeDrained) await completeIfDrained(job.campaignId, now);
      return settlement.sent ? "sent" : "idle";
    } catch (error) {
      // Once the provider accepted the message, a database deadlock or
      // transient settlement failure must never be converted into a provider
      // failure/retry. settleSent retries only the idempotent database write;
      // if that still cannot settle, leave the exact lease for expiry
      // recovery. A later provider retry uses the same idempotency key.
      if (providerAccepted) throw error;
      if (registration.signal.aborted) {
        await settleAborted(job, now);
        return "idle";
      }
      const state = await campaignStatus(job);
      if (!state || state.killSwitch || !["Running", "Paused"].includes(state.status)) {
        await settleAborted(job, now);
        return "idle";
      }
      const settled = await settleFailed(job, now, error);
      if (settled.updated && settled.exhausted) await completeIfDrained(job.campaignId, now);
      return settled.exhausted ? "failed" : "retry";
    } finally {
      clearTimeout(providerTimeout);
      inFlightRegistry.release(registration.key);
      this.releaseRoute(routeId);
    }
  }

  private async waitForDispatchPermit(
    job: CampaignJob,
    phoneNumberId: number | undefined,
    signal: AbortSignal,
    fence: () => boolean | Promise<boolean>,
  ): Promise<import("./campaign-phone-dispatch-scheduler").DispatchPermit | false> {
    const routeId = job.routeId!;
    if (!phoneNumberId) throw new Error(`Claimed campaign job ${job.id} is missing its phone dispatch lane`);
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Send aborted");
    }
    const configuredTps = Math.max(1, job.configuredTps ?? 1);
    const intervalMs = 1_000 / configuredTps;
    const fenceResult = fence();
    if (!(typeof fenceResult === "boolean" ? fenceResult : await fenceResult)) return false;
    return this.dispatchScheduler.wait(phoneNumberId, intervalMs, signal, job.scheduledSendAt);
  }

  private dispatchStillAllowedCached(job: CampaignJob): boolean | Promise<boolean> {
    const routeId = job.routeId!;
    const checkedAt = performance.now();
    let entry = this.dispatchFenceByRoute.get(routeId);
    if (!entry) {
      entry = { refreshAt: 0, validUntil: 0 };
      this.dispatchFenceByRoute.set(routeId, entry);
    }
    if (checkedAt >= entry.refreshAt && !entry.refresh) {
      const current = entry;
      current.refreshAt = checkedAt + 10;
      current.refresh = dispatchStillAllowed(job).then(
        (allowed) => {
          current.allowed = allowed;
          current.validUntil = performance.now() + 50;
          return allowed;
        },
        () => {
          current.allowed = false;
          current.validUntil = performance.now() + 10;
          return false;
        },
      ).finally(() => {
        current.refresh = undefined;
      });
    }
    if (entry.allowed === undefined || checkedAt >= entry.validUntil) {
      return entry.refresh ?? false;
    }
    return entry.allowed;
  }

  private releaseRoute(routeId: number | null): void {
    if (!routeId) return;
    const remaining = (this.routeInFlight.get(routeId) ?? 1) - 1;
    if (remaining <= 0) this.routeInFlight.delete(routeId);
    else this.routeInFlight.set(routeId, remaining);
  }
}

async function waitForScheduledSlot(scheduledAt: Date | null, signal: AbortSignal): Promise<void> {
  if (!scheduledAt) return;
  const delayMs = scheduledAt.getTime() - Date.now();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Send aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
