import { and, asc, eq, inArray } from "drizzle-orm";
import { campaignRoutesTable, campaignsTable, db, phoneNumbersTable } from "@workspace/db";
import {
  type BrokerPreparedCampaignEnvelope,
  type CampaignWorker,
  type PreparedCampaignEnvelope,
} from "./campaign-queue";
import {
  MAX_PACING_REQUESTED,
  type AtomicPacingCoordinator,
} from "./campaign-pacing-coordinator";
import { campaignDispatchMetrics } from "./campaign-dispatch-metrics";
import { describePhoneScope } from "./campaign-phone-scope";
import { logger } from "../lib/logger";
import {
  createPreparedDispatchBroker,
  RECLAIM_CURSOR_START,
  type BrokerDelivery,
  type PreparedDispatchBroker,
} from "./campaign-prepared-broker";

const ACK_DEBT_LIMIT = 4_096;
// A dead consumer's pending entries are reclaimed one bounded page at a time
// and failed closed in one settlement transaction per campaign per page, so
// recovery never holds more than a page of envelopes and never issues one
// transaction per message. The round cap only guards against a broker that
// never reports the end of its pending list; a real pass ends at the cursor.
const MAX_RECLAIM_BATCH = 256;
const MAX_RECLAIM_ROUNDS = 1_024;
const ACK_RETRY_MIN_DELAY_MS = 25;
const ACK_RETRY_MAX_DELAY_MS = 1_000;
// The pacing coordinator rejects a reservation larger than its own bounded
// request size. Keep the reservoir's claim size aligned with that contract;
// otherwise a refill can fail before PostgreSQL is reached.
const MAX_SUPPLY_CLAIM_BATCH = Math.min(1_024, MAX_PACING_REQUESTED);
// Refill slots scale with the number of owned phone lanes, so no lane can be
// locked out of the supply plane, but stay bounded so a large fleet never
// opens an unbounded number of concurrent PostgreSQL claim sequences. Eight
// concurrent claims still leave the primary pool room for discovery,
// validation, and housekeeping.
const MIN_REFILL_CONCURRENCY = 2;
const MAX_REFILL_CONCURRENCY = 8;
// One claim -> prepare -> publish cycle per scheduler slot. A run that looped
// until its own lane reached high water could hold a shared slot forever:
// transport drains published work as fast as it arrives, so the high-water
// exit is never reached under continuous supply and every lane beyond the
// concurrency limit is starved permanently. Bounding the run and re-arming
// through refillIfNeeded keeps demand-driven watermark behaviour while
// guaranteeing the slot is returned to the lanes still waiting for it.
const MAX_REFILL_CYCLES_PER_SLOT = 1;
const SOURCE_EMPTY_MIN_BACKOFF_MS = 1_000;
// Smallest park for a lane that is only waiting for its own paced supply to
// come due. It exists to stop a zero/negative interval from becoming a busy
// loop; it is not a poll interval. The claim -> prepare -> publish round trip
// already clocks a lane far above this, so lowering it further would not add
// claims, and raising it would park a lane past work it is allowed to send.
const SOURCE_EMPTY_DUE_FLOOR_MS = 5;
const SOURCE_EMPTY_MAX_BACKOFF_MS = 30_000;

export type PhoneLaneMetrics = {
  organizationId: number;
  phoneNumberId: number;
  ownerId: string;
  shardId: number;
  fencingToken: number;
  ownershipValidUntilMs: number;
  coordinationLatencyMs: number;
  capacity: number;
  lowWater: number;
  highWater: number;
  queued: number;
  reserved: number;
  providerInFlight: number;
  refilling: boolean;
  refillDurationMs: number;
  emptyDelayMs: number;
  brokerDepth: number;
  brokerConsumerLag: number;
};

type PhoneLaneState = PhoneLaneMetrics & {
  queue: Array<{ delivery: BrokerDelivery; envelope: PreparedCampaignEnvelope }>;
  refill?: Promise<void>;
  service?: Promise<void>;
  draining: boolean;
  emptySince?: number;
  sourceEmptyUntil: number;
  sourceEmptyBackoffMs: number;
  nextRecoveryAt: number;
  nextMetricsAt: number;
  pendingAckIds: string[];
  ackInFlight: number;
  ackRetryDelayMs: number;
  nextAckRetryAt: number;
  ackFlush?: Promise<void>;
  ackFlushTimer?: NodeJS.Timeout;
  published: Map<string, BrokerPreparedCampaignEnvelope>;
  nextLeaseRenewalAt: number;
};

/**
 * The only production owner of claimed work.  A lane reserves its bounded
 * local capacity before PostgreSQL is touched, then retains ownership through
 * prepare, FIFO transport handoff, and durable settlement.
 */
export class CampaignPhoneReservoir {
  private readonly lanes = new Map<number, PhoneLaneState>();
  /** Phones inside the scope whose ownership another process currently holds (logged once per transition). */
  private readonly deniedPhones = new Set<number>();
  private readonly refillQueue: PhoneLaneState[] = [];
  private activeRefills = 0;
  private stopping = false;
  private readonly horizonSeconds = 3;

  constructor(
    private readonly worker: CampaignWorker,
    private readonly batchSize: number,
    private readonly coordinator: AtomicPacingCoordinator,
    private readonly ownerId: string,
    private readonly globalCapacity = 65_536,
    private readonly activePhoneIds?: ReadonlySet<number>,
    private readonly broker: PreparedDispatchBroker = createPreparedDispatchBroker(),
    private readonly abandonedDeliveryMs = 5_000,
  ) {}

  async tick(): Promise<void> {
    if (this.stopping) return;
    await this.discover();
    for (const lane of this.lanes.values()) this.service(lane);
  }

  metrics(): PhoneLaneMetrics[] {
    return [...this.lanes.values()].map(({
      queue: _queue,
      refill: _refill,
      service: _service,
      draining: _draining,
      sourceEmptyUntil: _sourceEmptyUntil,
      nextRecoveryAt: _nextRecoveryAt,
      nextMetricsAt: _nextMetricsAt,
      pendingAckIds: _pendingAckIds,
       ackInFlight: _ackInFlight,
       ackRetryDelayMs: _ackRetryDelayMs,
       nextAckRetryAt: _nextAckRetryAt,
      ackFlush: _ackFlush,
      ackFlushTimer: _ackFlushTimer,
       published: _published,
       nextLeaseRenewalAt: _nextLeaseRenewalAt,
      ...metrics
      // `lane.refilling` is the scheduler's enqueue guard: it is set while a
      // lane is only *waiting* for a supply slot. Report the observable fact
      // instead, so a queued lane is never mistaken for one that is actually
      // reaching PostgreSQL.
    }) => ({ ...metrics, refilling: Boolean(_refill) }));
  }

  async waitForIdle(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        this.activeRefills === 0
        && this.refillQueue.length === 0
        && [...this.lanes.values()].every((lane) =>
          !lane.refill && !lane.service && lane.queued === 0 && lane.providerInFlight === 0 && lane.brokerDepth === 0,
        )
      ) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return this.activeRefills === 0
      && this.refillQueue.length === 0
      && [...this.lanes.values()].every((lane) =>
        !lane.refill && !lane.service && lane.queued === 0 && lane.providerInFlight === 0 && lane.brokerDepth === 0,
      );
  }

  /**
   * Discovers the phones this runtime may own. With a scope, only phones in
   * the scope are read and asked for; an unscoped runtime keeps the original
   * behaviour and asks for every Running phone. Ownership inside the scope is
   * still decided by the coordinator's fenced lease, so two runtimes with an
   * overlapping scope never both own a phone: the loser is denied and simply
   * retries on the next tick until the lease is released or expires.
   */
  private async discover(): Promise<void> {
    if (this.activePhoneIds && this.activePhoneIds.size === 0) return;
    const scopeFilter = this.activePhoneIds
      ? [inArray(phoneNumbersTable.id, [...this.activePhoneIds])]
      : [];
    const discovered = await db.select({
      organizationId: phoneNumbersTable.organizationId,
      phoneNumberId: phoneNumbersTable.id,
      tps: phoneNumbersTable.tpsLimit,
    }).from(campaignRoutesTable)
      .innerJoin(campaignsTable, and(
        eq(campaignsTable.id, campaignRoutesTable.campaignId),
        eq(campaignsTable.organizationId, campaignRoutesTable.organizationId),
      ))
      .innerJoin(phoneNumbersTable, and(
        eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId),
        eq(phoneNumbersTable.organizationId, campaignRoutesTable.organizationId),
      ))
      .where(and(
        eq(campaignsTable.status, "Running"),
        eq(campaignsTable.killSwitch, false),
        eq(campaignRoutesTable.status, "Active"),
        ...scopeFilter,
      )).orderBy(asc(phoneNumbersTable.id));
    const active = this.activePhoneIds
      ? discovered.filter((phone) => this.activePhoneIds!.has(phone.phoneNumberId))
      : discovered;
    const activeIds = new Set(active.map((phone) => phone.phoneNumberId));
    for (const [phoneNumberId, lane] of this.lanes) {
      if (activeIds.has(phoneNumberId)) continue;
      await this.dropLane(lane, true);
    }
    for (const phone of active) {
      const ownership = await this.coordinator.ensurePhoneOwnership({
        organizationId: phone.organizationId,
        phoneNumberId: phone.phoneNumberId,
        ownerId: this.ownerId,
        ttlMs: 5_000,
      });
      campaignDispatchMetrics.ownershipCoordination(ownership.coordinationLatencyMs);
      const existing = this.lanes.get(phone.phoneNumberId);
      if (!ownership.owned) {
        if (existing) await this.dropLane(existing, false);
        campaignDispatchMetrics.phoneOwnershipDenied();
        if (!this.deniedPhones.has(phone.phoneNumberId)) {
          this.deniedPhones.add(phone.phoneNumberId);
          logger.info({
            phoneNumberId: phone.phoneNumberId,
            fencingToken: ownership.fencingToken,
            validUntilMs: ownership.validUntilMs,
            phoneScope: describePhoneScope(this.activePhoneIds),
          }, "Phone ownership held by another runtime; waiting for release or lease expiry");
        }
        continue;
      }
      if (this.deniedPhones.delete(phone.phoneNumberId)) {
        logger.info({ phoneNumberId: phone.phoneNumberId, fencingToken: ownership.fencingToken }, "Phone ownership acquired after another runtime released it");
      }
      if (existing && existing.fencingToken !== ownership.fencingToken) {
        await this.dropLane(existing, false);
      }
      this.worker.updateTransportOwnership(
        phone.phoneNumberId,
        ownership.fencingToken,
        ownership.validUntilMs,
      );
      const lane = this.lanes.get(phone.phoneNumberId);
      if (lane) {
        lane.ownershipValidUntilMs = ownership.validUntilMs;
        lane.coordinationLatencyMs = ownership.coordinationLatencyMs;
        continue;
      }
      const capacity = Math.max(1, Math.min(4_096, Math.ceil(phone.tps * this.horizonSeconds)));
      // Do not create an unbounded number of idle owners. Existing lanes keep
      // their fixed capacity; the global bound applies to all reservations.
      if (this.totalCapacity() + capacity > this.globalCapacity) continue;
      this.lanes.set(phone.phoneNumberId, {
        organizationId: phone.organizationId,
        phoneNumberId: phone.phoneNumberId,
        ownerId: this.ownerId,
        shardId: this.worker.transportShardForPhone(phone.phoneNumberId),
        fencingToken: ownership.fencingToken,
        ownershipValidUntilMs: ownership.validUntilMs,
        coordinationLatencyMs: ownership.coordinationLatencyMs,
        capacity,
        highWater: capacity,
        lowWater: Math.max(1, Math.floor(capacity / 2)),
        queued: 0,
        reserved: 0,
        providerInFlight: 0,
        refilling: false,
        refillDurationMs: 0,
        emptyDelayMs: 0,
        brokerDepth: 0,
        brokerConsumerLag: 0,
        queue: [],
        draining: false,
        sourceEmptyUntil: 0,
        sourceEmptyBackoffMs: 0,
        nextRecoveryAt: 0,
        nextMetricsAt: 0,
        pendingAckIds: [],
        ackInFlight: 0,
        ackRetryDelayMs: 0,
        nextAckRetryAt: 0,
        published: new Map(),
        nextLeaseRenewalAt: 0,
      });
    }
  }
  private async dropLane(lane: PhoneLaneState, releaseOwnership: boolean): Promise<void> {
    this.lanes.delete(lane.phoneNumberId);
    this.worker.revokeTransportOwnership(lane.phoneNumberId, lane.fencingToken);
    const queued = lane.queue.splice(0);
    lane.queued = 0;
    await Promise.allSettled(queued.map(async ({ delivery, envelope }) => {
      await this.worker.discardReservoirEnvelope(envelope);
      await this.broker.acknowledge(lane.phoneNumberId, [delivery.id]);
    }));
    if (releaseOwnership) {
      await this.coordinator.releasePhoneOwnership({
        organizationId: lane.organizationId,
        phoneNumberId: lane.phoneNumberId,
        ownerId: this.ownerId,
      });
    }
  }

  private totalCapacity(): number {
    return [...this.lanes.values()].reduce((sum, lane) => sum + lane.capacity, 0);
  }

  private service(lane: PhoneLaneState): void {
    if (lane.service || this.stopping) return;
    lane.service = this.serviceLane(lane).catch(() => {
      campaignDispatchMetrics.brokerFailure();
    }).finally(() => {
      lane.service = undefined;
    });
  }

  private async serviceLane(lane: PhoneLaneState): Promise<void> {
    const now = Date.now();
    if (now >= lane.nextMetricsAt) {
      const brokerMetrics = await this.broker.metrics(lane.phoneNumberId);
      lane.brokerDepth = Math.max(
        0,
        brokerMetrics.depth - lane.pendingAckIds.length - lane.ackInFlight,
      );
      lane.brokerConsumerLag = brokerMetrics.consumerLag;
      campaignDispatchMetrics.brokerState(lane.phoneNumberId, brokerMetrics.depth, brokerMetrics.consumerLag);
      lane.nextMetricsAt = now + 100;
    }

    if (now >= lane.nextRecoveryAt) {
      await this.recoverAbandoned(lane);
      lane.nextRecoveryAt = Date.now() + this.abandonedDeliveryMs;
    }

    await this.consume(lane);
    this.refillIfNeeded(lane);
    this.drain(lane);
  }

  /**
   * Fails closed every delivery a previous consumer of this phone left
   * pending. Deliveries carrying this lane's own fencing token are its own
   * in-progress work and are left alone. The rest were handed to a consumer
   * that is gone: the provider may already have been called, so they are
   * never re-sent; each is settled delivery-unknown and acknowledged only
   * once that settlement is durable. Settlement is batched per page and per
   * campaign; the decision for each job is unchanged. An acknowledgement
   * that fails after a durable settlement leaves the entry pending, and the
   * next pass settles it again as a no-op and acknowledges it, so recovery
   * is idempotent and retryable at every step.
   */
  private async recoverAbandoned(lane: PhoneLaneState): Promise<void> {
    const consumerId = `${lane.ownerId}:${lane.fencingToken}`;
    const pageSize = Math.max(1, Math.min(this.batchSize, MAX_RECLAIM_BATCH));
    let cursor = RECLAIM_CURSOR_START;
    for (let round = 0; round < MAX_RECLAIM_ROUNDS; round += 1) {
      const page = await this.broker.reclaimAbandoned(
        lane.phoneNumberId,
        consumerId,
        this.abandonedDeliveryMs,
        pageSize,
        cursor,
      );
      if (page.deliveries.length) {
        campaignDispatchMetrics.brokerRecovered(page.deliveries.length);
        const stale = page.deliveries.filter((delivery) => delivery.fencingToken !== lane.fencingToken);
        // Adopt in order. An envelope that cannot be adopted (no durable lease
        // token) stops the page exactly where the per-delivery loop stopped:
        // everything before it is still settled and acknowledged, nothing
        // after it is touched, and the error surfaces once that is durable.
        const envelopes: PreparedCampaignEnvelope[] = [];
        let adoption: unknown;
        try {
          for (const delivery of stale) envelopes.push(this.worker.adoptPreparedEnvelope(delivery.envelope));
        } catch (error) {
          adoption = error ?? new Error("Broker envelope could not be adopted");
        }
        if (envelopes.length) {
          const { settled, failure } = await this.worker.abandonBrokerEnvelopes(envelopes);
          const persisted = new Set(settled);
          await this.broker.acknowledge(
            lane.phoneNumberId,
            envelopes.flatMap((envelope, index) => persisted.has(envelope) ? [stale[index]!.id] : []),
          );
          if (failure !== undefined) throw failure;
        }
        if (adoption !== undefined) throw adoption;
      }
      cursor = page.cursor;
      if (cursor === RECLAIM_CURSOR_START || this.stopping) return;
    }
  }

  private refillIfNeeded(lane: PhoneLaneState): void {
    if (
      lane.refill
      || lane.refilling
      || this.stopping
      || Date.now() < lane.sourceEmptyUntil
      || this.readyDepth(lane) > lane.lowWater
      || lane.pendingAckIds.length + lane.ackInFlight >= ACK_DEBT_LIMIT
    ) return;
    lane.refilling = true;
    this.refillQueue.push(lane);
    this.pumpRefills();
  }

  /**
   * How many lanes may hold a supply slot at once. Every owned lane must be
   * able to reach PostgreSQL, otherwise lanes past the limit never claim at
   * all; the bounded maximum still stops a large fleet from opening one
   * concurrent claim sequence per phone.
   */
  private refillConcurrency(): number {
    return Math.min(
      MAX_REFILL_CONCURRENCY,
      Math.max(MIN_REFILL_CONCURRENCY, this.lanes.size),
    );
  }

  /**
   * Refills are demand-driven by each lane's watermark, but claims share a
   * small global scheduler. This prevents every phone from opening a long
   * PostgreSQL claim/prepare/publish sequence at the same time while still
   * allowing multiple lanes to keep the broker supplied.
   */
  private pumpRefills(): void {
    while (!this.stopping && this.activeRefills < this.refillConcurrency() && this.refillQueue.length) {
      const lane = this.refillQueue.shift()!;
      if (
        this.lanes.get(lane.phoneNumberId) !== lane
        || Date.now() < lane.sourceEmptyUntil
        || this.readyDepth(lane) > lane.lowWater
      ) {
        lane.refilling = false;
        continue;
      }
      this.activeRefills += 1;
      let failed = false;
      const refill = this.runRefill(lane).catch(() => {
        // Claimed leases are settled by the worker's preparation boundary; a
        // future watermark request may safely reserve a new bounded refill.
        failed = true;
      });
      lane.refill = refill;
      void refill.finally(() => {
        this.activeRefills -= 1;
        lane.refill = undefined;
        lane.refilling = false;
        // A bounded run can end with the lane still under its low-water mark.
        // Re-arm it here so supply stays continuous, but through the queue:
        // it re-enters behind lanes already waiting instead of immediately
        // reclaiming the slot it just released. A failed run is deliberately
        // not re-armed: it would retry at claim latency with no pause, and
        // every failure settles a whole claimed batch. Those lanes wait for
        // the next serviceLane pass, exactly as they did before.
        if (!failed) this.refillIfNeeded(lane);
        this.pumpRefills();
      });
    }
  }

  private async runRefill(lane: PhoneLaneState): Promise<void> {
    const refillStarted = Date.now();
    let cycles = 0;
    try {
      while (
        !this.stopping
        && cycles < MAX_REFILL_CYCLES_PER_SLOT
        && this.lanes.get(lane.phoneNumberId) === lane
        && Date.now() >= lane.sourceEmptyUntil
      ) {
        const slots = Math.min(
          MAX_SUPPLY_CLAIM_BATCH,
          lane.highWater - this.readyDepth(lane),
        );
        if (slots < 1) break;
        lane.reserved += slots;
        let prepared: PreparedCampaignEnvelope[] = [];
        try {
          const claimed = await this.worker.claimPhoneBatch(lane.phoneNumberId, slots);
          prepared = await this.worker.prepareReservoirBatch(claimed);
        } finally {
          lane.reserved = Math.max(0, lane.reserved - slots);
        }
        if (!prepared.length) {
          await this.markSourceEmpty(lane);
          await this.consume(lane);
          this.drain(lane);
          break;
        }
        if (this.stopping) {
          await Promise.all(prepared.map((envelope) => this.worker.discardReservoirEnvelope(envelope)));
          break;
        }
        if (this.lanes.get(lane.phoneNumberId) !== lane) {
          await Promise.all(prepared.map((envelope) => this.worker.discardReservoirEnvelope(envelope)));
          break;
        }
        if (lane.emptySince) {
          const starvationMs = Date.now() - lane.emptySince;
          lane.emptyDelayMs += starvationMs;
          campaignDispatchMetrics.reservoirStarvation(starvationMs);
          lane.emptySince = undefined;
        }
        const brokerEnvelopes = prepared.map(({ job, preparedContext }) => ({ job, preparedContext }));
        try {
          await this.broker.publish(lane.phoneNumberId, lane.fencingToken, brokerEnvelopes);
        } catch (error) {
          campaignDispatchMetrics.brokerFailure();
          // Redis may have committed XADD before the connection error was
          // observed. Release only process-local ownership; PostgreSQL's
          // exact lease and durable provider intent remain fail-closed.
          for (const envelope of prepared) this.worker.handoffPreparedEnvelope(envelope);
          throw error;
        }
        for (const envelope of prepared) {
          const brokerEnvelope = this.worker.handoffPreparedEnvelope(envelope);
          lane.published.set(this.publishedKey(brokerEnvelope), brokerEnvelope);
        }
        lane.brokerDepth += prepared.length;
        lane.brokerConsumerLag += prepared.length;
        campaignDispatchMetrics.brokerPublished(prepared.length);
        campaignDispatchMetrics.refill(prepared.length);
        await this.consume(lane);
        this.drain(lane);
        // A short batch is not an empty source. Claims only see rows whose
        // availableAt has arrived, and pacing stamps that time forward, so a
        // partial batch is the normal steady state for a phone whose next
        // jobs come due a few hundred milliseconds out. Arming the
        // source-empty ladder here put a lane to sleep for seconds while its
        // own paced supply was already waiting, and because the reset below
        // sat behind this break, only a full-size batch could ever lower the
        // ladder again: it ratcheted 1s -> 2s -> 4s -> 8s -> 16s instead of
        // recovering. A claim that yields nothing is the only evidence that
        // the source is actually empty, and it still arms the ladder above.
        lane.sourceEmptyBackoffMs = 0;
        cycles += 1;
      }
    } finally {
      lane.refillDurationMs = Date.now() - refillStarted;
      campaignDispatchMetrics.supplyRefill(lane.refillDurationMs);
    }
  }

  private readyDepth(lane: PhoneLaneState): number {
    // brokerDepth is the logical outstanding broker count: a published entry
    // remains counted until its ACK is queued. Do not add queue/provider
    // counters here, because they are already represented by that count.
    return lane.brokerDepth
      + lane.reserved;
  }

  /**
   * Park a lane whose claim came back with nothing.
   *
   * A claim only sees rows whose availableAt has arrived, and pacing stamps
   * that time forward, so an empty claim usually means "this phone's next
   * paced slice is a few hundred milliseconds out", not "this phone is
   * finished". Ask the source when its next job actually becomes due and
   * sleep exactly that long. The blind exponential ladder is kept only for
   * the case it was written for -- a phone with no future work at all --
   * where it is what stops an idle fleet from polling PostgreSQL.
   *
   * This reads availableAt to schedule a wake-up. It does not move it, and it
   * does not let a lane claim a job earlier than pacing allows: the claim
   * predicate is still the authority on what may be taken.
   */
  private async markSourceEmpty(lane: PhoneLaneState): Promise<void> {
    let dueInMs: number | undefined;
    try {
      dueInMs = await this.worker.nextPhoneSupplyDueInMs(lane.phoneNumberId);
    } catch {
      // An unavailable answer is not evidence of an empty source. Fall
      // through to the ladder, which is the previous behaviour.
      dueInMs = undefined;
    }
    if (dueInMs !== undefined) {
      // Work exists; only its release time is pending. The ladder must not
      // carry over, or a lane that keeps finding work would still ratchet.
      lane.sourceEmptyBackoffMs = 0;
      lane.sourceEmptyUntil = Date.now() + Math.min(
        SOURCE_EMPTY_MAX_BACKOFF_MS,
        Math.max(SOURCE_EMPTY_DUE_FLOOR_MS, dueInMs),
      );
      return;
    }
    lane.sourceEmptyBackoffMs = Math.min(
      SOURCE_EMPTY_MAX_BACKOFF_MS,
      Math.max(SOURCE_EMPTY_MIN_BACKOFF_MS, (lane.sourceEmptyBackoffMs || 0) * 2),
    );
    lane.sourceEmptyUntil = Date.now() + lane.sourceEmptyBackoffMs;
  }

  private async consume(lane: PhoneLaneState): Promise<void> {
    const available = Math.min(
      this.batchSize,
      lane.capacity - lane.providerInFlight - lane.queued
        - lane.pendingAckIds.length - lane.ackInFlight,
    );
    if (available < 1) return;
    const deliveries = await this.broker.consume(
      lane.phoneNumberId,
      `${lane.ownerId}:${lane.fencingToken}`,
      available,
    );
    if (!deliveries.length) return;
    for (const delivery of deliveries) {
      lane.published.delete(this.publishedKey(delivery.envelope));
    }
    campaignDispatchMetrics.brokerConsumed(deliveries.length);
    // Preparation is the durable authorization boundary, but a prepared
    // envelope may sit in the broker while a campaign is paused or its lease
    // is replaced. Validate the whole delivery batch immediately before
    // adoption so stale broker work is discarded before it can reach the
    // provider. This is one bounded query per batch, not one query per send.
    const validation = await this.worker.validatePreparedBrokerEnvelopes(
      deliveries.map((delivery) => delivery.envelope),
    );
    const validByJobId = new Map(validation.valid.map((envelope) => [envelope.job.id, envelope]));
    const checkedAt = Date.now();
    // Stale deliveries (a dead owner's fencing token, a replaced or expired
    // lease, a campaign that is no longer sendable) were never handed to the
    // provider. They are discarded as one page: one aborted settlement per
    // campaign and one acknowledgement, instead of one of each per envelope.
    // A dead runtime leaves whole published claim batches unread, and under
    // live settlement each per-row discard waited on the campaign lock, so
    // 256 of them blocked the lane for over half a minute.
    const stale: Array<{ delivery: BrokerDelivery; envelope: PreparedCampaignEnvelope }> = [];
    for (const delivery of deliveries) {
      const current = validByJobId.get(delivery.envelope.job.id);
      const leaseExpiresAt = current?.job.leaseExpiresAt?.getTime() ?? 0;
      const isStale = !current
        || delivery.fencingToken !== lane.fencingToken
        || leaseExpiresAt <= checkedAt;
      // A stale delivery is settled under the lease it was published with,
      // never under whatever lease the job holds now: the validated row is
      // keyed by job id, so a page holding both a dead owner's envelope and
      // this lane's fresh envelope for the same job would otherwise revoke
      // the fresh lease and let the queued fresh envelope send unfenced.
      const envelope = this.worker.adoptPreparedEnvelope(isStale ? delivery.envelope : current!);
      if (isStale) {
        stale.push({ delivery, envelope });
        continue;
      }
      lane.queue.push({ delivery, envelope });
      lane.queued += 1;
    }
    lane.brokerConsumerLag = Math.max(0, lane.brokerConsumerLag - deliveries.length);
    if (stale.length) {
      const { settled, failure } = await this.worker.discardReservoirEnvelopes(stale.map(({ envelope }) => envelope));
      const persisted = new Set(settled);
      const acknowledged = stale.filter(({ envelope }) => persisted.has(envelope));
      await this.broker.acknowledge(lane.phoneNumberId, acknowledged.map(({ delivery }) => delivery.id));
      lane.brokerDepth = Math.max(0, lane.brokerDepth - acknowledged.length);
      if (failure !== undefined) throw failure;
    }
  }

  private publishedKey(envelope: BrokerPreparedCampaignEnvelope): string {
    return `${envelope.job.id}:${envelope.job.leaseToken ?? ""}`;
  }

  async renewPublishedLeases(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    const due = [...this.lanes.values()].filter((lane) =>
      lane.published.size > 0 && now >= lane.nextLeaseRenewalAt,
    );
    if (!due.length) return;
    const envelopes = due.flatMap((lane) => [...lane.published.values()]);
    await this.worker.renewBrokerLeases(envelopes);
    const next = Date.now() + this.worker.brokerLeaseRenewalIntervalMs;
    for (const lane of due) lane.nextLeaseRenewalAt = next;
  }

  private scheduleAckFlush(lane: PhoneLaneState): void {
    if (lane.ackFlush || lane.ackFlushTimer || !lane.pendingAckIds.length) return;
    const retryDelay = Math.max(0, lane.nextAckRetryAt - Date.now());
    const batchingDelay = lane.pendingAckIds.length >= 64 ? 0 : 5;
    lane.ackFlushTimer = setTimeout(() => {
      lane.ackFlushTimer = undefined;
      void this.flushAcks(lane);
    }, Math.max(retryDelay, batchingDelay));
    lane.ackFlushTimer.unref();
  }

  private queueAck(lane: PhoneLaneState, id: string): void {
    lane.pendingAckIds.push(id);
    // The provider has finished this delivery, so release the logical
    // reservoir slot immediately. The broker entry remains pending until the
    // batched ACK completes; sampling subtracts both pending and in-flight
    // ACKs, and a failed ACK remains pending for retry.
    lane.brokerDepth = Math.max(0, lane.brokerDepth - 1);
    if (lane.pendingAckIds.length >= 64) {
      void this.flushAcks(lane);
    } else {
      this.scheduleAckFlush(lane);
    }
  }

  private async flushAcks(lane: PhoneLaneState): Promise<void> {
    if (lane.ackFlush || !lane.pendingAckIds.length) return;
    if (Date.now() < lane.nextAckRetryAt) {
      this.scheduleAckFlush(lane);
      return;
    }
    const ids = lane.pendingAckIds.splice(0, 64);
    lane.ackInFlight += ids.length;
    lane.ackFlush = (async () => {
      try {
        await this.broker.acknowledge(lane.phoneNumberId, ids);
        lane.ackRetryDelayMs = 0;
        lane.nextAckRetryAt = 0;
      } catch {
        // Provider transport has already completed, so keep the IDs pending.
        // A later flush or broker recovery can safely settle them; losing the
        // IDs here would leave Redis PEL entries permanently pending.
        lane.pendingAckIds.unshift(...ids);
        lane.ackRetryDelayMs = Math.min(
          ACK_RETRY_MAX_DELAY_MS,
          Math.max(ACK_RETRY_MIN_DELAY_MS, lane.ackRetryDelayMs * 2),
        );
        lane.nextAckRetryAt = Date.now() + lane.ackRetryDelayMs;
        campaignDispatchMetrics.brokerFailure();
      } finally {
        lane.ackInFlight -= ids.length;
        lane.ackFlush = undefined;
        if (lane.pendingAckIds.length >= 64) void this.flushAcks(lane);
        else this.scheduleAckFlush(lane);
      }
    })();
    await lane.ackFlush;
  }

  /**
   * Each lane may hold at most its share of the worker's durable-outcome
   * capacity in transport. The capacity is reserved when an envelope leaves
   * the lane and held until its batch settles, so without a per-lane bound a
   * few lanes whose provider completions keep re-triggering drain() take
   * every released slot within microseconds, while a lane with nothing in
   * flight only retries on the service tick and loses every race: measured
   * as one of four phones starving for 8-13s at a time behind a full pool.
   * The pool size is unchanged; it is only partitioned across owned lanes.
   */
  private settlementShare(): number {
    return Math.max(1, Math.floor(this.worker.settlementSlotCapacity() / Math.max(1, this.lanes.size)));
  }

  private drain(lane: PhoneLaneState): void {
    if (lane.draining || this.stopping) return;
    lane.draining = true;
    const share = this.settlementShare();
    const run = () => {
      while (
        !this.stopping
        && lane.queue.length
        && lane.providerInFlight < lane.capacity
        && lane.providerInFlight < share
        && lane.pendingAckIds.length + lane.ackInFlight < ACK_DEBT_LIMIT
      ) {
        // Take durable-outcome capacity before the envelope leaves the lane.
        // A saturated settlement plane must stop work *entering* transport;
        // it must never abort work that is already claimed, prepared and
        // leased, because that abort takes the campaigns row settlement needs
        // to commit and release capacity. Leaving the envelope queued keeps
        // its exact lease and its broker entry intact, and the next service
        // tick or provider completion retries it for free.
        if (!this.worker.tryReserveSettlementSlot()) break;
        const { delivery, envelope } = lane.queue.shift()!;
        lane.queued -= 1;
        if (lane.queued === 0) lane.emptySince = Date.now();
        lane.providerInFlight += 1;
        // No await here: dequeue through transport start is exclusively the
        // worker's transport boundary, with no reservoir database operation.
        void this.worker.dispatchReservoirEnvelope(envelope, new Date(), true).finally(async () => {
          lane.providerInFlight -= 1;
          this.queueAck(lane, delivery.id);
          this.service(lane);
          this.drain(lane);
        });
      }
      lane.draining = false;
    };
    run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.refillQueue.length = 0;
    const work: Promise<void>[] = [];
    for (const lane of this.lanes.values()) {
      this.worker.revokeTransportOwnership(lane.phoneNumberId, lane.fencingToken);
      if (lane.refill) work.push(lane.refill);
      if (lane.service) work.push(lane.service);
      if (lane.ackFlushTimer) {
        clearTimeout(lane.ackFlushTimer);
        lane.ackFlushTimer = undefined;
      }
      if (lane.pendingAckIds.length) work.push(this.flushAcks(lane));
      while (lane.queue.length) {
        const { delivery, envelope } = lane.queue.shift()!;
        work.push((async () => {
          await this.worker.discardReservoirEnvelope(envelope);
          await this.broker.acknowledge(lane.phoneNumberId, [delivery.id]);
        })());
      }
      lane.queued = 0;
    }
    await Promise.allSettled(work);
    // Runtime.stop aborts the in-flight registrations before calling here.
    // Wait for those provider tasks to enqueue their final ACKs before the
    // broker connection is closed. A bounded wait still leaves exact durable
    // leases for normal recovery if a provider never returns.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const pending = [...this.lanes.values()].filter((lane) =>
        lane.providerInFlight > 0 || lane.ackFlush || lane.pendingAckIds.length > 0,
      );
      if (!pending.length) break;
      await Promise.race([
        ...pending.flatMap((lane) => lane.ackFlush ? [lane.ackFlush] : []),
        new Promise<void>((resolve) => setTimeout(resolve, 10)),
      ]);
    }
    const finalAcks: Promise<void>[] = [];
    for (const lane of this.lanes.values()) {
      if (!lane.pendingAckIds.length) continue;
      lane.nextAckRetryAt = 0;
      finalAcks.push(this.flushAcks(lane));
    }
    await Promise.allSettled(finalAcks);
    await Promise.allSettled([...this.lanes.values()].map((lane) =>
      this.coordinator.releasePhoneOwnership({
        organizationId: lane.organizationId,
        phoneNumberId: lane.phoneNumberId,
        ownerId: this.ownerId,
      }),
    ));
    this.lanes.clear();
    await this.broker.close();
  }
}