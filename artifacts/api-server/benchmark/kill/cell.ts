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
import { CampaignRuntime } from "../../src/services/campaign-runtime";
import { directGraphBaseUrl } from "../../src/services/whatsapp-direct-sender";

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
