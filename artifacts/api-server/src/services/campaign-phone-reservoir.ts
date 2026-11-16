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
import { campaignDispatchMetrics, type ReservoirStarvationCause } from "./campaign-dispatch-metrics";
import { describePhoneScope } from "./campaign-phone-scope";
import { PhoneAssignmentController, UnownedPhoneTracker } from "./campaign-phone-assignment";
import { isPhoneAssignmentStore, type PhoneOwnershipRef } from "./campaign-pacing-coordinator";
import { logger } from "../lib/logger";
import {
  BrokerStreamResetError,
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
// Decision 3: how long a lost-entry check waits for a stream read already in flight before leaving it to the next
// recovery pass.
const LOST_SCAN_READ_WAIT_MS = 250;
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
/**
 * V2-372. A phone whose workspace credential fails to bind is retried after 1, 2, 4 ... up to 30 s instead of on
 * every 100 ms tick (each attempt reads and decrypts the credential), and for 10 minutes this runtime does not ask
 * another cell to hand the phone over, so automatic assignment cannot bounce it back to a cell that cannot send it.
 */
const BIND_RETRY_MIN_MS = 1_000;
const BIND_RETRY_MAX_MS = 30_000;
const BIND_FAILURE_REQUEST_COOLDOWN_MS = 10 * 60_000;
/** V2-372. Static scopes: how often every sendable phone is checked for an owner, and when one without is reported. */
const UNOWNED_CHECK_INTERVAL_MS = 10_000;
const UNOWNED_ALERT_MS = 20_000;
/**
 * V2-372. A handoff that has not drained after handoffMaxMs stops sending new work and requeues what never reached
 * transport, but keeps its lease until the sends already in transport have finished (revoking transport ownership
 * aborts their HTTP calls, which then end delivery-unknown). Only after this much more time is the lane dropped
 * regardless, as any lane that loses its phone is.
 */
const HANDOFF_TRANSPORT_GRACE_MS = 120_000;
// Structured failure logs for the broker and supply plane (lane service,
// refill, broker acknowledgement). They record failures, never per-message
// progress: a broker outage fails every service pass of every lane (one per
// tick), so at most one line per lane and kind is written per window, and it
// says how many repeats it stands for. Counters (campaignDispatchMetrics)
// still count every failure.
const FAILURE_LOG_WINDOW_MS = 30_000;
type LaneFailureKind = "service" | "refill" | "ack" | "renewal" | "unusable" | "dispatch";
const LANE_FAILURE_MESSAGES: Record<LaneFailureKind, string> = {
  service: "Campaign reservoir lane service failed (broker consume, recovery or metrics); the lane retries on its next pass",
  refill: "Campaign reservoir refill failed (claim, prepare or publish); claimed work keeps its exact lease for recovery",
  ack: "Campaign broker acknowledgement failed; the delivery ids stay pending and are retried",
  renewal: "Campaign queued lease re-check or renewal failed; the lane's queued work is not renewed and the pass is retried",
  unusable: "Campaign broker deliveries without a durable lease cannot be adopted; they were never sent and are acknowledged and dropped",
  dispatch: "Campaign dispatch could not record its outcome (settlement failed); the job keeps its exact lease and the reaper settles it fail-closed",
};
/**
 * Queued envelopes re-checked and renewed per statement group. Bounds each
 * statement's bind parameters (one per job, two per distinct recipient in the
 * suppression lookup) far below PostgreSQL's 65,535, whatever the total lane
 * capacity (65,536 by default).
 */
const QUEUED_RENEWAL_CHUNK = 1_000;

export type PhoneLaneMetrics = {
  organizationId: number;
  phoneNumberId: number;
  /** Workspace credential bound for transport on this lane, or null (no credential: mock workspaces only). */
  sendingCredentialId: number | null;
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

/**
 * A consumed, adopted envelope waiting in a lane for transport.
 * `leaseValidUntilMs` is a lower bound on its exact lease's expiry, as last
 * read from PostgreSQL (at adoption, then at every renewal-time re-check).
 * drain() never hands the provider an envelope whose bound has passed.
 */
type QueuedEnvelope = {
  delivery: BrokerDelivery;
  envelope: PreparedCampaignEnvelope;
  leaseValidUntilMs: number;
};

type PhoneLaneState = PhoneLaneMetrics & {
  /**
   * Set first thing in dropLane(). A dropped lane never services, drains or adopts again: a pass already in
   * flight on it (a consume whose read or validation was awaiting when the lane dropped) discards what it
   * got as not started instead of queuing it. dropLane() settles the lane's unconsumed envelopes as requeued,
   * and transport stamps the phone's *current* ownership token, so a delivery adopted and drained by the
   * dropped lane could otherwise reach the provider after its job was requeued, and be sent again.
   */
  dropped?: boolean;
  queue: QueuedEnvelope[];
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
  /**
   * B13 R2. Broker entries of a previous consumer that the last recovery pass left pending: deferred under a
   * live lease (Decision 8) or not yet durably settled. They stay in the stream, so they count in XLEN, but they
   * are not this lane's supply and are never sent by it.
   */
  deferredDeliveryIds?: Set<string>;
  /** B13 R5: the lane's state when its queue last went empty (see ReservoirStarvationCause). */
  emptyCause?: ReservoirStarvationCause;
  /** B13 R4: wakes drain() when the queue head comes inside the transport admission horizon. */
  drainTimer?: NodeJS.Timeout;
  /** V2-372: when this runtime built the lane (local clock); a lane is never handed off before minHoldMs. */
  acquiredAt: number;
  /** V2-372: deliveries read from the broker (pending under this lane's consumer) not yet queued or acknowledged. */
  unadopted: BrokerDelivery[];
  /** V2-372: the subset of `unadopted` a consume pass is processing right now (exclusive per delivery). */
  adopting: Set<BrokerDelivery>;
  /** P1: the phone's provider-approved TPS (sets the read-ahead bound); absent on hand-built test lanes. */
  tps?: number;
  /** P1: entries a stream read now in progress may still add (reserved synchronously, before the read awaits). */
  consumeReserved?: number;
  /** P1: smoothed duration of one consume pass (read, validation, adoption), ms; widens the read-ahead target. */
  consumeLatencyMs?: number;
  /**
   * P1: the abandoned-delivery recovery pass, running detached from the service pass. Awaited in line, a long
   * recovery (a dead owner's whole pending list, settled under campaign locks) held up the next read, and with
   * only the read-ahead queued the phone stopped sending.
   */
  recovery?: Promise<void>;
  /**
   * Decision 3: a consume read failed after it may have reached Redis. Its reply may have been lost with entries
   * already delivered to this consumer; the next recovery pass scans this consumer's pending list for them.
   */
  consumeReplyUncertain?: boolean;
  /**
   * Decision 3: set while recovery decides which published entries are lost. No consume pass reads the stream
   * meanwhile, so an entry cannot be delivered to this lane between that decision and its settlement.
   */
  lostScan?: boolean;
  /** Decision 3: a recovery pass was requested while one may be running; that one's end must not defer it. */
  recoveryRequested?: boolean;
  /**
   * V2-372 graceful handoff to the phone's assigned cell: no new claims (refill is gated), already prepared work
   * is still consumed and sent, and the lease is released once the lane is empty (or after handoffMaxMs).
   */
  handoff?: { since: number; to: string; expired?: boolean };
  /** V2-372: an expired handoff's settlement of unsent work, running detached from the discovery tick. */
  settling?: Promise<void>;
};

/** V2-372: what a discovery pass does with a lane in handoff, after every lease has been renewed. */
type HandoffAction = "none" | "settle" | "release" | "force-release";

type SendablePhone = {
  organizationId: number;
  phoneNumberId: number;
  tps: number;
  sendingCredentialId: number | null;
};

/**
 * B13 R4. An envelope enters transport, taking its durable-settlement slot, only when its paced send time is at
 * most this far away. Pacing reserves send slots up to PACING_LOOKAHEAD_MS (3 s) ahead, and on 2884382f drain()
 * handed every queued envelope to transport at once, where it held a settlement slot while it waited in shard
 * pacing: at the 1,000/s per-phone ceiling that wanted ~3,000 slots per phone against a 1,024-slot share, so the
 * pool sat full and every drain probe was refused. The envelope now waits in the lane, where its lease is still
 * renewed; the shard receives it well before its slot (ticks and this timer run every 20-100 ms).
 */
export const TRANSPORT_ADMISSION_HORIZON_MS = 500;

/** The paced send time of a job in epoch ms; work with no reserved slot is due now. */
function scheduledSendAtMs(job: { scheduledSendAt?: Date | string | null }): number {
  if (!job.scheduledSendAt) return Number.NEGATIVE_INFINITY;
  const at = new Date(job.scheduledSendAt).getTime();
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * The only production owner of claimed work.  A lane reserves its bounded
 * local capacity before PostgreSQL is touched, then retains ownership through
 * prepare, FIFO transport handoff, and durable settlement.
 */
export class CampaignPhoneReservoir {
  private readonly lanes = new Map<number, PhoneLaneState>();
  /** Phones inside the scope whose ownership another process currently holds (logged once per transition). */
  private readonly deniedPhones = new Set<number>();
  /** Phones whose workspace credential could not be bound (logged once per transition). */
  private readonly unboundPhones = new Set<number>();
  private readonly refillQueue: PhoneLaneState[] = [];
  private activeRefills = 0;
  private stopping = false;
  /** Last failure log per `${phoneNumberId}:${kind}` and the repeats since (see FAILURE_LOG_WINDOW_MS). */
  private readonly failureLog = new Map<string, { lastAt: number; repeats: number }>();
  private readonly horizonSeconds = 3;
  /** V2-372: phones whose credential failed to bind, per credential, with the retry schedule. */
  private readonly bindFailures = new Map<number, { credentialId: number | null; failures: number; retryAt: number; lastFailureAt: number }>();
  /** V2-372: phones not taken because the reservoir's global capacity was full (logged once per transition). */
  private readonly capacityRefused = new Set<number>();
  /**
   * V2-372: lane teardowns running detached from the discovery tick, per phone. While one runs, discovery neither
   * renews nor acquires that phone, so no lane can be rebuilt for it (possibly under the same fencing token, which
   * would read the stream entries being settled) until its work is settled and its lease released.
   */
  private readonly teardowns = new Map<number, Promise<void>>();
  /** V2-372: phones whose transport shard failed (logged once). */
  private readonly failedShardPhones = new Set<number>();
  /** V2-372: static scopes only; reports a sendable phone no runtime owns (for example, in no cell's scope). */
  private readonly staticUnowned?: UnownedPhoneTracker;
  private nextUnownedCheckAt = 0;
  private lastAssignmentFailureLogAt = Number.NEGATIVE_INFINITY;

  /** The worker's preparation headroom; a worker without the hook is unbounded, as a sender without it is. */
  private preparationHeadroom(): number {
    const worker = this.worker as Partial<Pick<CampaignWorker, "preparationHeadroom">>;
    return typeof worker.preparationHeadroom === "function" ? worker.preparationHeadroom.call(this.worker) : Number.POSITIVE_INFINITY;
  }

  constructor(
    private readonly worker: CampaignWorker,
    private readonly batchSize: number,
    private readonly coordinator: AtomicPacingCoordinator,
    private readonly ownerId: string,
    private readonly globalCapacity = 65_536,
    private readonly activePhoneIds?: ReadonlySet<number>,
    private readonly broker: PreparedDispatchBroker = createPreparedDispatchBroker(),
    private readonly abandonedDeliveryMs = 5_000,
    /** V2-372 automatic assignment; mutually exclusive with a static scope. */
    private readonly assignment?: PhoneAssignmentController,
    /** V2-372, static scopes: how long a sendable phone may have no owner before it is reported. */
    private readonly unownedAlertMs = UNOWNED_ALERT_MS,
    /**
     * P1 (crash ambiguity): read from the phone's stream only about this much traffic beyond what drain() has
     * admitted, instead of up to the lane's 3 s capacity. Work left unread is not pending under this process, so
     * after a crash the successor discards it as never sent instead of failing it as delivery-unknown.
     * Undefined keeps the earlier read size (hand-built test reservoirs); CampaignRuntime passes
     * CAMPAIGN_RESERVOIR_CONSUME_AHEAD_MS (default 250).
     */
    private readonly consumeAheadMs?: number,
  ) {
    if (assignment && activePhoneIds) throw new Error("Automatic phone assignment cannot be combined with a static phone scope");
    if (activePhoneIds && isPhoneAssignmentStore(coordinator)) {
      this.staticUnowned = new UnownedPhoneTracker(unownedAlertMs, () => ({
        mode: "static",
        phoneScope: describePhoneScope(activePhoneIds),
        hint: "a phone in no cell's CAMPAIGN_TRANSPORT_PHONE_IDS is never sent; CAMPAIGN_TRANSPORT_ASSIGNMENT=auto removes scopes",
      }));
    }
  }

  /** V2-372: the automatic assignment's view, or undefined for static and unscoped runtimes. */
  assignmentStatus() {
    return this.assignment?.status();
  }

  /** V2-372: sendable phones with no owner past the alert threshold (static mode: as seen from this runtime). */
  unownedPhoneIds(): number[] {
    return this.assignment?.status().unownedPhoneIds ?? this.staticUnowned?.unownedPhoneIds() ?? [];
  }

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
      acquiredAt: _acquiredAt,
      handoff: _handoff,
      settling: _settling,
      unadopted: _unadopted,
      adopting: _adopting,
      tps: _tps,
      consumeReserved: _consumeReserved,
      consumeLatencyMs: _consumeLatencyMs,
      recovery: _recovery,
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
        && this.teardowns.size === 0
        && [...this.lanes.values()].every((lane) =>
          !lane.refill && !lane.service && !lane.recovery && !lane.settling && lane.queued === 0 && lane.providerInFlight === 0 && lane.brokerDepth === 0,
        )
      ) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return this.activeRefills === 0
      && this.refillQueue.length === 0
      && this.teardowns.size === 0
      && [...this.lanes.values()].every((lane) =>
        !lane.refill && !lane.service && !lane.recovery && !lane.settling && lane.queued === 0 && lane.providerInFlight === 0 && lane.brokerDepth === 0,
      );
  }

  /**
   * Connected phones with at least one Active route of a Running, not killed campaign, once each (V2-372: the
   * query yields one row per route, and every row used to cost its own ownership round trip), ordered by id.
   */
  private async sendablePhones(scope: ReadonlySet<number> | undefined): Promise<SendablePhone[]> {
    const scopeFilter = scope
      ? [inArray(phoneNumbersTable.id, [...scope])]
      : [];
    const rows = await db.select({
      organizationId: phoneNumbersTable.organizationId,
      phoneNumberId: phoneNumbersTable.id,
      tps: phoneNumbersTable.tpsLimit,
      sendingCredentialId: phoneNumbersTable.sendingCredentialId,
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
        // Only a sendable phone may hold a transport lane. Credential
        // revocation flips a workspace-credential phone to Pending, so the
        // next discovery drops its lane through the normal fencing path.
        eq(phoneNumbersTable.status, "Connected"),
        ...scopeFilter,
      )).orderBy(asc(phoneNumbersTable.id));
    const seen = new Set<number>();
    return rows.filter((phone) => !seen.has(phone.phoneNumberId) && Boolean(seen.add(phone.phoneNumberId)));
  }

  /** The lane capacity a phone needs: its provider-approved TPS over the preparation horizon, bounded. */
  private laneCapacity(tps: number): number {
    return Math.max(1, Math.min(4_096, Math.ceil(tps * this.horizonSeconds)));
  }

  /**
   * Whether this runtime may take a phone it has no lane for. "acquire": ask the coordinator now. "request": ask
   * another cell to hand it over (automatic mode). A phone that does not fit the global capacity is never acquired:
   * before V2-372 the lease was taken first and the lane then refused, so the runtime renewed a lease it could not
   * use, every tick, and no other runtime could send the phone either.
   */
  private mayTake(phone: SendablePhone, purpose: "acquire" | "request"): boolean {
    if (this.shardFailure(phone.phoneNumberId)) return false;
    const capacity = this.laneCapacity(phone.tps);
    if (this.totalCapacity() + capacity > this.globalCapacity) {
      if (purpose === "acquire") this.noteCapacityRefused(phone, capacity);
      return false;
    }
    const failure = this.bindFailures.get(phone.phoneNumberId);
    if (failure && failure.credentialId === phone.sendingCredentialId) {
      const now = Date.now();
      if (purpose === "acquire" ? now < failure.retryAt : now - failure.lastFailureAt < BIND_FAILURE_REQUEST_COOLDOWN_MS) return false;
    }
    return true;
  }

  /**
   * V2-372. A lane's capacity and watermarks were fixed when it was built, so a phone whose provider-approved TPS
   * was raised (Meta sync, for example 80 to 1,000) stayed capped at its old in-flight bound until the lane was
   * rebuilt. The lane now follows the phone's current TPS, within the global capacity; a reduction only lowers
   * the bounds, and work already in flight finishes normally.
   */
  private resizeLane(lane: PhoneLaneState, phone: SendablePhone): void {
    lane.tps = phone.tps;
    const capacity = this.laneCapacity(phone.tps);
    if (capacity === lane.capacity) return;
    if (capacity > lane.capacity && this.totalCapacity() - lane.capacity + capacity > this.globalCapacity) return;
    logger.info({
      organizationId: lane.organizationId,
      phoneNumberId: lane.phoneNumberId,
      tps: phone.tps,
      fromCapacity: lane.capacity,
      toCapacity: capacity,
    }, "Phone lane resized to its current provider-approved TPS");
    lane.capacity = capacity;
    lane.highWater = capacity;
    lane.lowWater = Math.max(1, Math.floor(capacity / 2));
  }

  /** The failure of the phone's transport shard; a worker without the hook (test doubles) never fails. */
  private shardFailure(phoneNumberId: number): Error | undefined {
    const worker = this.worker as Partial<Pick<CampaignWorker, "transportShardFailure">>;
    return typeof worker.transportShardFailure === "function" ? worker.transportShardFailure.call(this.worker, phoneNumberId) : undefined;
  }

  /**
   * V2-372. A transport shard thread that died is not replaced in this process, so the phones pinned to it can no
   * longer send from here. Their lanes are dropped and their leases released, once, so another runtime (automatic
   * mode, or an overlapping scope) can take them; with static scopes they are reported unowned. Restarting the
   * process restores the shard.
   */
  private releaseFailedShardPhones(active: ReadonlyArray<SendablePhone>): void {
    for (const phone of active) {
      const failure = this.shardFailure(phone.phoneNumberId);
      if (!failure) continue;
      const lane = this.lanes.get(phone.phoneNumberId);
      if (lane) this.startTeardown(phone.phoneNumberId, () => this.dropLane(lane, true));
      if (this.failedShardPhones.has(phone.phoneNumberId)) continue;
      this.failedShardPhones.add(phone.phoneNumberId);
      logger.error({
        organizationId: phone.organizationId,
        phoneNumberId: phone.phoneNumberId,
        shardId: this.worker.transportShardForPhone(phone.phoneNumberId),
        error: failure.message,
      }, "Transport shard has failed; phone released so another runtime can send it. Restart this process to restore the shard");
    }
  }

  /**
   * V2-372. Starts a lane teardown (dropLane or a handoff release) without awaiting it. The synchronous part of
   * dropLane runs at once (the lane is marked dropped, removed and its transport ownership revoked); settling its
   * unsent work and releasing its lease continue off the discovery tick. Errors are logged; exact leases are left
   * for recovery, as an awaited teardown left them.
   */
  private startTeardown(phoneNumberId: number, work: () => Promise<void>): void {
    if (this.teardowns.has(phoneNumberId)) return;
    const run = work()
      .catch((error: unknown) => {
        logger.error({ error, phoneNumberId }, "Campaign lane teardown failed; its exact leases are left for recovery");
      })
      .finally(() => { this.teardowns.delete(phoneNumberId); });
    this.teardowns.set(phoneNumberId, run);
  }

  private noteCapacityRefused(phone: SendablePhone, capacity: number): void {
    if (this.capacityRefused.has(phone.phoneNumberId)) return;
    this.capacityRefused.add(phone.phoneNumberId);
    campaignDispatchMetrics.phoneCapacityRefused();
    logger.warn({
      organizationId: phone.organizationId,
      phoneNumberId: phone.phoneNumberId,
      laneCapacity: capacity,
      usedCapacity: this.totalCapacity(),
      globalCapacity: this.globalCapacity,
    }, "Phone not taken: this runtime's reservoir capacity is full; it stays free for another runtime");
  }

  /**
   * Static scopes (V2-372): every UNOWNED_CHECK_INTERVAL_MS, reads every sendable phone (not only this scope) and
   * its owner, and reports one that no runtime owns -- the production defect, a phone in no cell's scope, was
   * otherwise silent. Diagnostic only: a failure is logged and never fails discovery.
   */
  private async checkUnownedPhones(): Promise<void> {
    const tracker = this.staticUnowned;
    if (!tracker || !isPhoneAssignmentStore(this.coordinator)) return;
    const now = Date.now();
    if (now < this.nextUnownedCheckAt) return;
    this.nextUnownedCheckAt = now + Math.min(UNOWNED_CHECK_INTERVAL_MS, Math.max(100, Math.floor(this.unownedAlertMs / 4)));
    try {
      const sendable = await this.sendablePhones(undefined);
      const notHeld = sendable.filter((phone) => !this.lanes.has(phone.phoneNumberId));
      const owners = await this.coordinator.peekPhoneOwners(notHeld);
      const ownedElsewhere = new Set(notHeld.filter((_, index) => owners[index] !== null).map((phone) => phone.phoneNumberId));
      tracker.observe(
        sendable,
        sendable.map((phone) => this.lanes.has(phone.phoneNumberId) || ownedElsewhere.has(phone.phoneNumberId)),
        Date.now(),
      );
    } catch (error) {
      this.logAssignmentFailure(error, "Unowned-phone check failed; it is retried");
    }
  }

  private logAssignmentFailure(error: unknown, message: string): void {
    const now = Date.now();
    if (now - this.lastAssignmentFailureLogAt < FAILURE_LOG_WINDOW_MS) return;
    this.lastAssignmentFailureLogAt = now;
    logger.warn({ error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }, message);
  }

  /**
   * Discovers the phones this runtime may own. With a scope, only phones in
   * the scope are read and asked for; an unscoped runtime asks for every
   * Running phone; automatic assignment (V2-372) reads every Running phone and
   * asks for the ones its plan gives this cell, the ones nobody took within a
   * grace period, and the ones it already holds. Ownership is still decided by
   * the coordinator's fenced lease, so two runtimes never both own a phone:
   * the loser is denied and simply retries on a later tick until the lease is
   * released or expires.
   */
  private async discover(): Promise<void> {
    if (this.activePhoneIds && this.activePhoneIds.size === 0) return;
    const discovered = await this.sendablePhones(this.activePhoneIds);
    const active = this.activePhoneIds
      ? discovered.filter((phone) => this.activePhoneIds!.has(phone.phoneNumberId))
      : discovered;
    const activeIds = new Set(active.map((phone) => phone.phoneNumberId));
    // V2-372: lanes of phones that are no longer sendable, and handoff steps that settle work or release a lease,
    // are torn down detached from this tick (startTeardown), so however long their settlement takes (it waits on
    // campaign row locks), the leases of every other phone keep being renewed on schedule.
    const inactive = [...this.lanes.values()].filter((lane) => !activeIds.has(lane.phoneNumberId));
    const deferred: Array<{ lane: PhoneLaneState; action: Exclude<HandoffAction, "none"> }> = [];
    if (this.assignment) {
      const byId = new Map(active.map((phone) => [phone.phoneNumberId, phone]));
      try {
        await this.assignment.refresh(
          active.map((phone) => ({
            organizationId: phone.organizationId,
            phoneNumberId: phone.phoneNumberId,
            weight: this.laneCapacity(phone.tps),
          })),
          {
            holds: (phone: PhoneOwnershipRef) => this.lanes.has(phone.phoneNumberId),
            canRequest: (phone: PhoneOwnershipRef) => {
              const sendable = byId.get(phone.phoneNumberId);
              return sendable !== undefined && this.mayTake(sendable, "request");
            },
          },
        );
      } catch (error) {
        // Held lanes are still renewed below; only new acquisitions wait for a working view.
        this.logAssignmentFailure(error, "Automatic phone assignment could not refresh (membership, owner or handoff read); held phones are still renewed");
      }
    } else if (this.activePhoneIds) {
      await this.checkUnownedPhones();
    }
    for (const phone of active) {
      // A phone whose teardown is still running is neither renewed nor acquired until it completes.
      if (this.teardowns.has(phone.phoneNumberId)) continue;
      const held = this.lanes.get(phone.phoneNumberId);
      if (!held) {
        if (this.assignment && !this.assignment.shouldAcquire(phone)) continue;
        if (!this.mayTake(phone, "acquire")) continue;
      }
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
      if (existing && (
        existing.fencingToken !== ownership.fencingToken
        // The phone was (re)activated onto a different credential, or moved
        // between the legacy and workspace paths: the lane's binding is no
        // longer the right one. Drop it and rebuild with a fresh binding.
        || existing.sendingCredentialId !== phone.sendingCredentialId
      )) {
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
        this.resizeLane(lane, phone);
        if (this.assignment) {
          const action = this.reviewHandoff(lane);
          if (action !== "none") deferred.push({ lane, action });
        }
        continue;
      }
      const capacity = this.laneCapacity(phone.tps);
      // Do not create an unbounded number of idle owners. Existing lanes keep
      // their fixed capacity; the global bound applies to all reservations.
      // V2-372: a phone that does not fit is released, never held without a
      // lane (which would keep every other runtime from sending it).
      if (this.totalCapacity() + capacity > this.globalCapacity) {
        this.worker.revokeTransportOwnership(phone.phoneNumberId, ownership.fencingToken);
        await this.coordinator.releasePhoneOwnership({
          organizationId: phone.organizationId,
          phoneNumberId: phone.phoneNumberId,
          ownerId: this.ownerId,
        });
        this.noteCapacityRefused(phone, capacity);
        continue;
      }
      if (phone.sendingCredentialId !== null) {
        // Workspace-credential transport (V2-02C): the lane may not exist --
        // and therefore cannot drain -- until this runtime has decrypted the
        // phone's active credential and the owning shard has acknowledged
        // the binding. Failure fails closed: ownership is released and the
        // phone is retried on a later tick. There is no fallback to any
        // other transport for a phone whose sendingCredentialId is set.
        try {
          await this.worker.bindTransportCredential(phone.phoneNumberId, phone.organizationId, phone.sendingCredentialId);
          this.bindFailures.delete(phone.phoneNumberId);
          if (this.unboundPhones.delete(phone.phoneNumberId)) {
            logger.info({ phoneNumberId: phone.phoneNumberId, credentialId: phone.sendingCredentialId }, "Workspace sending credential bound to transport");
          }
        } catch (error) {
          this.worker.revokeTransportOwnership(phone.phoneNumberId, ownership.fencingToken);
          await this.coordinator.releasePhoneOwnership({
            organizationId: phone.organizationId,
            phoneNumberId: phone.phoneNumberId,
            ownerId: this.ownerId,
          });
          campaignDispatchMetrics.credentialBindFailed();
          const previous = this.bindFailures.get(phone.phoneNumberId);
          const failures = previous && previous.credentialId === phone.sendingCredentialId ? previous.failures + 1 : 1;
          const failedAt = Date.now();
          this.bindFailures.set(phone.phoneNumberId, {
            credentialId: phone.sendingCredentialId,
            failures,
            lastFailureAt: failedAt,
            retryAt: failedAt + Math.min(BIND_RETRY_MAX_MS, BIND_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 16)),
          });
          if (!this.unboundPhones.has(phone.phoneNumberId)) {
            this.unboundPhones.add(phone.phoneNumberId);
            logger.error({
              phoneNumberId: phone.phoneNumberId,
              organizationId: phone.organizationId,
              credentialId: phone.sendingCredentialId,
              error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            }, "Workspace sending credential could not be bound to transport; phone will not send from this runtime");
          }
          continue;
        }
      }
      this.lanes.set(phone.phoneNumberId, {
        organizationId: phone.organizationId,
        phoneNumberId: phone.phoneNumberId,
        sendingCredentialId: phone.sendingCredentialId,
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
        acquiredAt: Date.now(),
        unadopted: [],
        adopting: new Set(),
        tps: phone.tps,
        consumeReserved: 0,
      });
      this.capacityRefused.delete(phone.phoneNumberId);
      if (this.assignment) {
        logger.info({
          organizationId: phone.organizationId,
          phoneNumberId: phone.phoneNumberId,
          fencingToken: ownership.fencingToken,
          cell: this.assignment.cell,
          assignedCell: this.assignment.assignedCell(phone) ?? null,
        }, "Phone lane started on this campaign cell");
      }
    }
    for (const lane of inactive) {
      if (this.lanes.get(lane.phoneNumberId) === lane) this.startTeardown(lane.phoneNumberId, () => this.dropLane(lane, true));
    }
    for (const { lane, action } of deferred) {
      if (this.lanes.get(lane.phoneNumberId) !== lane) continue;
      if (action === "settle") {
        lane.settling ??= this.settleExpiredHandoff(lane).finally(() => { lane.settling = undefined; });
      } else {
        this.startTeardown(lane.phoneNumberId, () => this.completeHandoff(lane, action === "force-release"));
      }
    }
    this.releaseFailedShardPhones(active);
  }

  /**
   * V2-372. Starts, cancels or advances a graceful handoff of a held lane to the phone's assigned cell, on every
   * discovery pass after the lane's lease was renewed. It only decides: settling and releasing run detached from
   * the discovery tick (see discover and startTeardown), so a slow settlement cannot delay other phones' renewals.
   *
   * The lane stops claiming new work at once, keeps consuming and sending what it already prepared and published,
   * and is released ("release") when nothing of its own is left in the broker, its queue, transport or
   * acknowledgement; the requester then acquires the phone with a new fencing token. A lane that has not drained
   * within handoffMaxMs expires: it adopts and admits nothing more, its unsent work is settled not-started and
   * requeued ("settle", repeated while refill or a consume pass still produces some), and its lease is kept until
   * the sends already in transport have finished, because revoking transport ownership would abort their HTTP
   * calls into delivery-unknown. Only after HANDOFF_TRANSPORT_GRACE_MS more is it released regardless
   * ("force-release"). Pacing is the shared per-phone cursor, so the two cells together never exceed the phone's
   * TPS during or after the move.
   */
  private reviewHandoff(lane: PhoneLaneState): HandoffAction {
    const assignment = this.assignment!;
    const now = Date.now();
    if (lane.handoff) {
      if (!lane.handoff.expired && assignment.assignedCell(lane) === assignment.cell) {
        logger.info({ phoneNumberId: lane.phoneNumberId, cell: assignment.cell }, "Phone handoff cancelled: the plan assigns the phone to this cell again");
        lane.handoff = undefined;
        assignment.handoffEnded(lane);
        this.refillIfNeeded(lane);
        return "none";
      }
      const unsent = lane.queue.length > 0 || lane.unadopted.length > 0 || lane.published.size > 0;
      const busy = lane.providerInFlight > 0
        || Boolean(lane.refill)
        || Boolean(lane.settling)
        || lane.refilling
        || lane.pendingAckIds.length > 0
        || lane.ackInFlight > 0;
      if (!unsent && !busy) return "release";
      const age = now - lane.handoff.since;
      if (!lane.handoff.expired) {
        if (age < assignment.timings.handoffMaxMs) return "none";
        lane.handoff.expired = true;
        logger.warn({
          organizationId: lane.organizationId,
          phoneNumberId: lane.phoneNumberId,
          fencingToken: lane.fencingToken,
          queued: lane.queue.length,
          published: lane.published.size,
          providerInFlight: lane.providerInFlight,
          handoffMs: age,
        }, "Phone handoff did not drain in time: unsent work is requeued; sends already in transport finish before the lease is released");
      }
      if (age >= assignment.timings.handoffMaxMs + HANDOFF_TRANSPORT_GRACE_MS) return "force-release";
      return unsent && !lane.settling ? "settle" : "none";
    }
    if (
      assignment.handoffRequested(lane)
      && now - lane.acquiredAt >= assignment.timings.minHoldMs
      && assignment.mayStartHandoff()
    ) {
      const to = assignment.assignedCell(lane)!;
      lane.handoff = { since: now, to };
      assignment.handoffStarted(lane);
      campaignDispatchMetrics.phoneHandoffStarted();
      logger.info({
        organizationId: lane.organizationId,
        phoneNumberId: lane.phoneNumberId,
        fencingToken: lane.fencingToken,
        from: assignment.cell,
        to,
      }, "Handing phone off to its assigned campaign cell; no new claims, prepared work is still sent");
    }
    return "none";
  }

  /** V2-372: an expired handoff's unsent work, settled not-started (requeued, attempt returned); never sent. */
  private async settleExpiredHandoff(lane: PhoneLaneState): Promise<void> {
    // Both snapshots are taken synchronously here (settlePublished copies and clears before its first await).
    const queued = lane.queue.splice(0);
    lane.queued = 0;
    // Deliveries a consume pass still holds are its to discard (the lane is inert); the rest are the lane's own
    // published envelopes, settled below, or another owner's, left pending for the phone's next owner.
    lane.unadopted = lane.unadopted.filter((delivery) => lane.adopting.has(delivery));
    await Promise.all([
      this.discardQueued(lane, queued),
      this.settlePublished(lane, "Campaign phone handoff timed out before its envelope was consumed"),
    ]);
  }

  /** V2-372: releases a handed-off lane (drained, or forced after the transport grace) and logs the move. */
  private async completeHandoff(lane: PhoneLaneState, forced: boolean): Promise<void> {
    const { to, since, expired } = lane.handoff!;
    const providerInFlight = lane.providerInFlight;
    await this.dropLane(lane, true);
    const details = {
      organizationId: lane.organizationId,
      phoneNumberId: lane.phoneNumberId,
      fencingToken: lane.fencingToken,
      from: this.assignment!.cell,
      to,
      drained: !expired,
      handoffMs: Date.now() - since,
    };
    if (forced) {
      logger.error({ ...details, providerInFlight }, "Phone handoff forced after its transport grace: sends still in transport were aborted and may end delivery-unknown");
    } else {
      logger.info(details, "Phone handed off to its assigned campaign cell");
    }
  }

  private logLaneFailure(lane: PhoneLaneState, kind: LaneFailureKind, error: unknown): void {
    const key = this.failureLogKey(lane, kind);
    const now = Date.now();
    const previous = this.failureLog.get(key);
    if (previous && now - previous.lastAt < FAILURE_LOG_WINDOW_MS) {
      previous.repeats += 1;
      return;
    }
    this.pruneFailureLog(now);
    this.failureLog.set(key, { lastAt: now, repeats: 0 });
    // `error` goes through the logger's error serializer, which scrubs
    // secrets and Drizzle bound parameters.
    logger.error({
      error,
      kind,
      organizationId: lane.organizationId,
      phoneNumberId: lane.phoneNumberId,
      ownerId: lane.ownerId,
      fencingToken: lane.fencingToken,
      repeatsSinceLastLog: previous?.repeats ?? 0,
    }, LANE_FAILURE_MESSAGES[kind]);
  }

  /**
   * dropLane() forgets a lane's entries, but a pass that was already running
   * on the dropped lane can still fail afterwards and re-insert one. Drop
   * entries of lanes that are no longer current once their window is over,
   * so the map stays bounded by the live lanes.
   */
  private pruneFailureLog(now: number): void {
    for (const [key, entry] of this.failureLog) {
      if (now - entry.lastAt < FAILURE_LOG_WINDOW_MS) continue;
      const [phoneNumberId, fencingToken] = key.split(":");
      if (this.lanes.get(Number(phoneNumberId))?.fencingToken !== Number(fencingToken)) this.failureLog.delete(key);
    }
  }

  /** Per lane incarnation: a re-acquired lane (new fencing token) logs its first failure at once. */
  private failureLogKey(lane: PhoneLaneState, kind: LaneFailureKind): string {
    return `${lane.phoneNumberId}:${lane.fencingToken}:${kind}`;
  }

  private async dropLane(lane: PhoneLaneState, releaseOwnership: boolean): Promise<void> {
    lane.dropped = true;
    if (lane.handoff) this.assignment?.handoffEnded(lane);
    if (lane.drainTimer) { clearTimeout(lane.drainTimer); lane.drainTimer = undefined; }
    this.lanes.delete(lane.phoneNumberId);
    for (const kind of Object.keys(LANE_FAILURE_MESSAGES) as LaneFailureKind[]) {
      this.failureLog.delete(this.failureLogKey(lane, kind));
    }
    this.worker.revokeTransportOwnership(lane.phoneNumberId, lane.fencingToken);
    const queued = lane.queue.splice(0);
    lane.queued = 0;
    await this.discardQueued(lane, queued);
    await this.settlePublished(lane, "Campaign lane dropped before its envelope was consumed");
    // A detached recovery stops between pages once the lane is dropped; wait for the page in progress (its promise
    // never rejects). stop() waits only for live lanes and teardowns, so without this a dropped lane's recovery
    // could run past broker.close(), and a lane rebuilt for the phone could recover beside it.
    if (lane.recovery) await lane.recovery;
    if (releaseOwnership) {
      await this.coordinator.releasePhoneOwnership({
        organizationId: lane.organizationId,
        phoneNumberId: lane.phoneNumberId,
        ownerId: this.ownerId,
      });
    }
  }

  /**
   * Settles a dropped lane's queued (adopted, never handed to transport) envelopes as not started and acknowledges
   * those whose settlement committed. V2-372: one batched settlement per campaign (discardReservoirEnvelopes)
   * instead of one transaction per envelope, each taking the campaign row lock: pausing a high-TPS campaign
   * dropped a lane holding up to its capacity (3,000 at 1,000 TPS) of queued work, and the per-envelope form
   * measured over 30 s per 256 envelopes. Same per-envelope outcome; failures leave exact leases for recovery.
   */
  private async discardQueued(lane: PhoneLaneState, queued: QueuedEnvelope[]): Promise<void> {
    if (!queued.length) return;
    try {
      const { settled, failure } = await this.worker.discardReservoirEnvelopes(queued.map(({ envelope }) => envelope));
      const persisted = new Set(settled);
      await this.broker.acknowledge(
        lane.phoneNumberId,
        queued.filter(({ envelope }) => persisted.has(envelope)).map(({ delivery }) => delivery.id),
      );
      if (failure !== undefined) throw failure;
    } catch (error) {
      logger.error({
        error,
        organizationId: lane.organizationId,
        phoneNumberId: lane.phoneNumberId,
        fencingToken: lane.fencingToken,
        envelopes: queued.length,
      }, "Campaign lane could not settle all of its queued envelopes; their exact leases are left for recovery");
    }
  }

  /**
   * Envelopes this lane published that were never consumed were never sent either: settle them while this
   * runtime still knows that (worker.discardPublishedEnvelopes), instead of leaving their leases to expire
   * into a manual-reconciliation failure at re-preparation.
   */
  private async settlePublished(lane: PhoneLaneState, reason: string): Promise<void> {
    const published = [...lane.published.values()];
    lane.published.clear();
    if (!published.length) return;
    try {
      await this.worker.discardPublishedEnvelopes(published, reason);
    } catch (error) {
      logger.error({
        error,
        organizationId: lane.organizationId,
        phoneNumberId: lane.phoneNumberId,
        fencingToken: lane.fencingToken,
        envelopes: published.length,
      }, "Campaign lane could not settle its unconsumed published envelopes; their exact leases are left for recovery");
    }
  }

  private totalCapacity(): number {
    return [...this.lanes.values()].reduce((sum, lane) => sum + lane.capacity, 0);
  }

  private service(lane: PhoneLaneState): void {
    if (lane.service || this.stopping || lane.dropped) return;
    lane.service = this.serviceLane(lane).catch((error) => {
      campaignDispatchMetrics.brokerFailure();
      // Decision 3: the phone's stream or group was lost and recreated; settle the lost work now, not one
      // recovery interval later.
      if (error instanceof BrokerStreamResetError) this.requestRecovery(lane);
      this.logLaneFailure(lane, "service", error);
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

    if (
      now >= lane.nextRecoveryAt && !lane.recovery
      // Re-checked after the metrics await: a pass resumed after stop() collected its work, or after the lane was
      // dropped or replaced, must not start a recovery nobody waits for (it would run past broker.close()).
      && !this.stopping && !lane.dropped && this.lanes.get(lane.phoneNumberId) === lane
    ) {
      // Detached (see PhoneLaneState.recovery). It settles other consumers' pending entries and leaves alone the
      // ones a consume pass of this lane is processing (see recoverAbandoned); the next one is scheduled when this
      // one ends.
      let reset = false;
      // A request made while this pass runs (a failed read, a reset) must survive its end (see requestRecovery).
      lane.recoveryRequested = false;
      lane.recovery = this.recoverAbandoned(lane).catch((error) => {
        campaignDispatchMetrics.brokerFailure();
        reset = error instanceof BrokerStreamResetError;
        this.logLaneFailure(lane, "service", error);
      }).finally(() => {
        lane.recovery = undefined;
        // Decision 3: after a stream reset found by this pass, run again at once (the group now exists).
        lane.nextRecoveryAt = reset || lane.recoveryRequested ? 0 : Date.now() + this.abandonedDeliveryMs;
        // The pass rebuilt the deferred set (B13 R2), which can drop the ready depth below low water: refill now,
        // as the in-line pass did, not one service tick later.
        if (this.lanes.get(lane.phoneNumberId) === lane && !lane.dropped) this.refillIfNeeded(lane);
      });
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
    await this.recoverLostEntries(lane);
    const consumerId = `${lane.ownerId}:${lane.fencingToken}`;
    const pageSize = Math.max(1, Math.min(this.batchSize, MAX_RECLAIM_BATCH));
    let cursor = RECLAIM_CURSOR_START;
    // Rebuilt by every pass from what it leaves pending (B13 R2). A pass cut short (STOP, an error, the round
    // bound) records only what it saw, which can only make the lane's supply estimate higher, never lower.
    const deferred = new Set<string>();
    try {
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
        // A foreign delivery that a consume pass of this lane is processing right now (lane.adopting) is being
        // discarded there as never sent; settling it here at the same time (recovery runs beside consume) could fail
        // a job that was never read as delivery-unknown. It is left pending: that pass, or a later one (consume
        // retries what it leaves behind), or a later recovery pass resolves it.
        const held = new Set([...(lane.adopting ?? [])].map((delivery) => delivery.id));
        const stale = page.deliveries.filter((delivery) => delivery.fencingToken !== lane.fencingToken && !held.has(delivery.id));
        // A foreign delivery this lane read and a consume pass left behind unsettled (a failed discard or
        // acknowledgement) is still listed in `unadopted`, and consume retries it on every pass. Settling it here, it
        // is held exclusively (as a consume pass holds what it processes), so a pass that starts meanwhile skips it,
        // and it is forgotten once acknowledged, so no later pass settles, acknowledges and counts it again.
        const leftBehind = new Map((lane.unadopted ?? []).filter((delivery) => !held.has(delivery.id)).map((delivery) => [delivery.id, delivery]));
        const holding = stale.flatMap((delivery) => {
          const own = leftBehind.get(delivery.id);
          return own ? [own] : [];
        });
        lane.adopting ??= new Set();
        for (const delivery of holding) lane.adopting.add(delivery);
        try {
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
            envelopes.forEach((envelope, index) => { if (!persisted.has(envelope)) deferred.add(stale[index]!.id); });
            const acknowledged = envelopes.flatMap((envelope, index) => persisted.has(envelope) ? [stale[index]!.id] : []);
            await this.broker.acknowledge(lane.phoneNumberId, acknowledged);
            for (const id of acknowledged) {
              // readyDepth subtracts the deferred ids from the stream length, which serviceLane refreshes while this
              // detached pass runs: an acknowledged (deleted) entry left in the previous pass's set made readyDepth
              // too low, so the lane could claim beyond its high water until the pass ended.
              lane.deferredDeliveryIds?.delete(id);
              const own = leftBehind.get(id);
              if (!own) continue;
              lane.published.delete(this.publishedKey(own.envelope));
              this.forgetUnadopted(lane, own);
            }
            if (failure !== undefined) throw failure;
          }
          if (adoption !== undefined) throw adoption;
        } finally {
          for (const delivery of holding) lane.adopting.delete(delivery);
        }
      }
      cursor = page.cursor;
      if (cursor === RECLAIM_CURSOR_START || this.stopping || lane.dropped) return;
    }
    } finally {
      lane.deferredDeliveryIds = deferred;
    }
  }

  /**
   * Decision 3 (Redis failures). This lane's own published work whose stream entry it can no longer read, settled as
   * never started under its exact lease (revoked and requeued, fenced) and forgotten, so its lease is no longer
   * renewed. Before, such work stayed published: renewed forever, never sent, never settled, and the campaign never
   * completed.
   *  (a) Lost stream or consumer group (Redis restarted without persistence, failover, a deleted key): the entry is
   *      gone. It was never read: a read entry leaves `published` when it is queued, and an entry read but not yet
   *      queued is in `unadopted` (left alone here). No other consumer reads this lane's entries while it owns the
   *      phone (a takeover drops the lane first), the assumption dropLane's settlement already rests on.
   *  (b) Lost XREADGROUP reply (only after a failed read): the entry was delivered to this consumer, but the lane
   *      never received it: still published, not in `unadopted`, and this consumer's name is unique to this process
   *      and fencing token, so nothing else ever read it. It is acknowledged after its settlement.
   * A delivery a concurrent read is about to hand over may be judged lost: its settlement requeues the job, and the
   * adoption check then refuses the delivery (its lease is gone), so it is never sent; the job is sent once later.
   */
  private async recoverLostEntries(lane: PhoneLaneState): Promise<void> {
    const scanOwn = lane.consumeReplyUncertain === true && this.broker.pendingOwn !== undefined;
    if (!scanOwn && !(this.broker.missingPublished && lane.published.size)) return;
    // No read starts while the decision is made (consumePass reads nothing while lostScan is set), and one already
    // in flight is waited for: its deliveries reach `unadopted` (and are left alone) before anything is judged lost.
    // A read that does not finish in time leaves this to the next pass.
    lane.lostScan = true;
    try {
      for (let waited = 0; (lane.consumeReserved ?? 0) > 0; waited += 5) {
        if (waited >= LOST_SCAN_READ_WAIT_MS) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const readKeys = new Set((lane.unadopted ?? []).map((delivery) => this.publishedKey(delivery.envelope)));
      if (this.broker.missingPublished && lane.published.size) {
        const unread = [...lane.published.entries()].filter(([key]) => !readKeys.has(key));
        const missing = unread.length ? await this.broker.missingPublished(lane.phoneNumberId, unread.map(([, envelope]) => envelope)) : [];
        const lost = unread.filter(([key], index) => missing[index] && lane.published.has(key) && !readKeys.has(key));
        if (lost.length) await this.settleLostEntries(lane, lost, [], "Campaign broker entry was lost before it was read (stream or consumer group reset)");
      }
      if (!scanOwn) return;
      const consumerId = `${lane.ownerId}:${lane.fencingToken}`;
      const pageSize = Math.max(1, Math.min(this.batchSize, MAX_RECLAIM_BATCH));
      const lost: Array<[string, BrokerPreparedCampaignEnvelope]> = [];
      const lostIds: string[] = [];
      let after: string | null = "0";
      for (let round = 0; after !== null && round < MAX_RECLAIM_ROUNDS; round += 1) {
        const page: { deliveries: BrokerDelivery[]; nextId: string | null } = await this.broker.pendingOwn!(lane.phoneNumberId, consumerId, pageSize, after);
        for (const delivery of page.deliveries) {
          if (delivery.fencingToken !== lane.fencingToken) continue;
          const key = this.publishedKey(delivery.envelope);
          const envelope = lane.published.get(key);
          // Read by this lane: waiting in `unadopted` (readKeys), or already queued, in transport or settled.
          if (!envelope || readKeys.has(key)) continue;
          lost.push([key, envelope]);
          lostIds.push(delivery.id);
        }
        after = page.nextId;
      }
      if (lost.length) await this.settleLostEntries(lane, lost, lostIds, "Campaign broker read reply was lost: delivered to this consumer, never read");
      // Cleared only after a complete scan: a page that failed leaves it set, and the next pass scans again.
      lane.consumeReplyUncertain = false;
    } finally {
      lane.lostScan = false;
    }
  }

  /** Decision 3: run the recovery pass at the next service tick, even if one is running now. */
  private requestRecovery(lane: PhoneLaneState): void {
    lane.nextRecoveryAt = 0;
    lane.recoveryRequested = true;
  }

  private async settleLostEntries(
    lane: PhoneLaneState,
    lost: Array<[string, BrokerPreparedCampaignEnvelope]>,
    deliveryIds: string[],
    reason: string,
  ): Promise<void> {
    // Settled, then acknowledged, then forgotten. On a failure at any step the keys stay published (renewed, fenced
    // no-ops once the job is requeued) and the next recovery pass finds and retries them: the settlement is fenced
    // and idempotent (a revoked intent is no longer pending; a requeued job no longer holds the lease). Forgotten
    // before the acknowledgement, an entry whose acknowledgement failed stayed in this consumer's pending list for
    // good (the scan skips entries it no longer publishes), inflating the lane's ready depth.
    await this.worker.discardPublishedEnvelopes(lost.map(([, envelope]) => envelope), reason);
    if (deliveryIds.length) await this.broker.acknowledge(lane.phoneNumberId, deliveryIds);
    for (const [key] of lost) lane.published.delete(key);
    lane.brokerDepth = Math.max(0, lane.brokerDepth - lost.length);
    campaignDispatchMetrics.brokerLostEntries(lost.length);
    logger.warn({
      organizationId: lane.organizationId,
      phoneNumberId: lane.phoneNumberId,
      fencingToken: lane.fencingToken,
      envelopes: lost.length,
      reason,
    }, "Campaign lane settled published work it can no longer read as never started");
  }

  private refillIfNeeded(lane: PhoneLaneState): void {
    if (
      lane.refill
      || lane.refilling
      || lane.handoff
      || this.stopping
      || Date.now() < lane.sourceEmptyUntil
      || this.readyDepth(lane) > lane.lowWater
      || lane.pendingAckIds.length + lane.ackInFlight >= ACK_DEBT_LIMIT
      // No preparation headroom: arm nothing. A refill run would stop before its first await, and its own
      // re-arm would start the next one in the same microtask chain, so the event loop (and the outcome flush
      // that frees headroom) would never run again. The lane's next service tick, a timer, re-arms it.
      || this.preparationHeadroom() < 1
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
        || lane.handoff
        || Date.now() < lane.sourceEmptyUntil
        || this.readyDepth(lane) > lane.lowWater
        || this.preparationHeadroom() < 1
      ) {
        lane.refilling = false;
        continue;
      }
      this.activeRefills += 1;
      let failed = false;
      const refill = this.runRefill(lane).catch((error) => {
        // Claimed leases are settled by the worker's preparation boundary; a
        // future watermark request may safely reserve a new bounded refill.
        failed = true;
        this.logLaneFailure(lane, "refill", error);
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
        && !lane.handoff
        && Date.now() >= lane.sourceEmptyUntil
      ) {
        // B13 R1: never claim more than the sender can prepare. On 2884382f a lane claimed up to its high water
        // (3,000) while the sender's durable-outcome capacity (4,096 for all lanes) was full, so whole claimed
        // batches were refused after their claim, and the lane then slept as if its source were empty.
        const slots = Math.min(
          MAX_SUPPLY_CLAIM_BATCH,
          lane.highWater - this.readyDepth(lane),
          this.preparationHeadroom(),
        );
        if (slots < 1) break;
        lane.reserved += slots;
        let prepared: PreparedCampaignEnvelope[] = [];
        let claimedCount = 0;
        try {
          const claimed = await this.worker.claimPhoneBatch(lane.phoneNumberId, slots);
          claimedCount = claimed.length;
          prepared = await this.worker.prepareReservoirBatch(claimed);
        } finally {
          lane.reserved = Math.max(0, lane.reserved - slots);
        }
        if (!prepared.length) {
          // Only a claim that found nothing is evidence of an empty source. A claim whose work was refused or
          // failed at preparation found work; parking the lane on the source-empty ladder for it (1 s, 2 s, 4 s,
          // ...) starved a phone that still had a backlog.
          if (!claimedCount) await this.markSourceEmpty(lane);
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
          campaignDispatchMetrics.reservoirStarvation(starvationMs, {
            phoneNumberId: lane.phoneNumberId,
            startedAtMs: lane.emptySince,
            cause: lane.emptyCause ?? "refill-not-armed",
          });
          lane.emptySince = undefined;
          lane.emptyCause = undefined;
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
        const brokerPublished = prepared.map((envelope) => this.worker.handoffPreparedEnvelope(envelope));
        if (this.stopping) {
          // V2-372: the runtime began stopping while this batch was being published, after stop() had settled the
          // lane's published envelopes. Settle these the same way (not started, requeued). This is safe only
          // here: a stopping runtime builds no new lane, and a successor elsewhere owns the phone under a newer
          // fencing token, so it can only discard these entries as stale, never send them.
          try {
            await this.worker.discardPublishedEnvelopes(brokerPublished, "Campaign runtime stopping before its envelope was consumed");
          } catch (error) {
            this.logLaneFailure(lane, "refill", error);
          }
          break;
        }
        if (lane.dropped || this.lanes.get(lane.phoneNumberId) !== lane) {
          // V2-372: the lane was dropped while this batch was being published. Never settle it here: this runtime
          // may already have rebuilt the phone's lane under the same fencing token (a sending-credential change),
          // whose consumer reads these entries and may have adopted them, and a settlement racing that adoption
          // would requeue a job already in transport. A same-token successor takes them into its own published
          // set (renewed, and settled if it drops); entries under an older token are discarded as stale, not
          // started, by whichever lane reads them. (Single broker client: this runs before that lane's read of the
          // same entries can reach adoption.)
          const successor = this.lanes.get(lane.phoneNumberId);
          if (successor && successor !== lane && !successor.dropped && successor.fencingToken === lane.fencingToken) {
            for (const brokerEnvelope of brokerPublished) successor.published.set(this.publishedKey(brokerEnvelope), brokerEnvelope);
          }
          break;
        }
        for (const brokerEnvelope of brokerPublished) {
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
    // B13 R2: a dead owner's deferred deliveries are in that count too, but they are not this lane's supply.
    // Counting them held a taken-over lane at or above its low water for the rest of the dead owner's
    // 30 s leases, so it refilled nothing; they are excluded here (the brokerDepth metric still reports them).
    return Math.max(0, lane.brokerDepth - (lane.deferredDeliveryIds?.size ?? 0))
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

  /** A dropped lane, or any lane of a stopping runtime, must not adopt or send anything more. */
  private isInert(lane: PhoneLaneState): boolean {
    return lane.dropped === true || this.stopping || lane.handoff?.expired === true;
  }

  private async consume(lane: PhoneLaneState): Promise<void> {
    if (this.isInert(lane)) return;
    const startedAt = Date.now();
    let read = false;
    try {
      read = await this.consumePass(lane);
    } finally {
      // P1: a slow pass (a loaded database under validation) means the next read lands later; the read-ahead target
      // covers it (consumeSize). Only passes that read are sampled (most passes read nothing, and averaging them in
      // decayed the margin to zero), smoothed, and bounded so one stalled pass cannot inflate the target for long.
      if (read) {
        const elapsed = Math.min(2_000, Date.now() - startedAt);
        lane.consumeLatencyMs = lane.consumeLatencyMs === undefined ? elapsed : lane.consumeLatencyMs * 0.7 + elapsed * 0.3;
      }
    }
  }

  /** One consume pass; returns whether it issued a stream read. */
  private async consumePass(lane: PhoneLaneState): Promise<boolean> {
    lane.unadopted ??= [];
    lane.adopting ??= new Set();
    // Decision 3: no read while recovery decides which published entries are lost (see recoverLostEntries).
    const available = lane.lostScan ? 0 : this.consumeSize(lane);
    if (available >= 1) {
      // Reserved synchronously: consume() runs concurrently on one lane, and two passes must not both read the
      // whole deficit.
      lane.consumeReserved = (lane.consumeReserved ?? 0) + available;
      let fresh: BrokerDelivery[];
      try {
        fresh = await this.broker.consume(
          lane.phoneNumberId,
          `${lane.ownerId}:${lane.fencingToken}`,
          available,
        );
      } catch (error) {
        // Decision 3: the read may have delivered entries whose reply never arrived (or the stream was reset). The
        // next recovery pass, brought forward, finds them; until then they stay published (and renewed).
        lane.consumeReplyUncertain = true;
        this.requestRecovery(lane);
        throw error;
      } finally {
        lane.consumeReserved -= available;
      }
      campaignDispatchMetrics.brokerRead(fresh.length);
      if (fresh.length) {
        campaignDispatchMetrics.brokerConsumed(fresh.length);
        lane.brokerConsumerLag = Math.max(0, lane.brokerConsumerLag - fresh.length);
        lane.unadopted.push(...fresh);
      }
    }
    // V2-372. A read moves deliveries into this consumer's pending list, and recovery skips this lane's own
    // token, so a delivery read here and then neither queued nor acknowledged (validation threw, or a stale
    // discard or its acknowledgement failed) was orphaned: its job was never sent, its lease lapsed into a
    // manual-reconciliation failure, and its stream entry kept the lane's ready depth above low water, so the
    // phone stopped claiming. Read deliveries now stay in `unadopted` until each is queued or acknowledged and
    // are retried by a later pass; their published keys stay too, so their leases are still renewed and a lane
    // drop settles them not-started.
    //
    // consume() runs concurrently on one lane (the service pass and the refill run both call it), so each pass
    // takes exclusive hold of the deliveries it processes, synchronously, before its first await: a delivery is
    // validated and queued by at most one pass at a time. Without this, a pass that started while another was
    // validating re-queued the same deliveries, and each of them was sent twice.
    const deliveries = lane.unadopted.filter((delivery) => !lane.adopting.has(delivery));
    if (!deliveries.length) return available >= 1;
    for (const delivery of deliveries) lane.adopting.add(delivery);
    try {
      await this.adoptDeliveries(lane, deliveries);
    } finally {
      for (const delivery of deliveries) lane.adopting.delete(delivery);
    }
    return available >= 1;
  }

  /**
   * How many stream entries this pass may read. Always within the lane's capacity bound (R4). With P1
   * (consumeAheadMs set and the phone's TPS known):
   * - the lane reads only up to the read-ahead target (TPS x (consumeAheadMs + the smoothed consume pass time,
   *   at most 1 s)) beyond what drain() admitted, counting what it has queued, read but not yet adopted, and reads
   *   in progress, and skips reads smaller than a minimum chunk;
   * - except while the stream holds entries this lane did not publish (a dead or previous owner's backlog after a
   *   takeover): those come first in the stream and are only ever discarded, so they are read at the full bound.
   *   Reading them in target-sized steps would keep the successor's ready depth above low water, and so hold off
   *   its refill, for many passes.
   */
  private consumeSize(lane: PhoneLaneState): number {
    const bound = Math.min(
      this.batchSize,
      lane.capacity - lane.providerInFlight - lane.queued
        - lane.pendingAckIds.length - lane.ackInFlight - lane.unadopted.length - (lane.consumeReserved ?? 0),
    );
    if (this.consumeAheadMs === undefined || !lane.tps || bound < 1) return bound;
    const aheadMs = this.consumeAheadMs + Math.min(1_000, lane.consumeLatencyMs ?? 0);
    const target = Math.max(1, Math.ceil((lane.tps * aheadMs) / 1000));
    const ownUnread = this.ownUnread(lane);
    // Less what a read already in progress may take: two concurrent passes (service and refill) both saw it.
    const foreign = Math.max(0, lane.brokerConsumerLag - ownUnread - (lane.consumeReserved ?? 0));
    // Only this lane's own read-but-unadopted entries count against the target: foreign deliveries waiting for a
    // retried stale discard are never sent, and counting them let a page of them (one failed discard) block every
    // read of the lane's own entries until the discard succeeded. They still count against the capacity bound.
    const deficit = target - lane.queued - this.ownReadUnadopted(lane) - (lane.consumeReserved ?? 0);
    const minimumChunk = Math.max(1, Math.min(64, Math.ceil(target / 4)));
    const wanted = Math.max(foreign, deficit >= minimumChunk ? deficit : 0);
    return Math.min(bound, wanted);
  }

  /**
   * P1: this lane's own published entries not yet read. `unadopted` can also hold foreign deliveries (a dead owner's
   * backlog awaiting its stale discard), which are not in `published`, so only own ones are subtracted.
   */
  private ownUnread(lane: PhoneLaneState): number {
    return Math.max(0, lane.published.size - this.ownReadUnadopted(lane));
  }

  /** P1: this lane's own entries already read but not yet queued or settled (the rest of `unadopted` is foreign). */
  private ownReadUnadopted(lane: PhoneLaneState): number {
    let ownRead = 0;
    for (const delivery of lane.unadopted ?? []) if (lane.published.has(this.publishedKey(delivery.envelope))) ownRead += 1;
    return ownRead;
  }

  /** Validates, queues or discards deliveries this pass holds exclusively (see consume). */
  private async adoptDeliveries(lane: PhoneLaneState, deliveries: BrokerDelivery[]): Promise<void> {
    // Preparation is the durable authorization boundary, but a prepared
    // envelope may sit in the broker while a campaign is paused or its lease
    // is replaced. Validate the whole delivery batch immediately before
    // adoption so stale broker work is discarded before it can reach the
    // provider. This is one bounded query per batch, not one query per send.
    const validation = await this.worker.validatePreparedBrokerEnvelopes(
      deliveries.map((delivery) => delivery.envelope),
    );
    // Keyed by job AND lease, so a delivery is adopted only when its own envelope validated. Keyed by job
    // alone, a stale delivery of a job since re-claimed under a newer lease, by a lane with the same fencing
    // token, would be adopted as the fresh envelope a second time and the job dispatched twice. That case is
    // real: a lane rebuilt for a sending-credential change keeps its ownership token, and its unconsumed
    // envelopes are requeued at once (settlePublished), so the stale and fresh deliveries can share a page.
    const validByKey = new Map(validation.valid.map((envelope) => [this.publishedKey(envelope), envelope]));
    const checkedAt = Date.now();
    // The lane may have been dropped (or the runtime begun stopping) while the read or the validation was
    // awaiting. From here to the queue push is synchronous, so this check cannot race dropLane(): either it
    // ran first and this pass discards everything as not started, or it runs later and splices the queue.
    const discardAll = this.isInert(lane);
    // Stale deliveries (a dead owner's fencing token, a replaced or expired
    // lease, a campaign that is no longer sendable) were never handed to the
    // provider. They are discarded as one page: one aborted settlement per
    // campaign and one acknowledgement, instead of one of each per envelope.
    // A dead runtime leaves whole published claim batches unread, and under
    // live settlement each per-row discard waited on the campaign lock, so
    // 256 of them blocked the lane for over half a minute.
    const stale: Array<{ delivery: BrokerDelivery; envelope: PreparedCampaignEnvelope }> = [];
    const unusable: BrokerDelivery[] = [];
    for (const delivery of deliveries) {
      const current = validByKey.get(this.publishedKey(delivery.envelope));
      const leaseExpiresAt = current?.job.leaseExpiresAt?.getTime() ?? 0;
      const isStale = discardAll
        || !current
        || delivery.fencingToken !== lane.fencingToken
        || leaseExpiresAt <= checkedAt;
      // A stale delivery is settled under the lease it was published with,
      // never under whatever lease the job holds now: a page holding both a
      // dead owner's envelope and this lane's fresh envelope for the same job
      // would otherwise revoke the fresh lease and let the queued fresh
      // envelope send unfenced.
      let envelope: PreparedCampaignEnvelope;
      try {
        envelope = this.worker.adoptPreparedEnvelope(isStale ? delivery.envelope : current!);
      } catch {
        // V2-372: an entry that cannot be adopted (no durable lease: corrupt or foreign) can never be validated,
        // settled or sent. Retried, it blocked every delivery behind it and the lane stopped sending.
        unusable.push(delivery);
        continue;
      }
      if (isStale) {
        stale.push({ delivery, envelope });
        continue;
      }
      lane.queue.push({ delivery, envelope, leaseValidUntilMs: leaseExpiresAt });
      lane.queued += 1;
      lane.published.delete(this.publishedKey(delivery.envelope));
      this.forgetUnadopted(lane, delivery);
    }
    if (lane.queued > 0 && lane.emptySince !== undefined) {
      // P1: work reaching the queue ends a starvation event, whatever its cause. A refill's publish used to be the
      // only end, which with bounded reads can come long after reads resumed sending, so an event spanned sending.
      const starvationMs = Date.now() - lane.emptySince;
      lane.emptyDelayMs += starvationMs;
      campaignDispatchMetrics.reservoirStarvation(starvationMs, {
        phoneNumberId: lane.phoneNumberId,
        startedAtMs: lane.emptySince,
        cause: lane.emptyCause ?? "refill-not-armed",
      });
      lane.emptySince = undefined;
      lane.emptyCause = undefined;
    }
    // The stale discard runs first: it is the only release of the route slots and registrations their adoption
    // above took, so nothing (an unusable delivery's acknowledgement failing included) may skip it.
    let failure: unknown;
    if (stale.length) {
      const discarded = await this.worker.discardReservoirEnvelopes(stale.map(({ envelope }) => envelope));
      failure = discarded.failure;
      const persisted = new Set(discarded.settled);
      const acknowledged = stale.filter(({ envelope }) => persisted.has(envelope));
      await this.broker.acknowledge(lane.phoneNumberId, acknowledged.map(({ delivery }) => delivery.id));
      campaignDispatchMetrics.brokerStaleDiscarded(acknowledged.length);
      for (const { delivery } of acknowledged) {
        lane.published.delete(this.publishedKey(delivery.envelope));
        this.forgetUnadopted(lane, delivery);
      }
      lane.brokerDepth = Math.max(0, lane.brokerDepth - acknowledged.length);
    }
    if (unusable.length) {
      // V2-372: an entry with no durable lease cannot be validated, settled or sent; it is dropped (never sent).
      this.logLaneFailure(lane, "unusable", new Error(`unusable broker deliveries: ${unusable.map((delivery) => delivery.id).join(",")}`));
      await this.broker.acknowledge(lane.phoneNumberId, unusable.map((delivery) => delivery.id));
      for (const delivery of unusable) {
        lane.published.delete(this.publishedKey(delivery.envelope));
        this.forgetUnadopted(lane, delivery);
      }
      lane.brokerDepth = Math.max(0, lane.brokerDepth - unusable.length);
    }
    if (failure !== undefined) throw failure;
  }

  private forgetUnadopted(lane: PhoneLaneState, delivery: BrokerDelivery): void {
    const index = lane.unadopted.indexOf(delivery);
    if (index >= 0) lane.unadopted.splice(index, 1);
  }

  private publishedKey(envelope: BrokerPreparedCampaignEnvelope): string {
    return `${envelope.job.id}:${envelope.job.leaseToken ?? ""}`;
  }

  /**
   * Keeps the exact durable leases of this runtime's outstanding prepared work
   * alive: envelopes published to the broker and not yet consumed, and
   * envelopes consumed into a lane's local queue that have not entered
   * transport. drain() deliberately leaves queued work in place while the
   * settlement plane is saturated (it never aborts claimed, prepared, leased
   * work), so without renewal a queued envelope's lease expired under
   * sustained backpressure, the reaper aborted and requeued it, and the work
   * was thrown away and re-claimed.
   *
   * Fail-closed, unchanged: renewal is the exact-lease UPDATE in
   * renewBrokerLeases (status Processing, the same lease token, a lease that
   * has not expired yet), so an expired or replaced lease is never
   * resurrected. Fencing: only a lane this runtime still owns is renewed (it
   * is in `lanes` and its ownership has not lapsed), and a queued entry only
   * when it was adopted under the lane's current fencing token and its
   * in-flight registration has not been aborted.
   *
   * Queued work is re-checked against PostgreSQL before its lease is renewed
   * (renewQueuedReservoirLeases: the predicates adoption uses, plus the
   * suppression lookup). The abort delivered by pause, the kill switch, STOP
   * or lease loss is process-local, so a pause served by another cell, or a
   * suppression committed while the envelope waited, is visible only in the
   * database; renewing without this check would keep such work leased for as
   * long as the backpressure lasted. An envelope that fails the check has its
   * registration aborted and is not renewed: dispatch settles an aborted
   * registration, fenced to its exact lease, without sending. Each renewed
   * entry records its new expiry, which drain() checks before transport.
   * The check runs at the next pass after the database change, so after a
   * change made on another cell such work can still be sent for up to one
   * renewal interval (leaseMs / 3); before queued renewal existed, that
   * window was the rest of its lease. Queued work is checked in
   * chunks of QUEUED_RENEWAL_CHUNK. Published envelopes are renewed first, so
   * a failing queued check never holds them back; the failing chunk's queued
   * work is left unrenewed, logged (rate-limited, per lane) and retried on the
   * next housekeeping tick.
   */
  async renewPublishedLeases(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    const due = [...this.lanes.values()].filter((lane) =>
      (lane.published.size > 0 || lane.queue.length > 0)
      && now >= lane.nextLeaseRenewalAt
      && lane.ownershipValidUntilMs > now,
    );
    if (!due.length) return;
    const published: BrokerPreparedCampaignEnvelope[] = [];
    const queued: Array<{ lane: PhoneLaneState; entry: QueuedEnvelope }> = [];
    for (const lane of due) {
      published.push(...lane.published.values());
      for (const entry of lane.queue) {
        if (entry.delivery.fencingToken !== lane.fencingToken || entry.envelope.registration.signal.aborted) continue;
        queued.push({ lane, entry });
      }
    }
    if (published.length) await this.worker.renewBrokerLeases(published);
    const failed = new Map<PhoneLaneState, unknown>();
    for (let start = 0; start < queued.length; start += QUEUED_RENEWAL_CHUNK) {
      const chunk = queued.slice(start, start + QUEUED_RENEWAL_CHUNK);
      try {
        const renewed = await this.worker.renewQueuedReservoirLeases(chunk.map(({ entry }) => entry.envelope));
        const expiry = new Map(renewed.map(({ envelope, leaseExpiresAt }) => [envelope, leaseExpiresAt]));
        for (const { entry } of chunk) {
          const leaseExpiresAt = expiry.get(entry.envelope);
          if (leaseExpiresAt !== undefined) entry.leaseValidUntilMs = Math.max(entry.leaseValidUntilMs, leaseExpiresAt);
        }
      } catch (error) {
        // Fail closed for this chunk only: its unverified queued work is not
        // renewed. Other chunks, the published renewal above and the rest of
        // housekeeping proceed.
        for (const { lane } of chunk) if (!failed.has(lane)) failed.set(lane, error);
      }
    }
    for (const [lane, error] of failed) this.logLaneFailure(lane, "renewal", error);
    const next = Date.now() + this.worker.brokerLeaseRenewalIntervalMs;
    // A lane whose queued check failed is retried on the next housekeeping tick.
    for (const lane of due) if (!failed.has(lane)) lane.nextLeaseRenewalAt = next;
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
      } catch (error) {
        this.logLaneFailure(lane, "ack", error);
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

  /** B13 R5: classify why the lane's queue is empty, at the moment it goes empty. */
  private starvationCause(lane: PhoneLaneState): ReservoirStarvationCause {
    if (Date.now() < lane.sourceEmptyUntil) return "source-empty-backoff";
    if (this.preparationHeadroom() < 1) return "outcome-backpressure";
    if (lane.refill) return "refill-in-flight";
    if (lane.refilling) return "refill-queued";
    return "refill-not-armed";
  }

  private wakeDrainIn(lane: PhoneLaneState, delayMs: number): void {
    if (lane.drainTimer) return;
    lane.drainTimer = setTimeout(() => {
      lane.drainTimer = undefined;
      this.drain(lane);
    }, Math.max(1, Math.ceil(delayMs)));
    lane.drainTimer.unref();
  }

  private drain(lane: PhoneLaneState): void {
    if (lane.draining || this.isInert(lane)) return;
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
        // B13 R4: not due yet is not a refusal. Work whose paced slot is beyond the admission horizon waits
        // here, holding no settlement slot; the probe below (and its refusal count) is reached only by work
        // that is due.
        const headDueAt = scheduledSendAtMs(lane.queue[0]!.envelope.job);
        const untilAdmissible = headDueAt - TRANSPORT_ADMISSION_HORIZON_MS - Date.now();
        if (untilAdmissible > 0) {
          this.wakeDrainIn(lane, untilAdmissible);
          break;
        }
        if (!this.worker.tryReserveSettlementSlot()) break;
        const { delivery, envelope, leaseValidUntilMs } = lane.queue.shift()!;
        lane.queued -= 1;
        const dequeuedAt = Date.now();
        // P1: with a read-ahead bound the queue empties routinely while this lane's own entries wait unread in
        // the stream; the envelope dequeued here is itself still to be sent, so that is not starvation. Only
        // transport running dry with own entries unread is (the dispatch completion below opens a
        // "consume-behind" event then). Opening one here fired once per message on low-TPS phones (read-ahead
        // target 1), with nothing delayed.
        const unreadOwn = this.consumeAheadMs !== undefined && this.ownUnread(lane) > 0;
        if (lane.queued === 0 && !unreadOwn) {
          lane.emptySince = dequeuedAt;
          lane.emptyCause = this.starvationCause(lane);
        }
        // Fail closed at the transport boundary, as consume() does at
        // adoption: an envelope whose exact lease is not known to be live is
        // never handed to the provider. Renewal keeps the bound ahead while
        // the lane is healthy; if renewal stopped (the database unreachable,
        // ownership lapsing), the lease may already have been reaped and the
        // job re-claimed under a new lease, and sending this copy would
        // duplicate it. The aborted registration is settled by dispatch,
        // fenced to this exact lease, without a provider call.
        if (!(leaseValidUntilMs > dequeuedAt) && !envelope.registration.signal.aborted) {
          envelope.registration.abort("Campaign lease expired before transport");
        }
        lane.providerInFlight += 1;
        // No await here: dequeue through transport start is exclusively the
        // worker's transport boundary, with no reservoir database operation.
        // A dispatch rejects only when recording its outcome failed (a settlement write in its catch block, e.g. a
        // database blip). Unhandled, that rejection exited the whole cell (process crash handlers), so every send in
        // flight ended delivery-unknown. Logged instead: the job keeps its exact lease, is no longer renewed, and the
        // reaper settles it when the lease lapses (requeued; re-preparation fails a possibly started intent
        // delivery-unknown, never re-sends it).
        void this.worker.dispatchReservoirEnvelope(envelope, new Date(), true).catch((error) => {
          campaignDispatchMetrics.brokerFailure();
          this.logLaneFailure(lane, "dispatch", error);
        }).finally(async () => {
          lane.providerInFlight -= 1;
          // P1: transport ran dry with the queue empty and no event open (the dequeue above opens none while own
          // entries wait unread). If own entries still wait unread, the reads are behind ("consume-behind").
          // Otherwise they were read and discarded rather than queued (a pause, a lapsed lease, STOP), so the lane
          // is dry exactly as the dequeue would have recorded it without read-ahead: the event is opened with that
          // classification, or the gap until the next refill would go unrecorded.
          if (
            lane.providerInFlight === 0 && lane.queued === 0 && lane.emptySince === undefined
            && this.consumeAheadMs !== undefined && !this.isInert(lane)
          ) {
            lane.emptySince = Date.now();
            lane.emptyCause = this.ownUnread(lane) > 0 ? "consume-behind" : this.starvationCause(lane);
          }
          this.queueAck(lane, delivery.id);
          this.service(lane);
          this.drain(lane);
        });
      }
      lane.draining = false;
    };
    run();
  }

  /**
   * Graceful stop, first half (V2-372). Stops claiming, consuming and admitting work, then waits, at most
   * `timeoutMs`, for every send already handed to transport to finish. A planned restart (every migration step is
   * one) must not abort HTTP calls in flight: an aborted call may already have reached Meta, so it ends
   * delivery-unknown and goes to manual reconciliation. Transport ownership is not revoked here; a send whose
   * ownership lapses before it starts is refused not-started, as always. Work still queued in the lanes or unread in
   * the broker is settled by stop(). Returns whether transport drained in time.
   */
  async quiesce(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    this.refillQueue.length = 0;
    const deadline = Date.now() + timeoutMs;
    const drained = () => [...this.lanes.values()].every((lane) => lane.providerInFlight === 0);
    while (!drained() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return drained();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.refillQueue.length = 0;
    // V2-372: runs after quiesce() (CampaignRuntime.stop), so sends in transport have drained or hit their bound.
    // Leave the membership first, so the other cells re-plan while this one settles its queued work; they acquire
    // each phone as soon as its lease is released below (or expires). Started, not awaited: the settlement of work that
    // never reached the provider is database-only and must not wait behind a Redis call (leave is time-bounded).
    const work: Promise<void>[] = [];
    if (this.assignment) work.push(this.assignment.leave());
    // V2-372: teardowns and handoff settlements already running finish before the broker closes.
    work.push(...this.teardowns.values());
    for (const lane of this.lanes.values()) {
      this.worker.revokeTransportOwnership(lane.phoneNumberId, lane.fencingToken);
      if (lane.settling) work.push(lane.settling);
      if (lane.refill) work.push(lane.refill);
      if (lane.service) work.push(lane.service);
      if (lane.recovery) work.push(lane.recovery);
      if (lane.ackFlushTimer) {
        clearTimeout(lane.ackFlushTimer);
        lane.ackFlushTimer = undefined;
      }
      if (lane.drainTimer) {
        clearTimeout(lane.drainTimer);
        lane.drainTimer = undefined;
      }
      if (lane.pendingAckIds.length) work.push(this.flushAcks(lane));
      work.push(this.discardQueued(lane, lane.queue.splice(0)));
      lane.queued = 0;
      work.push(this.settlePublished(lane, "Campaign runtime stopping before its envelope was consumed"));
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