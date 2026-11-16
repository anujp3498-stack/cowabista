// One campaign transport cell for the kill benchmark: the real CampaignRuntime with production defaults (100 ms
// tick, 30 s job lease, 5 s ownership TTL, production assignment timings), the default DelegatingWhatsAppSender and
// real HTTP sends from the shard threads to the local fake Graph server. No HTTP API, no test seams.
//
// Safety: refuses to start unless every send would go to KILL_BENCH_FAKE_GRAPH_URL (the shard threads resolve the
// same CAMPAIGN_TEST_GRAPH_BASE_URL, which is never honoured with NODE_ENV=production).
//
// Env: everything the runtime reads (DATABASE_URL, CAMPAIGN_REDIS_URL, CAMPAIGN_COORDINATOR_MODE=redis,
// CAMPAIGN_TRANSPORT_ASSIGNMENT / CAMPAIGN_TRANSPORT_PHONE_IDS, CAMPAIGN_CELL, WHATSAPP_CREDENTIAL_ENCRYPTION_KEY,
// CAMPAIGN_TEST_GRAPH_BASE_URL), plus KILL_BENCH_FAKE_GRAPH_URL and KILL_BENCH_METRICS (JSONL, one sample per second).
import { createWriteStream } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { campaignDispatchMetrics } from "../../src/services/campaign-dispatch-metrics";
import { CampaignWorker } from "../../src/services/campaign-queue";
import { CampaignRuntime } from "../../src/services/campaign-runtime";
import { directGraphBaseUrl } from "../../src/services/whatsapp-direct-sender";
import { DelegatingWhatsAppSender } from "../../src/services/whatsapp-template-sender";

const expected = process.env.KILL_BENCH_FAKE_GRAPH_URL?.replace(/\/+$/, "");
const resolved = directGraphBaseUrl(process.env);
if (!expected || resolved !== expected || process.env.NODE_ENV === "production" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(`${resolved}/`)) {
  console.error(`KILL_BENCH_REFUSED: sends would go to ${resolved}, expected the local fake Graph server ${expected ?? "(unset)"}`);
  process.exit(2);
}
const metricsPath = process.env.KILL_BENCH_METRICS;
if (!metricsPath) {
  console.error("KILL_BENCH_REFUSED: KILL_BENCH_METRICS is required");
  process.exit(2);
}

// Per-job timing (benchmark-only; the runtime's own code is untouched). Wrappers around three CampaignWorker methods
// and the optional sender hook the worker already calls after each shard HTTP call (observeShardTransport, absent in
// production, so defining it here changes no behaviour). Lines, written as they happen (a SIGKILL loses at most the
// stream's unflushed tail):
//   C,<claimStart>,<claimEnd>,<jobs>                      a claim batch (main-thread clock, ms)
//   P,<prepareStart>,<prepareEnd>,<jobs>,<prepared>       a preparation batch (template resolution, intents, ...)
//   J,<jobId>,<claimStart>,<prepared>,<dispatched>,<httpMs>,<accepted>
//      one provider-accepted send: when its claim started, when its batch was prepared, when it was handed to
//      transport, the shard's HTTP call duration (worker clock), and when the main thread saw the acceptance.
const timingsPath = process.env.KILL_BENCH_TIMINGS;
if (timingsPath) {
  const timings = createWriteStream(timingsPath, { flags: "a" });
  const claimedAt = new Map<number, number>();
  const preparedAt = new Map<number, number>();
  const dispatchedAt = new Map<number, number>();
  type Job = { id: number };
  const worker = CampaignWorker.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const claim = worker.claimPhoneBatch!;
  worker.claimPhoneBatch = async function (this: unknown, ...args: unknown[]) {
    const start = Date.now();
    const jobs = await claim.apply(this, args) as Job[];
    if (jobs.length) {
      timings.write(`C,${start},${Date.now()},${jobs.length}\n`);
      for (const job of jobs) claimedAt.set(job.id, start);
    }
    return jobs;
  };
  const prepare = worker.prepareReservoirBatch!;
  worker.prepareReservoirBatch = async function (this: unknown, ...args: unknown[]) {
    const start = Date.now();
    const prepared = await prepare.apply(this, args) as Array<{ job: Job }>;
    const end = Date.now();
    timings.write(`P,${start},${end},${(args[0] as Job[]).length},${prepared.length}\n`);
    for (const envelope of prepared) preparedAt.set(envelope.job.id, end);
    return prepared;
  };
  const dispatch = worker.dispatchReservoirEnvelope!;
  worker.dispatchReservoirEnvelope = function (this: unknown, ...args: unknown[]) {
    dispatchedAt.set((args[0] as { job: Job }).job.id, Date.now());
    return dispatch.apply(this, args);
  };
  (DelegatingWhatsAppSender.prototype as unknown as Record<string, unknown>).observeShardTransport = (
    job: Job, timing: { startedAt?: number; completedAt?: number; error?: unknown },
  ) => {
    const accepted = Date.now();
    if (!timing.error && timing.startedAt !== undefined && timing.completedAt !== undefined) {
      timings.write(`J,${job.id},${claimedAt.get(job.id) ?? ""},${preparedAt.get(job.id) ?? ""},${dispatchedAt.get(job.id) ?? ""},${(timing.completedAt - timing.startedAt).toFixed(2)},${accepted}\n`);
    }
    claimedAt.delete(job.id);
    preparedAt.delete(job.id);
    dispatchedAt.delete(job.id);
  };
  const flush = setInterval(() => timings.write(""), 1_000);
  flush.unref();
}

const runtime = new CampaignRuntime();
runtime.start();
const metrics = createWriteStream(metricsPath, { flags: "a" });
const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
// Lane metrics hold timers and other live objects: keep plain data only. A sampling error never stops the cell.
const plain = (_key: string, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype ? undefined : value;
const timer = setInterval(() => {
  let assignment: unknown = null;
  try { assignment = runtime.transportAssignment(); } catch { /* not ready */ }
  try {
  metrics.write(`${JSON.stringify({
    t: Date.now(), pid: process.pid, cell: process.env.CAMPAIGN_CELL ?? null,
    eventLoopP99Ms: Number((eld.percentile(99) / 1e6).toFixed(2)),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    dispatch: campaignDispatchMetrics.snapshot(),
    assignment,
    lanes: runtime.phoneLaneMetrics(),
  }, plain)}\n`);
  } catch (error) {
    metrics.write(`${JSON.stringify({ t: Date.now(), pid: process.pid, samplingError: String(error) })}\n`);
  }
  eld.reset();
}, 1_000);
timer.unref();

console.log(`KILL_BENCH_CELL_READY pid=${process.pid} cell=${process.env.CAMPAIGN_CELL ?? ""} graph=${resolved}`);

process.on("SIGTERM", () => {
  clearInterval(timer);
  void runtime.stop().finally(() => metrics.end(() => process.exit(0)));
});
