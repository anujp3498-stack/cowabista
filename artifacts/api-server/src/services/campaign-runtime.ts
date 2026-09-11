import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import {
  CampaignWorker,
  DatabaseJobQueue,
  deleteOrphanedCampaignMetricDeltas,
  flushCampaignMetricDeltas,
  flushAllCampaignMetricDeltas,
  RouteTpsLimiter,
  isExhaustedByAttempts,
  type CampaignWorkerObserver,
  type ProviderSender,
} from "./campaign-queue";
import { createCampaignPacingCoordinator, type AtomicPacingCoordinator } from "./campaign-pacing-coordinator";
import { DelegatingWhatsAppSender } from "./whatsapp-template-sender";
import { executeCampaignPlan } from "./campaign-planning";
import { inFlightRegistry } from "./campaign-inflight";
import { reconcileCampaignJobs } from "./campaign-reconciliation";
import { CampaignPhoneReservoir, type PhoneLaneMetrics } from "./campaign-phone-reservoir";
import { campaignDispatchMetrics } from "./campaign-dispatch-metrics";
import { createPreparedDispatchBroker, type PreparedDispatchBroker } from "./campaign-prepared-broker";
import { describePhoneScope, phoneScopeFromEnv } from "./campaign-phone-scope";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { campaignAuditTable, campaignJobsTable, campaignMetricsTable, campaignRoutesTable, campaignsTable, db } from "@workspace/db";

export class CampaignRuntime {
  private timer: NodeJS.Timeout | undefined;
  /**
   * Housekeeping (lease reaping, throttle reactivation,
   * cleanup) runs on its own timer, independent of the claim/send tick.
   * A tick's claim lanes loop until idle or the per-tick budget is
   * exhausted, which can take far longer than intervalMs whenever any
   * route still has backlog -- if housekeeping only ran at the start of
   * that same tick, a throttled low-TPS route sharing a runtime with a
   * busy high-TPS route could wait multiple seconds past its own 1-second
   * cooldown for the next tick to even start, silently throttling it well
   * below its configured cap despite the underlying reservation logic
   * being second-accurate.
   */
  private housekeepingTimer: NodeJS.Timeout | undefined;
  private ticking = false;
  private housekeepingRunning = false;
  private metricsFlushRunning = false;
  private stopping = false;
  /**
   * Heartbeat for `/healthz` liveness reporting. Tracks housekeeping
   * completions rather than tick completions: a tick's claim lanes loop
   * until idle or the per-tick claim budget is exhausted, so its duration
   * legitimately varies with backlog depth and provider latency and would
   * make a naive staleness threshold false-positive under real load.
   * Housekeeping is lightweight, runs on its own fixed short interval
   * regardless of backlog, and always completes (success or logged
   * failure) via its own try/finally -- so a stale housekeeping heartbeat
   * reliably means the interval loop itself died (e.g. the process is
   * wedged), not just that the runtime is busy.
   */
  private lastHousekeepingAt: Date | undefined;
  private readonly limiter: RouteTpsLimiter;
  private readonly pacingCoordinator: AtomicPacingCoordinator;
  private readonly workerId = `api-${process.pid}-${randomUUID()}`;
  private readonly worker: CampaignWorker;
  private readonly batchSize: number;
  private readonly maxClaimsPerTick: number;
  private readonly reservoir: CampaignPhoneReservoir;
  /** Phones this process may discover and fence; undefined = every Running phone (single-runtime behaviour). */
  private readonly phoneScopeIds: ReadonlySet<number> | undefined;

  /**
   * `sender` is injectable so tests can prove concurrent per-number sends
   * without a real provider. `leaseMs` is injectable so an OS-process-level
   * crash-recovery test can force a lease to expire in ~1s instead of
   * CampaignWorker's production default (30s) -- production call sites never
   * pass it, so behavior there is unchanged.
   */
  constructor(
    sender: ProviderSender = new DelegatingWhatsAppSender(),
    leaseMs?: number,
    options: {
      queue?: DatabaseJobQueue;
      observer?: CampaignWorkerObserver;
      batchSize?: number;
      maxClaimsPerTick?: number;
      /** Allows tests to share one atomic pacing timeline with this runtime. */
      pacingCoordinator?: AtomicPacingCoordinator;
      preparedBroker?: PreparedDispatchBroker;
      brokerAbandonedDeliveryMs?: number;
      /**
       * Deterministic phone partition for this runtime process. Defaults to
       * CAMPAIGN_TRANSPORT_PHONE_IDS; unset means unscoped. See
       * campaign-phone-scope.ts.
       */
      phoneScope?: ReadonlySet<number>;
    } = {},
  ) {
    this.batchSize = options.batchSize ?? 256;
    this.phoneScopeIds = options.phoneScope ?? phoneScopeFromEnv();
    this.maxClaimsPerTick = options.maxClaimsPerTick ?? CampaignRuntime.DEFAULT_MAX_CLAIMS_PER_TICK;
    const pacingCoordinator = options.pacingCoordinator ?? createCampaignPacingCoordinator();
    this.pacingCoordinator = pacingCoordinator;
    this.limiter = new RouteTpsLimiter(pacingCoordinator);
    const queue = options.queue ?? new DatabaseJobQueue();
    this.worker = leaseMs === undefined
      ? new CampaignWorker(queue, sender, this.limiter, this.workerId, 30_000, options.observer)
      : new CampaignWorker(queue, sender, this.limiter, this.workerId, leaseMs, options.observer);
    this.reservoir = new CampaignPhoneReservoir(
      this.worker,
      this.batchSize,
      pacingCoordinator,
      this.workerId,
      16_384,
      this.phoneScopeIds,
      options.preparedBroker ?? createPreparedDispatchBroker(),
      options.brokerAbandonedDeliveryMs ?? Math.min(5_000, leaseMs ?? 30_000),
    );
  }

  private static readonly DEFAULT_MAX_CLAIMS_PER_TICK = 8_192;
  /**
   * How many claim+send cycles run concurrently within one tick. claim() is
   * transaction-safe under concurrent callers (route/phone slots are
   * reserved atomically by the pacing coordinator -- see campaign-queue.ts), so running
   * several lanes in parallel lets different phone numbers send at the same
   * time instead of queuing behind each other's provider round-trip latency.
   * Without this, one CampaignRuntime could only ever process one phone
   * number's send at a time no matter how many routes/numbers a campaign
   * has, defeating "parallel per-number processing" and capping aggregate
   * throughput far below the sum of each number's configured TPS.
   */
  private static readonly MIN_CONCURRENT_SEND_LANES = 2;
  private static readonly MAX_CONCURRENT_SEND_LANES = 8;
  private adaptiveLaneTarget = 4;

  /** Housekeeping needs to run far more often than a busy tick returns; see the field comment above. */
  private static readonly HOUSEKEEPING_INTERVAL_MS = 200;

  start(intervalMs = 100): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    this.housekeepingTimer = setInterval(
      () => void this.housekeeping(),
      Math.min(intervalMs, CampaignRuntime.HOUSEKEEPING_INTERVAL_MS),
    );
    this.housekeepingTimer.unref();
    void this.housekeeping();
    void this.tick();
    logger.info({ intervalMs, phoneScope: describePhoneScope(this.phoneScopeIds) }, "Campaign runtime started");
  }

  /** The phone partition this process fences and processes; undefined when unscoped. */
  phoneScope(): ReadonlySet<number> | undefined {
    return this.phoneScopeIds;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = undefined;
    this.stopping = true;
    // Abort provider work before the reservoir closes its broker. Provider
    // completions then enqueue their final ACKs while the broker is still
    // available, and exact leases remain recoverable if a call does not exit.
    inFlightRegistry.abortAll("Campaign runtime stopping");
    await this.reservoir.stop();
    const deadline = Date.now() + 5_000;
    while ((this.ticking || this.housekeepingRunning) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    // A claim already inside its database transaction when stopping was set
    // can register a detached batch just before tick exits. Abort again only
    // after producers have stopped, then drain the complete final batch set.
    inFlightRegistry.abortAll("Campaign runtime stopping");
    const settled = await inFlightRegistry.waitForIdle(5_000);
    const batchesSettled = await this.worker.waitForIdle(5_000);
    await this.worker.closeDispatchScheduler();
    await flushAllCampaignMetricDeltas();
    await this.limiter.close();
    if (!settled || !batchesSettled || this.ticking) {
      logger.warn({ inFlight: inFlightRegistry.size }, "Campaign runtime stop timed out; leases will be recovered");
    }
    inFlightRegistry.clear();
    logger.info("Campaign runtime stopped");
  }

  private async reapExpiredLeases(_now = new Date()): Promise<void> {
    const expired = await db.select({
      id: campaignJobsTable.id,
      campaignId: campaignJobsTable.campaignId,
      routeId: campaignJobsTable.routeId,
      leaseToken: campaignJobsTable.leaseToken,
      attempts: campaignJobsTable.attempts,
      maxAttempts: campaignJobsTable.maxAttempts,
      campaignStatus: campaignsTable.status,
      killSwitch: campaignsTable.killSwitch,
    }).from(campaignJobsTable).innerJoin(campaignsTable, and(
      eq(campaignsTable.id, campaignJobsTable.campaignId),
      eq(campaignsTable.organizationId, campaignJobsTable.organizationId),
    )).where(and(
      eq(campaignJobsTable.status, "Processing"),
      or(
        isNull(campaignJobsTable.leaseExpiresAt),
        sql`${campaignJobsTable.leaseExpiresAt} <= statement_timestamp()`,
      ),
    ));
    const affected = new Set<number>();
    for (const job of expired) {
      if (job.leaseToken) {
        inFlightRegistry.abortLease(
          job.campaignId,
          job.id,
          job.leaseToken,
          "Campaign send lease expired",
        );
      }
      const live = !job.killSwitch && (job.campaignStatus === "Running" || job.campaignStatus === "Paused");
      // A lease expiry means the worker never came back to report success
      // or failure -- most often a clean redeploy/restart, but sometimes a
      // hard crash caused by this specific job's payload (a "poison
      // pill"). Without this check that job would be requeued to "Queued"
      // forever: attempts increments on every re-claim, but nothing
      // upstream ever compares it to maxAttempts the way the normal
      // send-failure path does, so it would crash-loop the whole runtime
      // indefinitely instead of eventually failing like any other
      // exhausted job.
      const exhausted = live && isExhaustedByAttempts(job.attempts, job.maxAttempts);
      const requeue = live && !exhausted;
      const [updated] = await db.update(campaignJobsTable).set(requeue ? {
        status: "Queued", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
        availableAt: sql`statement_timestamp()`,
      } : exhausted ? {
        status: "Failed", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
        errorReason: "Exceeded retry attempts after repeated lost/expired leases",
      } : {
        status: "Cancelled", lockedAt: null, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
        errorReason: "Stale lease recovered after terminal campaign",
      }).where(and(
        eq(campaignJobsTable.id, job.id),
        eq(campaignJobsTable.status, "Processing"),
        job.leaseToken ? eq(campaignJobsTable.leaseToken, job.leaseToken) : isNull(campaignJobsTable.leaseToken),
        or(
          isNull(campaignJobsTable.leaseExpiresAt),
          sql`${campaignJobsTable.leaseExpiresAt} <= statement_timestamp()`,
        ),
      )).returning();
      if (updated) {
        affected.add(job.campaignId);
        if (exhausted) {
          await db.update(campaignMetricsTable).set({
            processing: sql`greatest(0, ${campaignMetricsTable.processing} - 1)`,
            failed: sql`${campaignMetricsTable.failed} + 1`,
          }).where(eq(campaignMetricsTable.campaignId, job.campaignId));
          if (job.routeId) {
            await db.update(campaignRoutesTable).set({ queueDepth: sql`greatest(0, ${campaignRoutesTable.queueDepth} - 1)` })
              .where(eq(campaignRoutesTable.id, job.routeId));
          }
          await db.update(campaignsTable).set({ failed: sql`${campaignsTable.failed} + 1` }).where(eq(campaignsTable.id, job.campaignId));
        }
      }
    }
    for (const campaignId of affected) await reconcileCampaignJobs(campaignId);
  }

  /**
   * A campaign only reaches Scheduled after readiness already froze an
   * execution plan (see routes/campaign-engine.ts's `schedule` action), so
   * activating it here just means executing that frozen plan -- creating
   * whatever allocation-derived jobs are still missing and flipping to
   * Running. `executeCampaignPlan` is itself idempotent, so a runtime crash
   * mid-activation is safely resumed on the next tick.
   */
  private async activateDueCampaigns(now: Date): Promise<void> {
    const due = await db.select().from(campaignsTable).where(and(
      eq(campaignsTable.status, "Scheduled"),
      lte(campaignsTable.scheduledAt, now),
    ));
    for (const campaign of due) {
      try {
        await executeCampaignPlan(campaign.organizationId, campaign.id);
      } catch (error) {
        await db.transaction(async (tx) => {
          const [failed] = await tx.update(campaignsTable).set({
            status: "Failed",
            completedAt: now,
          }).where(and(eq(campaignsTable.id, campaign.id), eq(campaignsTable.status, "Scheduled"))).returning();
          if (failed) await tx.insert(campaignAuditTable).values({
            organizationId: failed.organizationId,
            campaignId: failed.id,
            action: "scheduled-start-failed",
            fromStatus: "Scheduled",
            toStatus: "Failed",
            metadata: {
              scheduledAt: failed.scheduledAt?.toISOString(),
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
      }
    }
  }

  /** Test-only hook: runs housekeeping plus one claim tick synchronously (awaited), bypassing the setInterval schedule. */
  async runTickForTest(): Promise<void> {
    await this.housekeeping();
    await this.tick();
    await this.reservoir.waitForIdle(5_000);
    await this.worker.waitForIdle(5_000);
  }

  private async housekeeping(): Promise<void> {
    if (this.housekeepingRunning) return;
    if (this.stopping) return;
    this.housekeepingRunning = true;
    try {
      if (!this.metricsFlushRunning) {
        this.metricsFlushRunning = true;
        try {
          await flushCampaignMetricDeltas();
          await deleteOrphanedCampaignMetricDeltas();
        } finally {
          this.metricsFlushRunning = false;
        }
      }
      const now = new Date();
      await this.reapExpiredLeases(now);
      await this.reservoir.renewPublishedLeases();
      await this.activateDueCampaigns(now);
      // Reactivation deliberately keys off `throttledAt`, not `updatedAt`:
      // routine maintenance writes above (currentTps reset) and successful
      // sends (queueDepth decrements) touch `updatedAt` on Active routes as
      // part of normal operation, which would otherwise make a "has a full
      // second passed since throttling" check on `updatedAt` never fire.
      await db.update(campaignRoutesTable).set({ status: "Active", throttledAt: null }).where(and(
        eq(campaignRoutesTable.status, "Throttled"),
        isNotNull(campaignRoutesTable.throttledAt),
        sql`${campaignRoutesTable.throttledAt} < date_trunc('second', statement_timestamp())`,
      ));
    } catch (error) {
      logger.error({ error }, "Campaign runtime housekeeping failed");
    } finally {
      this.lastHousekeepingAt = new Date();
      this.housekeepingRunning = false;
    }
  }

  /** Milliseconds since housekeeping last completed, or `null` if it has never run. */
  heartbeatAgeMs(): number | null {
    if (!this.lastHousekeepingAt) return null;
    return Date.now() - this.lastHousekeepingAt.getTime();
  }

  /** Current ownership and backpressure state for every discovered phone. */
  phoneLaneMetrics(): PhoneLaneMetrics[] {
    return this.reservoir.metrics();
  }
  async acquireArchitecturePhones(
    organizationId: number,
    phoneNumberIds: number[],
    ttlMs = 5_000,
  ): Promise<Array<{ phoneNumberId: number; owned: boolean; fencingToken: number; validUntilMs: number; coordinationLatencyMs: number; shardId: number }>> {
    return Promise.all(phoneNumberIds.map(async (phoneNumberId) => {
      const lease = await this.pacingCoordinator.ensurePhoneOwnership({
        organizationId,
        phoneNumberId,
        ownerId: this.workerId,
        ttlMs,
      });
      if (lease.owned) this.worker.updateTransportOwnership(phoneNumberId, lease.fencingToken, lease.validUntilMs);
      return { phoneNumberId, ...lease, shardId: this.worker.transportShardForPhone(phoneNumberId) };
    }));
  }
  async releaseArchitecturePhone(organizationId: number, phoneNumberId: number, fencingToken: number): Promise<void> {
    this.worker.revokeTransportOwnership(phoneNumberId, fencingToken);
    await this.pacingCoordinator.releasePhoneOwnership({
      organizationId,
      phoneNumberId,
      ownerId: this.workerId,
    });
  }
  architectureTransportProbe(phoneNumberId: number) {
    return this.worker.architectureTransportProbe(phoneNumberId);
  }
  architectureDispatchMetrics() {
    return campaignDispatchMetrics.snapshot();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    if (this.stopping) return;
    this.ticking = true;
    try {
      // Production never invokes processBatchDetached: phone-owned reservoirs
      // discover lanes, reserve capacity, claim only their phone, prepare, and
      // independently drain their FIFO transport queues.
      await this.reservoir.tick();
    } catch (error) {
      logger.error({
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause }
          : error,
      }, "Campaign runtime tick failed");
    } finally {
      this.ticking = false;
    }
  }
}

let runtime: CampaignRuntime | undefined;

/** Explicit singleton lifecycle prevents duplicate hot-reload/test runners. */
export function startCampaignRuntime(): CampaignRuntime {
  runtime ??= new CampaignRuntime();
  runtime.start();
  return runtime;
}

export async function stopCampaignRuntime(): Promise<void> {
  await runtime?.stop();
  runtime = undefined;
}

/**
 * `/healthz` liveness reporting for the campaign runtime worker loop.
 * "not_started" only ever means this process never called
 * `startCampaignRuntime()` (e.g. a unit test importing this module without
 * booting the full server) -- it does not indicate a fault, so callers
 * should not treat it the same as "stale".
 */
export function getCampaignRuntimeHeartbeat(): { status: "ok" | "stale" | "not_started"; ageMs: number | null } {
  if (!runtime) return { status: "not_started", ageMs: null };
  const ageMs = runtime.heartbeatAgeMs();
  // Housekeeping's own interval is 200ms (or intervalMs if smaller); a
  // generous multiple of that -- rather than a tight bound -- avoids
  // false positives from ordinary GC pauses or a slow individual DB
  // round-trip inside one housekeeping pass, while still catching a
  // genuinely wedged/dead interval loop within a few seconds.
  const STALE_THRESHOLD_MS = 10_000;
  if (ageMs === null) {
    // start() fires an initial housekeeping run synchronously (fire-and-
    // forget) before returning, so this window is sub-millisecond in
    // practice -- but treat "started, first pass not yet landed" as ok
    // rather than stale to avoid flagging that instant as unhealthy.
    return { status: "ok", ageMs: null };
  }
  return { status: ageMs < STALE_THRESHOLD_MS ? "ok" : "stale", ageMs };
}
