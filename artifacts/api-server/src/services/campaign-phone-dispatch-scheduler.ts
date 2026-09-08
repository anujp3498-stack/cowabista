import { Worker } from "node:worker_threads";

const QUEUE_CAPACITY = 16_384;
const HEADER_WRITE = 0;
const HEADER_READ = 1;
const HEADER_CLOSED = 2;
const HEADER_ACK = 3;

type PendingWaiter = {
  signal: AbortSignal;
  settled: boolean;
  resolve: (permit: DispatchPermit) => void;
  reject: (error: Error) => void;
  removeAbort: () => void;
};

export type DispatchPermit = {
  /** Acknowledges the exact provider-call boundary and returns main-thread handoff delay. */
  acknowledgeDispatch: () => number;
};

type PhoneLane = {
  worker: Worker;
  header: Int32Array;
  ids: Int32Array;
  notBeforeEpochMs: Float64Array;
  intervalsMs: Float64Array;
  ackAtMs: Float64Array;
  nextId: number;
  waiters: Map<number, PendingWaiter>;
  closed: boolean;
};

const PHONE_PACER_WORKER = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { performance } = require("node:perf_hooks");

  const HEADER_WRITE = 0;
  const HEADER_READ = 1;
  const HEADER_CLOSED = 2;
  const HEADER_ACK = 3;
  const header = new Int32Array(workerData.header);
  const ids = new Int32Array(workerData.ids);
  const notBeforeEpochMs = new Float64Array(workerData.notBeforeEpochMs);
  const intervalsMs = new Float64Array(workerData.intervalsMs);
  const ackAtMs = new Float64Array(workerData.ackAtMs);
  const sleepWord = new Int32Array(new SharedArrayBuffer(4));
  const capacity = workerData.capacity;
  const phaseFraction = workerData.phaseFraction;
  const pending = [];
  const history = [];
  let read = 0;
  let nextAt = 0;

  function nowFromEpoch(epochMs) {
    return performance.now() + Math.max(0, epochMs - Date.now());
  }

  function drainSharedQueue() {
    const write = Atomics.load(header, HEADER_WRITE);
    while (read < write) {
      const index = read % capacity;
      pending.push({
        id: ids[index],
        // Keep every phone on its own deterministic sub-interval phase.
        // Independent workers otherwise wake on identical millisecond
        // boundaries and contend while posting to the shared main event loop.
        // This is a uniform shift, not catch-up: every slot retains the same
        // interval and stale slots are still reset after a larger delay.
        notBeforeAt: nowFromEpoch(notBeforeEpochMs[index]) + intervalsMs[index] * phaseFraction,
        intervalMs: intervalsMs[index],
      });
      read += 1;
    }
    Atomics.store(header, HEADER_READ, read);
    pending.sort((left, right) =>
      left.notBeforeAt - right.notBeforeAt || left.id - right.id);
  }

  function waitForWorkOrDeadline(deadline) {
    for (;;) {
      if (Atomics.load(header, HEADER_CLOSED)) return false;
      const now = performance.now();
      const remaining = deadline - now;
      if (remaining <= 0) return true;
      const observedWrite = Atomics.load(header, HEADER_WRITE);
      if (remaining > 0.7) {
        Atomics.wait(header, HEADER_WRITE, observedWrite, Math.max(0, remaining - 0.4));
        if (Atomics.load(header, HEADER_WRITE) !== observedWrite) return true;
      }
    }
  }

  function run() {
    for (;;) {
      if (Atomics.load(header, HEADER_CLOSED)) return;
      drainSharedQueue();
      if (!pending.length) {
        const observedWrite = Atomics.load(header, HEADER_WRITE);
        Atomics.wait(header, HEADER_WRITE, observedWrite);
        continue;
      }

      const waiter = pending[0];
      let now = performance.now();
      while (history.length && history[0] <= now - 1_000) history.shift();
      const rollingLimit = Math.max(1, Math.floor(1_000 / waiter.intervalMs));
      const previousDispatchAt = history.length ? history[history.length - 1] : undefined;
      const minimumHandoffGapMs = waiter.intervalMs * 0.25;
      let dueAt = Math.max(
        nextAt || now,
        waiter.notBeforeAt,
        previousDispatchAt === undefined ? 0 : previousDispatchAt + minimumHandoffGapMs,
      );
      if (history.length >= rollingLimit) {
        dueAt = Math.max(dueAt, history[0] + 1_001);
      }

      if (!waitForWorkOrDeadline(dueAt)) return;
      if (Atomics.load(header, HEADER_WRITE) > read) continue;
      now = performance.now();
      if (now < dueAt) continue;
      pending.shift();

      const ackSequence = Atomics.load(header, HEADER_ACK);
      parentPort.postMessage(waiter.id);
      while (
        !Atomics.load(header, HEADER_CLOSED)
        && Atomics.load(header, HEADER_ACK) === ackSequence
      ) {
        Atomics.wait(header, HEADER_ACK, ackSequence);
      }
      if (Atomics.load(header, HEADER_CLOSED)) return;

      const actualDispatchAt = ackAtMs[0];
      history.push(actualDispatchAt);
      // Integrated profiling shows ~3ms event-loop p99 at 1000 TPS. Keep
      // ordinary host jitter on the absolute cadence, while larger stalls
      // reset to the actual handoff and are never replayed.
      const recoverableLagMs = waiter.intervalMs * 4;
      const latenessMs = Math.max(0, actualDispatchAt - dueAt);
      const cadenceBase = latenessMs <= recoverableLagMs ? dueAt : actualDispatchAt;
      nextAt = Math.max(
        cadenceBase + waiter.intervalMs,
        actualDispatchAt + minimumHandoffGapMs,
      );
    }
  }

  run();
`;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Send aborted");
}

/**
 * One independent pacing worker per phone number. PostgreSQL/Redis reserve
 * globally-authoritative future slots; this layer turns those slots into
 * steady provider-start permits without making the main Node event loop wake
 * once per millisecond. The acknowledgement records the actual provider-call
 * boundary, so delayed event-loop delivery cannot accumulate into a burst.
 */
export class PhoneDispatchScheduler {
  private readonly lanes = new Map<number, PhoneLane>();
  private closed = false;

  wait(
    phoneNumberId: number,
    intervalMs: number,
    signal: AbortSignal,
    scheduledAt: Date | null,
  ): Promise<DispatchPermit> {
    if (this.closed) return Promise.reject(new Error("Phone dispatch scheduler is closed"));
    if (signal.aborted) return Promise.reject(abortError(signal));
    const lane = this.lanes.get(phoneNumberId) ?? this.createLane(phoneNumberId);
    const write = Atomics.load(lane.header, HEADER_WRITE);
    const read = Atomics.load(lane.header, HEADER_READ);
    if (write - read >= QUEUE_CAPACITY) {
      return Promise.reject(new Error(`Phone ${phoneNumberId} dispatch queue is full`));
    }

    const waiterId = lane.nextId++;
    const index = write % QUEUE_CAPACITY;
    lane.ids[index] = waiterId;
    lane.notBeforeEpochMs[index] = scheduledAt?.getTime() ?? Date.now();
    lane.intervalsMs[index] = intervalMs;

    return new Promise<DispatchPermit>((resolve, reject) => {
      const waiter: PendingWaiter = {
        signal,
        settled: false,
        resolve: (permit) => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.removeAbort();
          resolve(permit);
        },
        reject: (error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.removeAbort();
          reject(error);
        },
        removeAbort: () => signal.removeEventListener("abort", onAbort),
      };
      const onAbort = () => waiter.reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      lane.waiters.set(waiterId, waiter);
      Atomics.store(lane.header, HEADER_WRITE, write + 1);
      Atomics.notify(lane.header, HEADER_WRITE, 1);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.lanes.values()].map(async (lane) => {
      lane.closed = true;
      Atomics.store(lane.header, HEADER_CLOSED, 1);
      Atomics.add(lane.header, HEADER_ACK, 1);
      Atomics.notify(lane.header, HEADER_WRITE, 1);
      Atomics.notify(lane.header, HEADER_ACK, 1);
      for (const waiter of lane.waiters.values()) {
        waiter.reject(new Error("Phone dispatch scheduler closed"));
      }
      lane.waiters.clear();
      await lane.worker.terminate();
    }));
    this.lanes.clear();
  }

  private createLane(phoneNumberId: number): PhoneLane {
    const headerBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const idsBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * QUEUE_CAPACITY);
    const notBeforeBuffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * QUEUE_CAPACITY);
    const intervalsBuffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * QUEUE_CAPACITY);
    const ackAtBuffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT);
    const lane: PhoneLane = {
      worker: new Worker(PHONE_PACER_WORKER, {
        eval: true,
        workerData: {
          header: headerBuffer,
          ids: idsBuffer,
          notBeforeEpochMs: notBeforeBuffer,
          intervalsMs: intervalsBuffer,
          ackAtMs: ackAtBuffer,
          capacity: QUEUE_CAPACITY,
          // Knuth's multiplicative hash gives adjacent phone ids distinct,
          // stable phases without needing cross-lane coordination.
          phaseFraction: ((Math.imul(phoneNumberId, 2_654_435_761) >>> 0) / 2 ** 32),
        },
      }),
      header: new Int32Array(headerBuffer),
      ids: new Int32Array(idsBuffer),
      notBeforeEpochMs: new Float64Array(notBeforeBuffer),
      intervalsMs: new Float64Array(intervalsBuffer),
      ackAtMs: new Float64Array(ackAtBuffer),
      nextId: 1,
      waiters: new Map(),
      closed: false,
    };
    lane.worker.on("message", (waiterId: number) => {
      const readyAt = performance.now();
      const waiter = lane.waiters.get(waiterId);
      let acknowledged = false;
      const acknowledgeDispatch = () => {
        if (acknowledged) return 0;
        acknowledged = true;
        lane.ackAtMs[0] = performance.now();
        Atomics.add(lane.header, HEADER_ACK, 1);
        Atomics.notify(lane.header, HEADER_ACK, 1);
        return lane.ackAtMs[0] - readyAt;
      };
      if (!waiter) {
        acknowledgeDispatch();
        return;
      }
      lane.waiters.delete(waiterId);
      if (waiter.signal.aborted) {
        acknowledgeDispatch();
        waiter.reject(abortError(waiter.signal));
      } else {
        waiter.resolve({ acknowledgeDispatch });
      }
    });
    lane.worker.on("error", (error: unknown) => {
      const workerError = error instanceof Error ? error : new Error(String(error));
      for (const waiter of lane.waiters.values()) waiter.reject(workerError);
      lane.waiters.clear();
    });
    lane.worker.on("exit", (code) => {
      if (lane.closed || code === 0) return;
      const error = new Error(`Phone ${phoneNumberId} dispatch worker exited with code ${code}`);
      for (const waiter of lane.waiters.values()) waiter.reject(error);
      lane.waiters.clear();
    });
    // Event listeners reference a Worker again, so unref only after all
    // handlers are attached. Test/one-shot CampaignWorkers that do not own a
    // CampaignRuntime shutdown path must not keep the process alive.
    lane.worker.unref();
    this.lanes.set(phoneNumberId, lane);
    return lane;
  }
}