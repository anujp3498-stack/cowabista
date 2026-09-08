import { Worker } from "node:worker_threads";
import { ProviderRequestError, type ProviderMode } from "./whatsapp-provider";
import { campaignDispatchMetrics } from "./campaign-dispatch-metrics";

export type SerializableTransportPayload =
  | {
    kind: "whatsapp";
    mode: ProviderMode;
    providerPhoneId: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
  }
  | {
    kind: "benchmark";
    delayMs: number;
    providerMessageId: string;
    error?: { message: string; retryable: boolean; code?: string; status?: number };
  };
export type ShardOutcome = {
  providerMessageId?: string;
  error?: Error;
  startedAt?: number;
  completedAt?: number;
  cancelledBeforeStart?: boolean;
  acknowledge: () => void;
};
type Pending = {
  worker: Worker;
  resolve: (outcome: ShardOutcome) => void;
  reject: (error: Error) => void;
  removeAbort: () => void;
  onStart?: (startedAt: number) => void;
  startedAt?: number;
};
type Ownership = { fencingToken: number; validUntilMs: number };

/** Fixed worker pool: a phone always maps to the same transport owner. */
export class CampaignTransportShards {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly ownershipByPhone = new Map<number, Ownership>();
  constructor(private readonly shardCount = Math.max(1, Math.min(16, Number(process.env.CAMPAIGN_TRANSPORT_SHARDS ?? 8)))) {
    for (let index = 0; index < shardCount; index += 1) {
      const worker = new Worker(new URL("./campaign-transport-shard-worker.mjs", import.meta.url), {
        workerData: { capacity: 8192, shardId: index },
      });
      worker.on("message", (message: any) => this.onMessage(index, worker, message));
      worker.on("error", (error) => this.failWorker(worker, error instanceof Error ? error : new Error(String(error))));
      worker.on("exit", (code) => { if (!this.closed && code) this.failWorker(worker, new Error(`Transport shard exited with code ${code}`)); });
      worker.unref();
      this.workers.push(worker);
    }
  }
  dispatch(
    phoneId: number,
    intervalMs: number,
    notBeforeMs: number,
    payload: SerializableTransportPayload,
    signal: AbortSignal,
    onStart?: (startedAt: number) => void,
  ): Promise<ShardOutcome> {
    if (this.closed) return Promise.reject(new Error("Transport shards are closed"));
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Send aborted"));
    const id = this.nextId++;
    const shardId = this.shardForPhone(phoneId);
    const worker = this.workers[shardId]!;
    const ownership = this.ownershipByPhone.get(phoneId);
    if (!ownership || ownership.validUntilMs <= Date.now()) {
      return Promise.reject(new Error(`Transport ownership is unavailable for phone ${phoneId}`));
    }
    return new Promise<ShardOutcome>((resolve, reject) => {
      const cancelledBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const cancelled = new Int32Array(cancelledBuffer);
      const abort = () => {
        Atomics.store(cancelled, 0, 1);
        worker.postMessage({ type: "cancel", id });
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { worker, resolve, reject, onStart, removeAbort: () => signal.removeEventListener("abort", abort) });
      campaignDispatchMetrics.shardQueued(1);
      worker.postMessage({
        type: "dispatch", id, phoneId, intervalMs, notBeforeMs, payload,
        cancelled: cancelledBuffer, fencingToken: ownership.fencingToken,
      });
    });
  }
  updatePhoneOwnership(phoneId: number, ownership: Ownership): void {
    this.ownershipByPhone.set(phoneId, ownership);
    const shardId = this.shardForPhone(phoneId);
    this.workers[shardId]!.postMessage({ type: "ownership", phoneId, ...ownership });
    campaignDispatchMetrics.phoneOwnership(phoneId, shardId, ownership.fencingToken, ownership.validUntilMs);
  }
  revokePhoneOwnership(phoneId: number, fencingToken?: number): void {
    const current = this.ownershipByPhone.get(phoneId);
    if (fencingToken !== undefined && current?.fencingToken !== fencingToken) return;
    this.ownershipByPhone.delete(phoneId);
    this.workers[this.shardForPhone(phoneId)]!.postMessage({ type: "ownership-revoked", phoneId, fencingToken });
    campaignDispatchMetrics.phoneOwnershipRevoked(phoneId);
  }
  /** Exposed for architecture assertions; this mapping never depends on queue state. */
  shardForPhone(phoneId: number): number {
    return (Math.imul(phoneId, 2_654_435_761) >>> 0) % this.workers.length;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.pending.values()) item.reject(new Error("Transport shards are closed"));
    this.pending.clear();
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
  private onMessage(shardId: number, worker: Worker, message: any): void {
    if (message.type === "start") {
      campaignDispatchMetrics.transportStart();
      campaignDispatchMetrics.shardStart(shardId, message.phoneId, message.queueDelayMs ?? 0);
      campaignDispatchMetrics.shardEventLoopDelay(message.eventLoopDelayMs ?? 0);
      const pending = this.pending.get(message.id);
      if (pending) {
        pending.startedAt = message.startedAt;
        pending.onStart?.(message.startedAt);
      }
      return; // deliberately asynchronous observability, never a send ACK
    }
    if (message.type === "status") {
      campaignDispatchMetrics.workerStatus(shardId, message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type !== "outcome" && message.type !== "rejected") return;
    this.pending.delete(message.id);
    campaignDispatchMetrics.shardQueued(-1);
    pending.removeAbort();
    const error = message.error?.provider
      ? new ProviderRequestError(message.error.message, message.error.retryable, message.error.code, message.error.status)
      : message.error ? new Error(message.error?.message ?? message.error) : undefined;
    let acknowledged = false;
    pending.resolve({
      providerMessageId: message.providerMessageId,
      error,
      startedAt: pending.startedAt,
      completedAt: message.completedAt,
      cancelledBeforeStart: message.cancelledBeforeStart === true,
      acknowledge: () => {
        if (acknowledged) return;
        acknowledged = true;
        worker.postMessage({ type: "outcome-ack", id: message.id });
      },
    });
  }
  private failWorker(worker: Worker, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id); pending.removeAbort(); pending.reject(error);
      campaignDispatchMetrics.shardQueued(-1);
    }
  }
}