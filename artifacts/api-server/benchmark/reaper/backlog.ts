/*
 * Reaper backlog study. Benchmark-only (not a Gate B measured file); never run against a shared, benchmark-of-record
 * or production database: it refuses any database whose name does not contain "reaper_study".
 *
 * Seeds campaigns whose jobs sit in 'Processing' under expired leases (what dead cells leave behind), optionally next
 * to a large number of settled jobs per campaign (reconcileCampaignJobs recounts the whole campaign for every batch
 * it reaps), then runs the REAL CampaignRuntime housekeeping on its production cadence (setInterval every
 * HOUSEKEEPING_INTERVAL_MS; a pass is skipped while the previous one runs; each pass reaps in batches of
 * REAP_BATCH_LIMIT, oldest expiry first, within REAP_PASS_BUDGET_MS), in one or more runtimes (cells) at once.
 * It samples every 50 ms which jobs have left 'Processing' and reports:
 *   - completion: time until no expired lease is left, and the reap rate;
 *   - per campaign: when its first and last job were reaped, against its expiry rank (fairness = FIFO by expiry);
 *   - the probe: one job whose lease expired LAST (after the whole backlog) - how long it waited (starvation bound);
 *   - housekeeping: pass durations and how many ticks were skipped because a pass was still running.
 *
 * Usage (from artifacts/api-server): node benchmark/reaper/run.mjs --label <name> [--campaigns 20]
 *   [--expired-per-campaign 500] [--settled-per-campaign 0] [--cells 1] [--timeout-s 300]
 * Env: DATABASE_URL = REAPER_STUDY_DATABASE_URL (name containing "reaper_study"; created with the guarded
 * reset-disposable-local + push).
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { CampaignRuntime } from "../../src/services/campaign-runtime";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}
const label = process.argv[process.argv.indexOf("--label") + 1];
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("--label <name> is required");
const campaigns = arg("campaigns", 20);
const expiredPerCampaign = arg("expired-per-campaign", 500);
const settledPerCampaign = arg("settled-per-campaign", 0);
const cells = Math.max(1, arg("cells", 1));
const timeoutS = arg("timeout-s", 300);
const out = process.env.REAPER_STUDY_OUT;
if (!out) throw new Error("REAPER_STUDY_OUT is required");

const url = process.env.DATABASE_URL ?? "";
if (url !== process.env.REAPER_STUDY_DATABASE_URL || !/reaper_study/.test(new URL(url).pathname)) {
  throw new Error("refusing: DATABASE_URL must equal REAPER_STUDY_DATABASE_URL and name a reaper_study database");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- seed ------------------------------------------------------------------------------------------------------
const slug = `reaper-${label}-${Date.now()}`;
await db.execute(sql`truncate campaign_jobs, campaign_contacts, campaign_routes, campaign_metrics, campaign_metric_deltas, campaigns cascade`);
const [{ id: orgId }] = (await db.execute<{ id: number }>(sql`
  insert into organizations (name, slug) values (${slug}, ${slug}) returning id`)).rows;
const [{ id: wabaId }] = (await db.execute<{ id: number }>(sql`
  insert into wabas (organization_id, external_id, display_name) values (${orgId}, ${`${slug}-waba`}, ${slug}) returning id`)).rows;
const [{ id: phoneId }] = (await db.execute<{ id: number }>(sql`
  insert into phone_numbers (organization_id, waba_id, phone, display_name, status, tps_limit)
  values (${orgId}, ${wabaId}, ${`+1998${String(orgId).padStart(7, "0")}`}, ${slug}, 'Connected', 1000) returning id`)).rows;
// Expiries: campaign c's jobs expired at (base + c * spread), so campaign 0 is the oldest; the probe expires last.
const base = Date.now() - 120_000;
const spreadMs = 1_000;
const campaignIds: number[] = [];
for (let c = 0; c <= campaigns; c += 1) {
  const probe = c === campaigns;
  const expired = probe ? 1 : expiredPerCampaign;
  const settled = probe ? 0 : settledPerCampaign;
  const [{ id: campaignId }] = (await db.execute<{ id: number }>(sql`
    insert into campaigns (organization_id, name, status) values (${orgId}, ${`${slug}-c${c}`}, 'Running') returning id`)).rows;
  campaignIds.push(campaignId);
  const [{ id: routeId }] = (await db.execute<{ id: number }>(sql`
    insert into campaign_routes (organization_id, campaign_id, phone_number_id, configured_tps, queue_depth)
    values (${orgId}, ${campaignId}, ${phoneId}, 1000, ${expired}) returning id`)).rows;
  await db.execute(sql`
    insert into campaign_metrics (organization_id, campaign_id, total, valid, queued, processing, sent)
    values (${orgId}, ${campaignId}, ${expired + settled}, ${expired + settled}, 0, ${expired}, ${settled})`);
  const expiresAt = new Date(probe ? Date.now() - 1_000 : base + c * spreadMs).toISOString();
  await db.execute(sql`
    insert into campaign_jobs (organization_id, campaign_id, route_id, type, status, idempotency_key, attempts, max_attempts,
                               lease_token, locked_by, locked_at, lease_expires_at, available_at)
    select ${orgId}::int, ${campaignId}::int, ${routeId}::int, 'ResolveTemplateAndSend', 'Processing',
           ${`${slug}-c${c}-e-`}::text || g::text, 1, 5, ${`${slug}-dead-lease-`}::text || g::text, 'dead-cell',
           ${expiresAt}::timestamptz - interval '30 seconds', ${expiresAt}::timestamptz, now()
    from generate_series(1, ${expired}::int) g`);
  if (settled) {
    await db.execute(sql`
      insert into campaign_jobs (organization_id, campaign_id, route_id, type, status, idempotency_key, attempts, max_attempts, available_at)
      select ${orgId}::int, ${campaignId}::int, ${routeId}::int, 'ResolveTemplateAndSend', 'Sent',
             ${`${slug}-c${c}-s-`}::text || g::text, 1, 5, now()
      from generate_series(1, ${settled}::int) g`);
  }
}
await db.execute(sql`analyze campaign_jobs`);
const totalExpired = campaigns * expiredPerCampaign + 1;
const probeCampaignId = campaignIds.at(-1)!;

// --- run real housekeeping on its production cadence -------------------------------------------------------------
type Internals = { housekeeping(): Promise<void> };
const Runtime = CampaignRuntime as unknown as { HOUSEKEEPING_INTERVAL_MS: number; REAP_BATCH_LIMIT: number; REAP_PASS_BUDGET_MS: number };
// start(intervalMs = 100) is how production starts it (startCampaignRuntime); the timer is min(tick, HOUSEKEEPING).
const PRODUCTION_TICK_MS = 100;
const intervalMs = Math.min(PRODUCTION_TICK_MS, Runtime.HOUSEKEEPING_INTERVAL_MS);
const runtimes = Array.from({ length: cells }, () => new CampaignRuntime() as unknown as Internals & { housekeepingRunning: boolean; flushMetrics(): Promise<void> });
const passes: Array<{ cell: number; startMs: number; durationMs: number }> = [];
let skipped = 0;
const startedAt = Date.now();
const flushTimers = runtimes.map((runtime) => setInterval(() => void runtime.flushMetrics().catch(() => {}), intervalMs));
const timers = runtimes.map((runtime, cell) => setInterval(() => {
  // Mirrors CampaignRuntime.start(): setInterval(() => void this.housekeeping(), interval); housekeeping() returns
  // at once while the previous pass runs (housekeepingRunning).
  if (runtime.housekeepingRunning) { skipped += 1; return; }
  const passStart = Date.now();
  void runtime.housekeeping().finally(() => passes.push({ cell, startMs: passStart - startedAt, durationMs: Date.now() - passStart }));
}, intervalMs));

// Sample: per campaign, how many jobs are still Processing.
const firstReapedMs = new Map<number, number>();
const doneMs = new Map<number, number>();
const remainingSeries: Array<{ t: number; remaining: number }> = [];
const initial = new Map<number, number>(campaignIds.map((id, c) => [id, c === campaigns ? 1 : expiredPerCampaign]));
const deadline = startedAt + timeoutS * 1_000;
while (Date.now() < deadline) {
  await sleep(50);
  const rows = (await pool.query<{ campaign_id: number; n: string }>(
    "select campaign_id, count(*) as n from campaign_jobs where status = 'Processing' group by campaign_id")).rows;
  const now = Date.now() - startedAt;
  const left = new Map(rows.map((row) => [row.campaign_id, Number(row.n)]));
  let remaining = 0;
  for (const id of campaignIds) {
    const n = left.get(id) ?? 0;
    remaining += n;
    if (n < initial.get(id)! && !firstReapedMs.has(id)) firstReapedMs.set(id, now);
    if (n === 0 && !doneMs.has(id)) doneMs.set(id, now);
  }
  remainingSeries.push({ t: now, remaining });
  if (remaining === 0) break;
}
for (const timer of [...timers, ...flushTimers]) clearInterval(timer);
for (let i = 0; i < 100 && runtimes.some((runtime) => runtime.housekeepingRunning); i += 1) await sleep(50);
const completionMs = doneMs.size === campaignIds.length ? Math.max(...doneMs.values()) : null;

// Outcome check: every reaped job is Queued (Running campaign, attempts 1 < 5), none lost, none Failed.
const statuses = (await pool.query<{ status: string; n: string }>(
  "select status, count(*) as n from campaign_jobs where idempotency_key like '%-e-%' group by status")).rows;
const durations = passes.map((pass) => pass.durationMs).sort((a, b) => a - b);
const pct = (list: number[], p: number) => list.length ? list[Math.min(list.length - 1, Math.floor(list.length * p))] : null;
const perCampaign = campaignIds.map((id, c) => ({
  rank: c, probe: c === campaigns, expired: initial.get(id), firstReapedMs: firstReapedMs.get(id) ?? null, doneMs: doneMs.get(id) ?? null,
}));
// FIFO check: campaigns finish in expiry order (a later-expired campaign never completes before an earlier one, up
// to the sampling resolution and one batch of overlap).
let orderViolations = 0;
for (let c = 1; c < perCampaign.length; c += 1) {
  const previous = perCampaign[c - 1]!.doneMs;
  const current = perCampaign[c]!.doneMs;
  if (previous !== null && current !== null && current + 60 < previous) orderViolations += 1;
}
const result = {
  label, campaigns, expiredPerCampaign, settledPerCampaign, cells, totalExpired,
  contract: { housekeepingTimerMs: intervalMs, housekeepingIntervalConstantMs: Runtime.HOUSEKEEPING_INTERVAL_MS, reapBatchLimit: Runtime.REAP_BATCH_LIMIT, reapPassBudgetMs: Runtime.REAP_PASS_BUDGET_MS },
  completionMs, reapRatePerS: completionMs ? Math.round(totalExpired / (completionMs / 1000)) : null,
  probe: perCampaign.at(-1), probeCampaignId,
  passes: { count: passes.length, skippedTicks: skipped, p50Ms: pct(durations, 0.5), p95Ms: pct(durations, 0.95), maxMs: durations.at(-1) ?? null },
  fifoOrderViolations: orderViolations,
  statuses: Object.fromEntries(statuses.map((row) => [row.status, Number(row.n)])),
  perCampaign, remainingSeries,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, perCampaign: undefined, remainingSeries: undefined }));
await pool.end();
process.exit(0);
