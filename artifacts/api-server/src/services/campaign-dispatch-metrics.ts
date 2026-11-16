/**
 * Why a lane's queue was empty when it went empty (B13 R5), classified at that moment:
 *   source-empty-backoff   the lane was parked on the source-empty ladder (its last claim found nothing)
 *   outcome-backpressure   the sender had no preparation headroom, so the lane could not claim
 *   refill-in-flight       a claim/prepare/publish cycle was already running (supply latency)
 *   refill-queued          a refill was requested but waiting for a refill slot (refill concurrency)
 *   refill-not-armed       no refill had been requested (watermark not reached, or acknowledgement debt)
 *   consume-behind         P1: this lane's own entries were waiting unread in the stream with nothing in transport
 *                          (the bounded reads fell behind); ends when a read queues work
 */
export type ReservoirStarvationCause =
  | "source-empty-backoff" | "outcome-backpressure" | "refill-in-flight" | "refill-queued" | "refill-not-armed"
  | "consume-behind";
export type ReservoirStarvationEvent = {
  phoneNumberId: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  cause: ReservoirStarvationCause;
};
/** The most recent events kept per process; older ones are counted in reservoirStarvationLogDropped. */
export const RESERVOIR_STARVATION_LOG_LIMIT = 512;

export type CampaignDispatchMetricsSnapshot = {
  reservoirStarvationByCause: Partial<Record<ReservoirStarvationCause, { events: number; ms: number }>>;
  reservoirStarvationLog: ReservoirStarvationEvent[];
  reservoirStarvationLogDropped: number;
  reservoirDepth: number;
  reservoirPeakDepth: number;
  refillJobs: number;
  refillBatches: number;
  supplyClaimedJobs: number;
  supplyClaimDurationMs: number;
  supplyClaimSamples: number;
  supplyEmptyClaims: number;
  supplyRefillDurationMs: number;
  supplyRefillSamples: number;
  reservoirStarvationMs: number;
  reservoirStarvationEvents: number;
  brokerDepth: number;
  brokerPeakDepth: number;
  brokerConsumerLag: number;
  brokerPeakConsumerLag: number;
  brokerPublished: number;
  brokerConsumed: number;
  brokerRecovered: number;
  brokerFailures: number;
  brokerPartitions: Record<number, { depth: number; consumerLag: number }>;
  settlementDrainedJobs: number;
  settlementDrainDurationMs: number;
  settlementDrainSamples: number;
  settlementPending: number;
  settlementPeakPending: number;
  settlementBackpressureEvents: number;
  transportStarts: number;
  shardQueueDepth: number;
  shardQueuePeakDepth: number;
  shardStarts: number;
  shardQueueDelayMs: number;
  shardQueueDelayMaxMs: number;
  shardQueueDelaySamples: number;
  shardStartsByPhone: Record<number, number>;
  shardStartsByShard: Record<number, number>;
  phoneOwnership: Record<number, { shardId: number; fencingToken: number; validUntilMs: number }>;
  /** Discovery attempts inside this runtime's scope that another runtime's fenced lease refused. */
  ownershipDenials: number;
  credentialBinds: number;
  credentialBindFailures: number;
  /** V2-372: phones not taken because this runtime's reservoir capacity was full (one per refusal episode). */
  phoneCapacityRefusals: number;
  /** V2-372: graceful handoffs of a phone to its assigned cell started by this runtime. */
  phoneHandoffs: number;
  ownershipCoordinationLatencyMs: number;
  ownershipCoordinationLatencyMaxMs: number;
  ownershipCoordinationSamples: number;
  workers: Record<number, {
    threadId: number;
    queueDepth: number;
    unacknowledged: number;
    providerInFlight: number;
    providerStarts: number;
    cpuUtilizationPercent: number;
    ownedPhones: number[];
  }>;
  shardEventLoopDelayMs: number;
  shardEventLoopDelayMaxMs: number;
  /**
   * P0 (crash ambiguity, docs/DELIVERY_UNKNOWN_REDUCTION_PLAN.md). Delivery-unknown outcomes this process wrote,
   * by path: A = broker reclaim of a dead consumer's entry under an expired lease (Decision 8); B = re-preparation
   * of a job whose provider intent a dead process left pending (Decision 2). Counted once the job's failure
   * settlement commits, in the process that wrote it, so after a kill they appear in the survivors and the
   * restarted cell, never in the dead process.
   */
  crashUnknownBrokerReclaim: number;
  crashUnknownRepreparation: number;
  /**
   * Re-preparations, failed and committed, that found the intent already delivery_unknown: written by an earlier
   * reclaim or a provider timeout whose job settlement did not commit. Not in either crash path above.
   */
  repreparationPriorUnknown: number;
  /**
   * STOP fail-closed: sends an in-process STOP aborted after they may have reached the provider (no definite
   * provider answer), settled Failed for manual reconciliation instead of requeued. Counted once that settlement
   * commits. Not a crash path.
   */
  optOutInFlightUnknown: number;
  /**
   * Broker reclaim: expired leases examined (per reclaim pass, so a lease examined again on a later pass counts
   * again), and jobs found already accepted and settled Sent with the recorded id (B13 R3), counted on commit.
   */
  brokerReclaimExpired: number;
  brokerReclaimAlreadySent: number;
  /** Stale broker entries (a dead or previous owner's token, a lapsed lease) discarded at adoption as never sent. */
  brokerStaleDiscarded: number;
  /**
   * Decision 3 (Redis failures): this lane's own published work whose stream entry it could no longer read (a lost
   * XREADGROUP reply, or a lost stream or consumer group), settled as never started.
   */
  brokerLostEntries: number;
  /** P1: stream reads (XREADGROUP) issued, and how many returned nothing. */
  brokerReads: number;
  brokerEmptyReads: number;
};

class CampaignDispatchMetrics {
  private values: CampaignDispatchMetricsSnapshot = {
    reservoirStarvationByCause: {},
    reservoirStarvationLog: [],
    reservoirStarvationLogDropped: 0,
    reservoirDepth: 0,
    reservoirPeakDepth: 0,
    refillJobs: 0,
    refillBatches: 0,
    supplyClaimedJobs: 0,
    supplyClaimDurationMs: 0,
    supplyClaimSamples: 0,
    supplyEmptyClaims: 0,
    supplyRefillDurationMs: 0,
    supplyRefillSamples: 0,
    reservoirStarvationMs: 0,
    reservoirStarvationEvents: 0,
    brokerDepth: 0,
    brokerPeakDepth: 0,
    brokerConsumerLag: 0,
    brokerPeakConsumerLag: 0,
    brokerPublished: 0,
    brokerConsumed: 0,
    brokerRecovered: 0,
    brokerFailures: 0,
    brokerPartitions: {},
    settlementDrainedJobs: 0,
    settlementDrainDurationMs: 0,
    settlementDrainSamples: 0,
    settlementPending: 0,
    settlementPeakPending: 0,
    settlementBackpressureEvents: 0,
    transportStarts: 0,
    shardQueueDepth: 0,
    shardQueuePeakDepth: 0,
    shardStarts: 0,
    shardQueueDelayMs: 0,
    shardQueueDelayMaxMs: 0,
    shardQueueDelaySamples: 0,
    shardStartsByPhone: {},
    shardStartsByShard: {},
    phoneOwnership: {},
    ownershipDenials: 0,
    credentialBinds: 0,
    credentialBindFailures: 0,
    phoneCapacityRefusals: 0,
    phoneHandoffs: 0,
    ownershipCoordinationLatencyMs: 0,
    ownershipCoordinationLatencyMaxMs: 0,
    ownershipCoordinationSamples: 0,
    workers: {},
    shardEventLoopDelayMs: 0,
    shardEventLoopDelayMaxMs: 0,
    crashUnknownBrokerReclaim: 0,
    crashUnknownRepreparation: 0,
    repreparationPriorUnknown: 0,
    optOutInFlightUnknown: 0,
    brokerReclaimExpired: 0,
    brokerReclaimAlreadySent: 0,
    brokerStaleDiscarded: 0,
    brokerLostEntries: 0,
    brokerReads: 0,
    brokerEmptyReads: 0,
  };

  refill(jobs: number): void {
    this.values.refillJobs += jobs;
    this.values.refillBatches += 1;
    this.values.reservoirDepth += jobs;
    this.values.reservoirPeakDepth = Math.max(
      this.values.reservoirPeakDepth,
      this.values.reservoirDepth,
    );
  }
  supplyClaim(jobs: number, durationMs: number): void {
    this.values.supplyClaimedJobs += jobs;
    this.values.supplyClaimDurationMs += Math.max(0, durationMs);
    this.values.supplyClaimSamples += 1;
    if (jobs === 0) this.values.supplyEmptyClaims += 1;
  }
  supplyRefill(durationMs: number): void {
    this.values.supplyRefillDurationMs += Math.max(0, durationMs);
    this.values.supplyRefillSamples += 1;
  }
  reservoirStarvation(durationMs: number, detail?: { phoneNumberId: number; startedAtMs: number; cause: ReservoirStarvationCause }): void {
    const ms = Math.max(0, durationMs);
    this.values.reservoirStarvationMs += ms;
    this.values.reservoirStarvationEvents += 1;
    if (!detail) return;
    const byCause = this.values.reservoirStarvationByCause[detail.cause] ?? { events: 0, ms: 0 };
    byCause.events += 1;
    byCause.ms += ms;
    this.values.reservoirStarvationByCause[detail.cause] = byCause;
    this.values.reservoirStarvationLog.push({
      phoneNumberId: detail.phoneNumberId, startedAtMs: detail.startedAtMs,
      endedAtMs: detail.startedAtMs + ms, durationMs: ms, cause: detail.cause,
    });
    if (this.values.reservoirStarvationLog.length > RESERVOIR_STARVATION_LOG_LIMIT) {
      this.values.reservoirStarvationLog.shift();
      this.values.reservoirStarvationLogDropped += 1;
    }
  }
  brokerState(phoneNumberId: number, depth: number, consumerLag: number): void {
    this.values.brokerPartitions[phoneNumberId] = {
      depth: Math.max(0, depth),
      consumerLag: Math.max(0, consumerLag),
    };
    this.values.brokerDepth = Object.values(this.values.brokerPartitions)
      .reduce((total, partition) => total + partition.depth, 0);
    this.values.brokerPeakDepth = Math.max(this.values.brokerPeakDepth, depth);
    this.values.brokerConsumerLag = Object.values(this.values.brokerPartitions)
      .reduce((total, partition) => total + partition.consumerLag, 0);
    this.values.brokerPeakConsumerLag = Math.max(this.values.brokerPeakConsumerLag, consumerLag);
  }
  brokerPublished(jobs: number): void { this.values.brokerPublished += jobs; }
  brokerConsumed(jobs: number): void { this.values.brokerConsumed += jobs; }
  brokerRecovered(jobs: number): void { this.values.brokerRecovered += jobs; }
  brokerFailure(): void { this.values.brokerFailures += 1; }
  settlementDrained(jobs: number, durationMs: number): void {
    this.values.settlementDrainedJobs += jobs;
    this.values.settlementDrainDurationMs += Math.max(0, durationMs);
    this.values.settlementDrainSamples += 1;
  }
  shardEventLoopDelay(delayMs: number): void {
    this.values.shardEventLoopDelayMs += Math.max(0, delayMs);
    this.values.shardEventLoopDelayMaxMs = Math.max(this.values.shardEventLoopDelayMaxMs, delayMs);
  }

  transportStart(): void {
    this.values.transportStarts += 1;
    this.values.reservoirDepth = Math.max(0, this.values.reservoirDepth - 1);
  }
  shardQueued(delta: number): void {
    this.values.shardQueueDepth = Math.max(0, this.values.shardQueueDepth + delta);
    this.values.shardQueuePeakDepth = Math.max(this.values.shardQueuePeakDepth, this.values.shardQueueDepth);
  }
  shardStart(shardId: number, phoneId: number, queueDelayMs: number): void {
    this.values.shardStarts += 1;
    this.values.shardQueueDelayMs += Math.max(0, queueDelayMs);
    this.values.shardQueueDelayMaxMs = Math.max(this.values.shardQueueDelayMaxMs, queueDelayMs);
    this.values.shardQueueDelaySamples += 1;
    this.values.shardStartsByPhone[phoneId] = (this.values.shardStartsByPhone[phoneId] ?? 0) + 1;
    this.values.shardStartsByShard[shardId] = (this.values.shardStartsByShard[shardId] ?? 0) + 1;
  }
  phoneOwnership(phoneId: number, shardId: number, fencingToken: number, validUntilMs: number): void {
    this.values.phoneOwnership[phoneId] = { shardId, fencingToken, validUntilMs };
  }
  phoneOwnershipRevoked(phoneId: number): void {
    delete this.values.phoneOwnership[phoneId];
  }
  phoneOwnershipDenied(): void {
    this.values.ownershipDenials += 1;
  }
  /** Control-plane only: one per lane binding, never per message. */
  credentialBound(): void {
    this.values.credentialBinds += 1;
  }
  credentialBindFailed(): void {
    this.values.credentialBindFailures += 1;
  }
  phoneCapacityRefused(): void {
    this.values.phoneCapacityRefusals += 1;
  }
  phoneHandoffStarted(): void {
    this.values.phoneHandoffs += 1;
  }

  ownershipCoordination(latencyMs: number): void {
    this.values.ownershipCoordinationLatencyMs += Math.max(0, latencyMs);
    this.values.ownershipCoordinationLatencyMaxMs = Math.max(
      this.values.ownershipCoordinationLatencyMaxMs,
      latencyMs,
    );
    this.values.ownershipCoordinationSamples += 1;
  }
  workerStatus(shardId: number, status: CampaignDispatchMetricsSnapshot["workers"][number]): void {
    this.values.workers[shardId] = {
      threadId: Number(status.threadId),
      queueDepth: Number(status.queueDepth),
      unacknowledged: Number(status.unacknowledged),
      providerInFlight: Number(status.providerInFlight),
      providerStarts: Number(status.providerStarts),
      cpuUtilizationPercent: Number(status.cpuUtilizationPercent),
      ownedPhones: Array.isArray(status.ownedPhones) ? status.ownedPhones.map(Number) : [],
    };
  }

  settlementPending(delta: number): void {
    this.values.settlementPending = Math.max(0, this.values.settlementPending + delta);
    this.values.settlementPeakPending = Math.max(
      this.values.settlementPeakPending,
      this.values.settlementPending,
    );
  }

  /** P0: delivery-unknown outcomes written, by path (see the snapshot fields). */
  crashUnknown(path: "broker-reclaim" | "repreparation", jobs: number): void {
    if (jobs <= 0) return;
    if (path === "broker-reclaim") this.values.crashUnknownBrokerReclaim += jobs;
    else this.values.crashUnknownRepreparation += jobs;
  }
  repreparationPriorUnknown(jobs: number): void { this.values.repreparationPriorUnknown += jobs; }
  optOutInFlightUnknown(jobs: number): void { this.values.optOutInFlightUnknown += jobs; }
  brokerReclaim(expired: number, alreadySent: number): void {
    this.values.brokerReclaimExpired += expired;
    this.values.brokerReclaimAlreadySent += alreadySent;
  }
  brokerStaleDiscarded(jobs: number): void { this.values.brokerStaleDiscarded += jobs; }
  brokerLostEntries(jobs: number): void { this.values.brokerLostEntries += jobs; }
  brokerRead(entries: number): void {
    this.values.brokerReads += 1;
    if (entries === 0) this.values.brokerEmptyReads += 1;
  }

  settlementBackpressure(): void {
    this.values.settlementBackpressureEvents += 1;
  }

  snapshot(): CampaignDispatchMetricsSnapshot {
    return {
      ...this.values,
      reservoirStarvationByCause: Object.fromEntries(Object.entries(this.values.reservoirStarvationByCause)
        .map(([cause, value]) => [cause, { ...value }])) as CampaignDispatchMetricsSnapshot["reservoirStarvationByCause"],
      reservoirStarvationLog: this.values.reservoirStarvationLog.map((event) => ({ ...event })),
      shardStartsByPhone: { ...this.values.shardStartsByPhone },
      shardStartsByShard: { ...this.values.shardStartsByShard },
      phoneOwnership: { ...this.values.phoneOwnership },
      workers: Object.fromEntries(Object.entries(this.values.workers).map(([key, value]) => [
        key,
        { ...value, ownedPhones: [...value.ownedPhones] },
      ])),
    };
  }
}

export const campaignDispatchMetrics = new CampaignDispatchMetrics();