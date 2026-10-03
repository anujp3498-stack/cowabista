import { Worker } from "node:worker_threads";
import { ProviderRequestError, type ProviderMode } from "./whatsapp-provider";
import { campaignDispatchMetrics } from "./campaign-dispatch-metrics";

/**
 * Non-secret transport-auth reference carried by a prepared send. The
 * worker resolves "workspace_credential" against the binding installed
 * through the credential-bind control message; it never carries a token.
 * Absent/legacy_connector keeps the shared-connector path unchanged.
 */
export type TransportAuthRef =
  | { kind: "legacy_connector" }
  | { kind: "workspace_credential"; organizationId: number; credentialId: number; credentialRevision: number };

export type SerializableTransportPayload =
  | {
    kind: "whatsapp";
    mode: ProviderMode;
    providerPhoneId: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
    auth?: TransportAuthRef;
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
/** Parent-side, non-secret record of what the owning shard has acknowledged. */
export type BoundCredentialRef = { organizationId: number; credentialId: number; credentialRevision: number };
export type CredentialBinding = BoundCredentialRef & { accessToken: string };
type BindWaiter = { worker: Worker; phoneId: number; ref: BoundCredentialRef; resolve: () => void; reject: (error: Error) => void };
type ReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};
type WorkerState = {
  worker: Worker;
  ready: boolean;
  failure?: Error;
  waiters: Set<ReadyWaiter>;
};

/** Fixed worker pool: a phone always maps to the same transport owner. */
export class CampaignTransportShards {
  private readonly workers: Worker[] = [];
  private readonly workerStates: WorkerState[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly ownershipByPhone = new Map<number, Ownership>();
  private readonly credentialByPhone = new Map<number, BoundCredentialRef>();
  private readonly bindWaiters = new Map<number, BindWaiter>();
  private nextBindId = 1;
  constructor(
    private readonly shardCount = Math.max(1, Math.min(16, Number(process.env.CAMPAIGN_TRANSPORT_SHARDS ?? 8))),
    private readonly workerUrl: URL = new URL("./campaign-transport-shard-worker.mjs", import.meta.url),
  ) {
    for (let index = 0; index < shardCount; index += 1) {
      const worker = new Worker(this.workerUrl, {
        workerData: { capacity: 8192, shardId: index },
      });
      this.workerStates.push({
        worker,
        ready: false,
        waiters: new Set(),
      });
      worker.on("message", (message: any) => this.onMessage(index, worker, message));
      worker.on("error", (error) => this.failWorker(worker, error instanceof Error ? error : new Error(String(error))));
      worker.on("exit", (code) => {
        if (!this.closed) {
          this.failWorker(worker, new Error(`Transport shard exited unexpectedly with code ${code}`));
        }
      });
      worker.unref();
      this.workers.push(worker);
    }
  }
  async dispatch(
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
    let ownership = this.ownershipByPhone.get(phoneId);
    if (!ownership || ownership.validUntilMs <= Date.now()) {
      return Promise.reject(new Error(`Transport ownership is unavailable for phone ${phoneId}`));
    }

    await this.waitForWorkerReady(shardId);

    // State may have changed while worker startup was in progress.
    if (this.closed) {
      return Promise.reject(new Error("Transport shards are closed"));
    }
    if (signal.aborted) {
      return {
        error: new Error("Send aborted before provider start"),
        cancelledBeforeStart: true,
        acknowledge: () => {},
      };
    }
    ownership = this.ownershipByPhone.get(phoneId);
    if (!ownership || ownership.validUntilMs <= Date.now()) {
      return Promise.reject(new Error(`Transport ownership is unavailable for phone ${phoneId}`));
    }
    // Workspace-credential sends never leave the parent without an
    // acknowledged binding that matches the prepared reference. This is an
    // in-memory map lookup, not a query; the worker repeats the same check.
    if (payload.kind === "whatsapp" && payload.auth?.kind === "workspace_credential") {
      const bound = this.credentialByPhone.get(phoneId);
      const mismatch = bound && (
        bound.organizationId !== payload.auth.organizationId
        || bound.credentialId !== payload.auth.credentialId
        || bound.credentialRevision !== payload.auth.credentialRevision
      );
      if (!bound || mismatch) {
        return {
          error: new ProviderRequestError(
            bound ? "Workspace credential bound to transport does not match the prepared send" : "Workspace credential is not bound to transport",
            !bound,
            bound ? "credential_mismatch" : "credential_unbound",
          ),
          acknowledge: () => {},
        };
      }
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
    // Losing ownership also drops the shard's in-memory credential binding
    // (the worker clears its own copy on the same message).
    this.credentialByPhone.delete(phoneId);
    this.workers[this.shardForPhone(phoneId)]!.postMessage({ type: "ownership-revoked", phoneId, fencingToken });
    campaignDispatchMetrics.phoneOwnershipRevoked(phoneId);
  }
  /**
   * Installs a workspace credential on the phone's deterministic shard and
   * resolves only once that worker has acknowledged it. The token crosses the
   * thread boundary through this control message alone: never through
   * dispatch payloads, the broker or any log. Re-binding replaces the
   * previous binding.
   */
  async bindPhoneCredential(phoneId: number, binding: CredentialBinding): Promise<void> {
    if (this.closed) throw new Error("Transport shards are closed");
    const shardId = this.shardForPhone(phoneId);
    await this.waitForWorkerReady(shardId);
    if (this.closed) throw new Error("Transport shards are closed");
    const worker = this.workers[shardId]!;
    const requestId = this.nextBindId++;
    const ref: BoundCredentialRef = {
      organizationId: binding.organizationId,
      credentialId: binding.credentialId,
      credentialRevision: binding.credentialRevision,
    };
    await new Promise<void>((resolve, reject) => {
      this.bindWaiters.set(requestId, { worker, phoneId, ref, resolve, reject });
      worker.postMessage({ type: "credential-bind", requestId, phoneId, ...ref, accessToken: binding.accessToken });
    });
  }
  unbindPhoneCredential(phoneId: number): void {
    this.credentialByPhone.delete(phoneId);
    if (this.closed) return;
    this.workers[this.shardForPhone(phoneId)]!.postMessage({ type: "credential-unbind", phoneId });
  }
  /** Non-secret view of the acknowledged binding, for lane bookkeeping and tests. */
  boundCredential(phoneId: number): BoundCredentialRef | undefined {
    return this.credentialByPhone.get(phoneId);
  }
  /** Exposed for architecture assertions; this mapping never depends on queue state. */
  shardForPhone(phoneId: number): number {
    return (Math.imul(phoneId, 2_654_435_761) >>> 0) % this.workers.length;
  }
  async close(): Promise<void> {
    this.closed = true;
    const closeError = new Error("Transport shards are closed");
    for (const state of this.workerStates) {
      state.failure ??= closeError;
      for (const waiter of state.waiters) waiter.reject(closeError);
      state.waiters.clear();
    }
    for (const item of this.pending.values()) item.reject(closeError);
    this.pending.clear();
    for (const waiter of this.bindWaiters.values()) waiter.reject(closeError);
    this.bindWaiters.clear();
    this.credentialByPhone.clear();
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
  private onMessage(shardId: number, worker: Worker, message: any): void {
    if (message.type === "ready") {
      const state = this.workerStates[shardId];
      if (!state || state.worker !== worker || state.failure || state.ready) return;
      state.ready = true;
      for (const waiter of state.waiters) waiter.resolve();
      state.waiters.clear();
      return;
    }
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
    if (message.type === "credential-bound") {
      const waiter = this.bindWaiters.get(message.requestId);
      if (!waiter || waiter.worker !== worker) return;
      this.bindWaiters.delete(message.requestId);
      this.credentialByPhone.set(waiter.phoneId, waiter.ref);
      waiter.resolve();
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
  private waitForWorkerReady(shardId: number): Promise<void> {
    const state = this.workerStates[shardId];
    if (!state) {
      return Promise.reject(new Error(`Transport shard ${shardId} does not exist`));
    }
    if (state.failure) return Promise.reject(state.failure);
    if (state.ready) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;

      const waiter: ReadyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          state.waiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          state.waiters.delete(waiter);
          reject(error);
        },
      };

      timer = setTimeout(() => {
        const error = new Error(
          `Transport shard ${shardId} did not become ready within 5000ms`,
        );
        this.failWorker(state.worker, error);
        void state.worker.terminate();
      }, 5_000);

      state.waiters.add(waiter);
    });
  }

  private failWorker(worker: Worker, error: Error): void {
    const state = this.workerStates.find((candidate) => candidate.worker === worker);
    if (state && !state.failure) {
      state.failure = error;
      for (const waiter of state.waiters) waiter.reject(error);
      state.waiters.clear();
    }

    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id); pending.removeAbort(); pending.reject(error);
      campaignDispatchMetrics.shardQueued(-1);
    }
    for (const [id, waiter] of this.bindWaiters) {
      if (waiter.worker !== worker) continue;
      this.bindWaiters.delete(id);
      waiter.reject(error);
    }
    // A dead worker's memory is gone with it; nothing is bound any more.
    for (const [phoneId] of this.credentialByPhone) {
      if (this.workers[this.shardForPhone(phoneId)] === worker) this.credentialByPhone.delete(phoneId);
    }
  }
}