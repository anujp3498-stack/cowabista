// Transport cell for the shared-campaign experiment (Experiment B): boots the real CampaignRuntime with the
// benchmark transport sender and the phone scope from CAMPAIGN_TRANSPORT_PHONE_IDS, sends from a campaign that
// benchmark/campaign-benchmark.ts seeded in CAMPAIGN_BENCHMARK_SEED_ONLY mode (SEED_JSON names it), and records
// per-phone provider-start timestamps and the runtime's dispatch metrics once per second. It exits once every
// job of the campaign is terminal (or after CELL_MAX_SECONDS). Benchmark tooling only; never part of the server.
//
// Output (CELL_OUT directory): cell.jsonl (one sample per second) and cell.json (per-phone provider-start
// statistics in the harness's definitions: inter-start interval mean/p99, rolling-second peak, ceiling check).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pool as pgPool, type CampaignJob } from "@workspace/db";
import { CampaignRuntime } from "../../src/services/campaign-runtime";
import type { CampaignWorkerObserver, ProviderSender } from "../../src/services/campaign-queue";
import type { SerializableTransportPayload } from "../../src/services/campaign-transport-shards";

const OUT = process.env.CELL_OUT ?? ".";
mkdirSync(OUT, { recursive: true });
const seed = JSON.parse(readFileSync(process.env.SEED_JSON ?? "seed.json", "utf8")) as { campaignId: number; phoneIds: number[]; rows: number };
const CAMPAIGN_ID = Number(seed.campaignId);
const DELAY_MS = Number(process.env.CAMPAIGN_BENCHMARK_SEND_DELAY_MS ?? "10");
const CEILING = Number(process.env.CAMPAIGN_BENCHMARK_PROVIDER_TPS_LIMIT ?? "1000");
const MAX_SECONDS = Number(process.env.CELL_MAX_SECONDS ?? "1800");
const gitCommit = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const log = (record: Record<string, unknown>) => appendFileSync(path.join(OUT, "cell.jsonl"), JSON.stringify({ epoch: Date.now(), ...record }) + "\n");

const routePhone = new Map<number, number>();
const startsByPhone = new Map<number, number[]>();
let starts = 0; let completions = 0; let errors = 0; let firstStartEpoch: number | undefined;
const sender = {
  serializePreparedTransport(job): SerializableTransportPayload {
    return { kind: "benchmark", delayMs: DELAY_MS, providerMessageId: `cell-${job.idempotencyKey}-${job.attempts}` };
  },
  observeShardTransportStart(job: CampaignJob, startedAt: number) {
    starts += 1;
    if (firstStartEpoch === undefined) { firstStartEpoch = Date.now(); log({ event: "first-provider-start" }); }
    const phone = routePhone.get(job.routeId ?? -1) ?? -1;
    let list = startsByPhone.get(phone);
    if (!list) { list = []; startsByPhone.set(phone, list); }
    list.push(startedAt);
  },
  observeShardTransport(_job: CampaignJob, timing: { error?: Error }) { if (timing.error) errors += 1; else completions += 1; },
  async send() { await new Promise((resolve) => setTimeout(resolve, DELAY_MS)); return { providerMessageId: `cell-direct-${performance.now()}` }; },
} as ProviderSender;

// Worker phase timings (the same observer the harness attaches): settlement transaction duration including its
// lock wait, provider call, pacing wait, handoff. Kept as bounded samples per phase.
const phaseSamples = new Map<string, { ms: number[]; jobs: number; count: number; totalMs: number }>();
const observer: CampaignWorkerObserver = {
  record(phase: string, ms: number, jobs: number) {
    let p = phaseSamples.get(phase);
    if (!p) { p = { ms: [], jobs: 0, count: 0, totalMs: 0 }; phaseSamples.set(phase, p); }
    p.count += 1; p.jobs += jobs; p.totalMs += ms;
    if (p.ms.length < 50_000) p.ms.push(ms); else p.ms[Math.floor(Math.random() * p.ms.length)] = ms;
  },
};
function phaseSummary() {
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Number(s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(3)) : 0; };
  return Object.fromEntries([...phaseSamples].map(([phase, p]) => [phase, {
    count: p.count, jobs: p.jobs, meanMs: Number((p.totalMs / Math.max(1, p.count)).toFixed(3)), p50Ms: pct(p.ms, 0.5), p95Ms: pct(p.ms, 0.95), p99Ms: pct(p.ms, 0.99),
    jobsPerBusySecond: Number((1000 * p.jobs / Math.max(1, p.totalMs)).toFixed(1)),
  }]));
}

function intervalStats(timestamps: number[]) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; };
  let peak = 0;
  for (let lo = 0, hi = 0; hi < sorted.length; hi += 1) { while (sorted[hi]! - sorted[lo]! >= 1000) lo += 1; peak = Math.max(peak, hi - lo + 1); }
  const mean = intervals.length ? intervals.reduce((s, v) => s + v, 0) / intervals.length : 0;
  return { samples: intervals.length, meanMs: Number(mean.toFixed(3)), p95Ms: Number(pct(intervals, 0.95).toFixed(3)), p99Ms: Number(pct(intervals, 0.99).toFixed(3)), minMs: intervals.length ? Number(Math.min(...intervals).toFixed(3)) : 0, peakInRollingSecond: peak, ceilingSatisfied: peak <= CEILING };
}

async function main() {
  const routes = await pgPool.query<{ id: number; phone_number_id: number }>("select id, phone_number_id from campaign_routes where campaign_id = $1", [CAMPAIGN_ID]);
  for (const row of routes.rows) routePhone.set(row.id, row.phone_number_id);
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const runtime = new CampaignRuntime(sender, undefined, { batchSize: 256, observer });
  const bootEpoch = Date.now();
  writeFileSync(path.join(OUT, "cell.jsonl"), JSON.stringify({ event: "boot", epoch: bootEpoch, pid: process.pid, hostname: os.hostname(), gitCommit, campaignId: CAMPAIGN_ID, scope: process.env.CAMPAIGN_TRANSPORT_PHONE_IDS ?? null, rows: seed.rows }) + "\n");
  runtime.start(20);
  log({ event: "runtime-started", scope: [...(runtime.phoneScope() ?? [])] });
  let peakRss = 0; let idleSince: number | undefined; let stopping = false; let firstOwned = false;
  const tick = setInterval(async () => {
    try {
      const lanes = runtime.phoneLaneMetrics(); const dm = runtime.architectureDispatchMetrics();
      const owned = lanes.map((lane) => lane.phoneNumberId).sort((a, b) => a - b);
      if (owned.length && !firstOwned) { firstOwned = true; log({ event: "first-ownership", owned, tokens: lanes.map((l) => l.fencingToken) }); }
      const rss = process.memoryUsage().rss; peakRss = Math.max(peakRss, rss);
      const metrics = (await pgPool.query("select queued, processing, sent, failed from campaign_metrics where campaign_id = $1", [CAMPAIGN_ID])).rows[0];
      const open = metrics ? Number(metrics.queued) + Number(metrics.processing) : undefined;
      log({
        event: "sample", owned, denials: dm.ownershipDenials, starts, completions, errors,
        startsByPhone: Object.fromEntries([...startsByPhone].map(([phone, list]) => [phone, list.length])),
        transportStarts: dm.transportStarts, shardStarts: dm.shardStarts, shardEventLoopDelayMs: dm.shardEventLoopDelayMs,
        settlementPending: dm.settlementPending, settlementPeakPending: dm.settlementPeakPending, settlementBackpressureEvents: dm.settlementBackpressureEvents,
        settlementDrainedJobs: dm.settlementDrainedJobs, settlementDrainDurationMs: dm.settlementDrainDurationMs,
        reservoirStarvationMs: dm.reservoirStarvationMs, reservoirStarvationEvents: dm.reservoirStarvationEvents, brokerRecovered: dm.brokerRecovered,
        supplyRefills: dm.supplyRefillSamples, supplyRefillMs: dm.supplyRefillDurationMs,
        lanes: lanes.map((l) => ({ phone: l.phoneNumberId, token: l.fencingToken, queued: l.queued, inFlight: l.providerInFlight, brokerDepth: l.brokerDepth, refillMs: l.refillDurationMs })),
        eventLoopP95Ms: Number((loop.percentile(95) / 1e6).toFixed(2)), eventLoopP99Ms: Number((loop.percentile(99) / 1e6).toFixed(2)), rssBytes: rss,
        metrics, open, phases: phaseSummary(),
      });
      loop.reset();
      let done = open === 0;
      if (done) {
        const remaining = (await pgPool.query("select count(*)::int as n from campaign_jobs where campaign_id = $1 and status not in ('Sent','Failed')", [CAMPAIGN_ID])).rows[0]?.n;
        done = remaining === 0;
      }
      if (Date.now() - bootEpoch > MAX_SECONDS * 1000) { log({ event: "max-seconds" }); done = true; }
      if (done) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince > 3_000 && !stopping) {
          stopping = true; clearInterval(tick);
          const status = (await pgPool.query("select status from campaigns where id = $1", [CAMPAIGN_ID])).rows[0]?.status;
          log({ event: "drained", campaignStatus: status });
          await runtime.stop();
          const summary = {
            schemaVersion: 1, status: "ok", hostname: os.hostname(), gitCommit, campaignId: CAMPAIGN_ID, scope: process.env.CAMPAIGN_TRANSPORT_PHONE_IDS ?? null,
            bootEpoch, firstStartEpoch, endEpoch: Date.now(), starts, completions, errors, peakRssBytes: peakRss, campaignStatus: status,
            dispatchMetrics: runtime.architectureDispatchMetrics(),
            phaseTimings: phaseSummary(),
            phones: Object.fromEntries([...startsByPhone].map(([phone, list]) => [phone, { starts: list.length, ...intervalStats(list) }])),
          };
          writeFileSync(path.join(OUT, "cell.json"), JSON.stringify(summary, null, 2) + "\n");
          log({ event: "stopped" });
          await pgPool.end();
          process.exit(0);
        }
      } else idleSince = undefined;
    } catch (error) { log({ event: "error", message: String((error as Error)?.message ?? error) }); }
  }, 1_000);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, async () => {
    if (stopping) return; stopping = true; clearInterval(tick); log({ event: "signal", signal }); await runtime.stop(); log({ event: "stopped" }); process.exit(0);
  });
}
void main();
