import { and, asc, eq } from "drizzle-orm";
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
import {
  createPreparedDispatchBroker,
  type BrokerDelivery,
  type PreparedDispatchBroker,
} from "./campaign-prepared-broker";

const ACK_DEBT_LIMIT = 4_096;
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

  private async discover(): Promise<void> {
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
        continue;
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
      const abandoned = await this.broker.reclaimAbandoned(
        lane.phoneNumberId,
        `${lane.ownerId}:${lane.fencingToken}`,
        this.abandonedDeliveryMs,
        this.batchSize,
      );
      if (abandoned.length) {
        campaignDispatchMetrics.brokerRecovered(abandoned.length);
        for (const delivery of abandoned) {
          if (delivery.fencingToken === lane.fencingToken) continue;
          const envelope = this.worker.adoptPreparedEnvelope(delivery.envelope);
          await this.worker.abandonBrokerEnvelope(envelope);
          await this.broker.acknowledge(lane.phoneNumberId, [delivery.id]);
        }
      }
      lane.nextRecoveryAt = Date.now() + this.abandonedDeliveryMs;
    }

    await this.consume(lane);
    this.refillIfNeeded(lane);
    this.drain(lane);
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
          this.markSourceEmpty(lane);
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
        if (prepared.length < slots) {
          this.markSourceEmpty(lane);
          await this.consume(lane);
          this.drain(lane);
          break;
        }
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

  private markSourceEmpty(lane: PhoneLaneState): void {
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
    for (const delivery of deliveries) {
      const current = validByJobId.get(delivery.envelope.job.id);
      const envelope = this.worker.adoptPreparedEnvelope(current ?? delivery.envelope);
      const leaseExpiresAt = current?.job.leaseExpiresAt?.getTime() ?? 0;
      if (
        !current
        ||
        delivery.fencingToken !== lane.fencingToken
        || leaseExpiresAt <= checkedAt
      ) {
        await this.worker.discardReservoirEnvelope(envelope);
        await this.broker.acknowledge(lane.phoneNumberId, [delivery.id]);
        lane.brokerDepth = Math.max(0, lane.brokerDepth - 1);
        continue;
      }
      lane.queue.push({ delivery, envelope });
      lane.queued += 1;
    }
    lane.brokerConsumerLag = Math.max(0, lane.brokerConsumerLag - deliveries.length);
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

  private drain(lane: PhoneLaneState): void {
    if (lane.draining || this.stopping) return;
    lane.draining = true;
    const run = () => {
      while (
        !this.stopping
        && lane.queue.length
        && lane.providerInFlight < lane.capacity
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