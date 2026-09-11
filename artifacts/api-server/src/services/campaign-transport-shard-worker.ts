import { parentPort, threadId, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { providerClient, ProviderRequestError } from "./whatsapp-provider";
import type { SerializableTransportPayload } from "./campaign-transport-shards";
import {
  arrivalNotBeforeAt, createPhoneCadence, dueAt, phaseFractionFor, recordStart, type PhoneCadence,
} from "./campaign-shard-pacing";

type Command = {
  type: "dispatch";
  id: number;
  phoneId: number;
  intervalMs: number;
  notBeforeMs: number;
  payload: SerializableTransportPayload;
  cancelled: SharedArrayBuffer;
  fencingToken: number;
} | { type: "cancel"; id: number }
  | { type: "ownership"; phoneId: number; fencingToken: number; validUntilMs: number }
  | { type: "ownership-revoked"; phoneId: number; fencingToken?: number }
  | { type: "outcome-ack"; id: number };

type Pending = Extract<Command, { type: "dispatch" }> & {
  /** Worker-clock time before which this item may not start (slot + phone phase, never in the past). */
  notBeforeAt: number;
};
const capacity = Number(workerData.capacity ?? 8192);
const pendingByPhone = new Map<number, Pending[]>();
const controllers = new Map<number, AbortController>();
const activePhoneById = new Map<number, number>();
const unacked = new Set<number>();
const cadenceByPhone = new Map<number, PhoneCadence>();
const ownershipByPhone = new Map<number, { fencingToken: number; validUntilMs: number }>();
const sleepWord = new Int32Array(new SharedArrayBuffer(4));
let queued = 0;
let pumping = false;
let starts = 0;
let previousCpu = process.threadCpuUsage();
let previousCpuAt = performance.now();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
async function waitUntil(deadline: number): Promise<void> {
  let remaining = deadline - performance.now();
  if (remaining > 2) {
    await sleep(remaining - 1);
    remaining = deadline - performance.now();
  }
  while (remaining > 0) {
    // Block on the futex for the whole remainder: the bounded catch-up
    // cadence absorbs the sub-millisecond wake latency, so no spin is needed.
    Atomics.wait(sleepWord, 0, 0, remaining);
    remaining = deadline - performance.now();
  }
}
function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function errorData(error: unknown) {
  if (error instanceof ProviderRequestError) {
    return { message: error.message, provider: true, retryable: error.retryable, code: error.code, status: error.status };
  }
  return { message: error instanceof Error ? error.message : String(error), provider: false };
}
function wasCancelled(item: Pending): boolean {
  return Atomics.load(new Int32Array(item.cancelled), 0) === 1;
}
function owns(item: Pending): boolean {
  const ownership = ownershipByPhone.get(item.phoneId);
  return ownership?.fencingToken === item.fencingToken && ownership.validUntilMs > Date.now();
}
async function invoke(item: Pending, signal: AbortSignal): Promise<string> {
  if (wasCancelled(item)) throw signal.reason instanceof Error ? signal.reason : new Error("Send aborted");
  if (item.payload.kind === "benchmark") {
    const payload = item.payload;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.max(0, payload.delayMs));
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Send aborted"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    if (payload.error) {
      throw new ProviderRequestError(
        payload.error.message,
        payload.error.retryable,
        payload.error.code,
        payload.error.status,
      );
    }
    return payload.providerMessageId;
  }
  const payload = item.payload;
  const timeoutController = new AbortController();
  const combined = AbortSignal.any([signal, timeoutController.signal]);
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Provider send timed out after ${payload.timeoutMs}ms`);
      timeoutController.abort(error);
      reject(error);
    }, payload.timeoutMs);
  });
  try {
    return await Promise.race([
      providerClient(payload.mode)
        .send(payload.providerPhoneId, payload.payload, combined),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function cadenceFor(phoneId: number): PhoneCadence {
  let cadence = cadenceByPhone.get(phoneId);
  if (!cadence) {
    cadence = createPhoneCadence();
    cadenceByPhone.set(phoneId, cadence);
  }
  return cadence;
}
function nextDispatch(): { item: Pending; due: number } | undefined {
  let selected: { item: Pending; due: number } | undefined;
  const now = performance.now();
  for (const [phoneId, queue] of pendingByPhone) {
    const item = queue[0];
    if (!item) continue;
    const due = dueAt(cadenceFor(phoneId), item.notBeforeAt, item.intervalMs, now);
    if (!selected || due < selected.due || (due === selected.due && item.id < selected.item.id)) {
      selected = { item, due };
    }
  }
  return selected;
}
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queued > 0) {
      if (unacked.size >= capacity) return;
      const selected = nextDispatch();
      if (!selected) return;
      const { item, due } = selected;
      await waitUntil(due);
      const phoneQueue = pendingByPhone.get(item.phoneId);
      if (!phoneQueue || phoneQueue[0]?.id !== item.id) continue;
      phoneQueue.shift();
      queued -= 1;
      if (wasCancelled(item) || !owns(item)) {
        parentPort!.postMessage({
          type: "outcome",
          id: item.id,
          cancelledBeforeStart: true,
          error: {
            message: wasCancelled(item)
              ? "Send aborted before provider start"
              : "Phone ownership lease expired before provider start",
            provider: false,
          },
          completedAt: performance.now(),
        });
        continue;
      }
      // Bounded catch-up: ordinary wake latency stays on the absolute cadence,
      // larger stalls reset to the actual start and are never replayed.
      const startedAt = performance.now();
      if (!owns(item)) continue;
      recordStart(cadenceFor(item.phoneId), due, startedAt, item.intervalMs);
      starts += 1;
      parentPort!.postMessage({
        type: "start",
        id: item.id,
        phoneId: item.phoneId,
        startedAt,
        queueDelayMs: Math.max(0, Date.now() - item.notBeforeMs),
        eventLoopDelayMs: Math.max(0, startedAt - due),
      });
      // Do not make unrelated phone lanes wait for a slow HTTP response. The
      // shard owns both their pacing cursors and their concurrent transports.
      const controller = new AbortController();
      controllers.set(item.id, controller);
      activePhoneById.set(item.id, item.phoneId);
      void invoke(item, controller.signal)
        .then((providerMessageId) => {
          unacked.add(item.id);
          parentPort!.postMessage({ type: "outcome", id: item.id, providerMessageId, completedAt: performance.now() });
        }, (error) => {
          unacked.add(item.id);
          parentPort!.postMessage({ type: "outcome", id: item.id, error: errorData(error), completedAt: performance.now() });
        })
        .finally(() => {
          controllers.delete(item.id);
          activePhoneById.delete(item.id);
        });
      // Give provider timers/promises on this execution plane a turn without
      // making the next cadence depend on their completion.
      await immediate();
    }
  } finally {
    pumping = false;
    if (queued > 0 && unacked.size < capacity) void pump();
  }
}
parentPort!.on("message", (command: Command) => {
  if (command.type === "dispatch") {
    if (queued + unacked.size + controllers.size >= capacity) {
      parentPort!.postMessage({ type: "rejected", id: command.id, error: "Transport shard queue is full" });
      return;
    }
    const phoneQueue = pendingByPhone.get(command.phoneId) ?? [];
    phoneQueue.push({
      ...command,
      notBeforeAt: arrivalNotBeforeAt(
        performance.now(),
        command.notBeforeMs - Date.now(),
        command.intervalMs,
        phaseFractionFor(command.phoneId),
      ),
    });
    pendingByPhone.set(command.phoneId, phoneQueue);
    queued += 1;
    void pump();
  } else if (command.type === "cancel") {
    for (const queue of pendingByPhone.values()) {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0) continue;
      queue.splice(index, 1);
      queued -= 1;
      parentPort!.postMessage({
        type: "outcome",
        id: command.id,
        cancelledBeforeStart: true,
        error: { message: "Send aborted before provider start", provider: false },
        completedAt: performance.now(),
      });
      break;
    }
    controllers.get(command.id)?.abort(new Error("Send aborted"));
  } else if (command.type === "ownership") {
    ownershipByPhone.set(command.phoneId, {
      fencingToken: command.fencingToken,
      validUntilMs: command.validUntilMs,
    });
    void pump();
  } else if (command.type === "ownership-revoked") {
    const current = ownershipByPhone.get(command.phoneId);
    if (command.fencingToken === undefined || current?.fencingToken === command.fencingToken) {
      ownershipByPhone.delete(command.phoneId);
      for (const queue of pendingByPhone.values()) {
        for (const item of queue) {
          if (item.phoneId === command.phoneId) Atomics.store(new Int32Array(item.cancelled), 0, 1);
        }
      }
      for (const [id, phoneId] of activePhoneById) {
        if (phoneId === command.phoneId) controllers.get(id)?.abort(new Error("Phone ownership revoked"));
      }
    }
  } else {
    unacked.delete(command.id);
    void pump();
  }
});

const statusTimer = setInterval(() => {
  const now = performance.now();
  const cpu = process.threadCpuUsage();
  const cpuMicros = (cpu.user - previousCpu.user) + (cpu.system - previousCpu.system);
  const elapsedMs = Math.max(1, now - previousCpuAt);
  previousCpu = cpu;
  previousCpuAt = now;
  parentPort!.postMessage({
    type: "status",
    shardId: Number(workerData.shardId),
    threadId,
    queueDepth: queued,
    unacknowledged: unacked.size,
    providerInFlight: controllers.size,
    providerStarts: starts,
    cpuUtilizationPercent: cpuMicros / (elapsedMs * 10),
    ownedPhones: [...ownershipByPhone.keys()],
  });
}, 1_000);
statusTimer.unref();