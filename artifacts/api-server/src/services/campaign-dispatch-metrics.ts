export type CampaignDispatchMetricsSnapshot = {
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
};

class CampaignDispatchMetrics {
  private values: CampaignDispatchMetricsSnapshot = {
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
    ownershipCoordinationLatencyMs: 0,
    ownershipCoordinationLatencyMaxMs: 0,
    ownershipCoordinationSamples: 0,
    workers: {},
    shardEventLoopDelayMs: 0,
    shardEventLoopDelayMaxMs: 0,
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
  reservoirStarvation(durationMs: number): void {
    this.values.reservoirStarvationMs += Math.max(0, durationMs);
    this.values.reservoirStarvationEvents += 1;
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

  settlementBackpressure(): void {
    this.values.settlementBackpressureEvents += 1;
  }

  snapshot(): CampaignDispatchMetricsSnapshot {
    return {
      ...this.values,
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