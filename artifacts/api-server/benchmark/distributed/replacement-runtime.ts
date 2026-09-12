// Replacement transport cell for failover tests: boots the real CampaignRuntime with the benchmark transport
// sender and the phone scope from CAMPAIGN_TRANSPORT_PHONE_IDS, logs ownership/dispatch metrics once per second,
// and exits once the target campaign (P19_CAMPAIGN_ID) is no longer Running and all its jobs are Sent or Failed.
// Benchmark tooling only; never part of the production server.
import { performance } from "node:perf_hooks";
import { appendFileSync, writeFileSync } from "node:fs";
import { pool as pgPool } from "@workspace/db";
import { CampaignRuntime } from "../../src/services/campaign-runtime";
import type { ProviderSender } from "../../src/services/campaign-queue";
import type { SerializableTransportPayload } from "../../src/services/campaign-transport-shards";

const OUT = process.env.P19_LOG ?? "./replacement.jsonl";
const CAMPAIGN_ID = Number(process.env.P19_CAMPAIGN_ID ?? "0");
const DELAY_MS = Number(process.env.CAMPAIGN_BENCHMARK_SEND_DELAY_MS ?? "10");
writeFileSync(OUT, JSON.stringify({ event: "boot", epoch: Date.now(), pid: process.pid, scope: process.env.CAMPAIGN_TRANSPORT_PHONE_IDS ?? null, campaignId: CAMPAIGN_ID }) + "\n");
const log = (record: Record<string, unknown>) => appendFileSync(OUT, JSON.stringify({ epoch: Date.now(), ...record }) + "\n");

let starts = 0; let completions = 0; let firstStart = false;
const sender = {
  serializePreparedTransport(job): SerializableTransportPayload {
    return { kind: "benchmark", delayMs: DELAY_MS, providerMessageId: `replacement-${job.idempotencyKey}-${job.attempts}` };
  },
  observeShardTransportStart() { starts += 1; if (!firstStart) { firstStart = true; log({ event: "first-provider-start" }); } },
  observeShardTransport(_job, timing) { if (!timing.error) completions += 1; },
  async send() { await new Promise((resolve) => setTimeout(resolve, DELAY_MS)); return { providerMessageId: `replacement-direct-${performance.now()}` }; },
} as ProviderSender;

const runtime = new CampaignRuntime(sender, undefined, { batchSize: 256 });
runtime.start(20);
log({ event: "runtime-started", scope: [...(runtime.phoneScope() ?? [])] });
let firstOwned = false; let idleSince: number | undefined; let stopping = false;
const tick = setInterval(async () => {
  try {
    const lanes = runtime.phoneLaneMetrics(); const dm = runtime.architectureDispatchMetrics();
    const owned = lanes.map((lane) => lane.phoneNumberId).sort((a, b) => a - b);
    if (owned.length && !firstOwned) { firstOwned = true; log({ event: "first-ownership", owned, tokens: lanes.map((l) => l.fencingToken) }); }
    let campaignStatus: string | undefined; let remaining: number | undefined;
    if (CAMPAIGN_ID) {
      campaignStatus = (await pgPool.query("select status from campaigns where id = $1", [CAMPAIGN_ID])).rows[0]?.status;
      remaining = (await pgPool.query("select count(*)::int as n from campaign_jobs where campaign_id = $1 and status not in ('Sent','Failed')", [CAMPAIGN_ID])).rows[0]?.n;
    }
    log({ event: "sample", owned, denials: dm.ownershipDenials, transportStarts: dm.transportStarts, brokerRecovered: dm.brokerRecovered, settlementPending: dm.settlementPending, starts, completions, campaignStatus, remaining });
    const done = CAMPAIGN_ID ? (campaignStatus !== undefined && campaignStatus !== "Running" && remaining === 0) : (firstOwned && owned.length === 0);
    if (done) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 3_000 && !stopping) { stopping = true; log({ event: "drained", campaignStatus }); clearInterval(tick); await runtime.stop(); log({ event: "stopped" }); await pgPool.end(); process.exit(0); }
    } else idleSince = undefined;
  } catch (error) { log({ event: "error", message: String((error as Error)?.message ?? error) }); }
}, 1_000);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, async () => { if (stopping) return; stopping = true; clearInterval(tick); await runtime.stop(); log({ event: "stopped" }); process.exit(0); });
