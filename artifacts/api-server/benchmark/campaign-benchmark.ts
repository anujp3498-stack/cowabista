import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateSelectionsTable,
  contactImportSessionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  wabasTable,
  type CampaignJob,
} from "@workspace/db";
import {
  CampaignWorker,
  DatabaseJobQueue,
  RouteTpsLimiter,
  type CampaignWorkerObserver,
  type CampaignWorkerPhase,
  type ProviderSender,
} from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";
import { CAMPAIGN_PLATFORM_MAX_TPS } from "../src/services/campaign-pacing-coordinator";
import {
  assignRoute,
  normalizePhone,
  parseCsv,
  partitionFor,
  stableContactKey,
} from "../src/services/contact-processing";
import {
  assertContactImportWritable,
  initializeContactImport,
} from "../src/services/campaign-import-lifecycle";
import { ProviderRequestError } from "../src/services/whatsapp-provider";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import type { SerializableTransportPayload } from "../src/services/campaign-transport-shards";

const BATCH_SIZE = 500;

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Spreading a large array into Math.min/Math.max overflows the call stack once
 * a source holds more than a few tens of thousands of rows per route. A
 * sustained-window run needs hundreds of thousands, so scan instead.
 */
function arrayMin(values: readonly number[]): number {
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) if (value < result) result = value;
  return result;
}
function arrayMax(values: readonly number[]): number {
  let result = Number.NEGATIVE_INFINITY;
  for (const value of values) if (value > result) result = value;
  return result;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function hostCpuSnapshot() {
  return os.cpus().reduce(
    (total, cpu) => {
      total.user += cpu.times.user;
      total.nice += cpu.times.nice;
      total.sys += cpu.times.sys;
      total.idle += cpu.times.idle;
      total.irq += cpu.times.irq;
      return total;
    },
    { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  );
}

function hostCpuDelta(before: ReturnType<typeof hostCpuSnapshot>, after: ReturnType<typeof hostCpuSnapshot>) {
  const deltas = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key as keyof typeof before] - before[key as keyof typeof before]]),
  ) as ReturnType<typeof hostCpuSnapshot>;
  const total = Object.values(deltas).reduce((sum, value) => sum + value, 0);
  return {
    busyPercent: total ? round(((total - deltas.idle) / total) * 100) : 0,
    idlePercent: total ? round((deltas.idle / total) * 100) : 0,
    ticks: deltas,
  };
}

function processIoSnapshot() {
  try {
    const values = Object.fromEntries(
      readFileSync("/proc/self/io", "utf8").trim().split("\n").map((line) => {
        const [key, value] = line.split(":");
        return [key, Number(value.trim())];
      }),
    );
    return {
      readBytes: values.read_bytes ?? 0,
      writeBytes: values.write_bytes ?? 0,
      cancelledWriteBytes: values.cancelled_write_bytes ?? 0,
    };
  } catch {
    return undefined;
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

function sourceProfile() {
  const workspaceRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const schemaFiles = execFileSync("git", ["ls-files", "lib/db/src"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  })
    .trim().split("\n").filter(Boolean);
  const measuredFiles = [
    "artifacts/api-server/benchmark/campaign-benchmark.ts",
    "artifacts/api-server/src/services/campaign-import-lifecycle.ts",
    "artifacts/api-server/src/services/campaign-pacing-coordinator.ts",
    "artifacts/api-server/src/services/campaign-queue.ts",
    "artifacts/api-server/src/services/campaign-reconciliation.ts",
    "artifacts/api-server/src/services/campaign-runtime.ts",
    "artifacts/api-server/src/services/contact-processing.ts",
    "artifacts/api-server/src/services/template-resolution.ts",
    ...schemaFiles,
  ].sort();
  const hash = createHash("sha256");
  for (const file of measuredFiles) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(workspaceRoot, file)));
    hash.update("\0");
  }
  return {
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    measuredFilesSha256: hash.digest("hex"),
    measuredFileCount: measuredFiles.length,
  };
}

const config = {
  rows: positiveInteger("CAMPAIGN_BENCHMARK_ROWS", 10_000),
  routes: positiveInteger("CAMPAIGN_BENCHMARK_ROUTES", 4),
  phones: positiveInteger("CAMPAIGN_BENCHMARK_PHONES", 1),
  workers: positiveInteger("CAMPAIGN_BENCHMARK_WORKERS", 4),
  batchSize: positiveInteger("CAMPAIGN_BENCHMARK_BATCH_SIZE", 256),
  sustainedSeconds: positiveInteger("CAMPAIGN_BENCHMARK_SUSTAINED_SECONDS", 15),
  maxSustainedStallSeconds: positiveInteger("CAMPAIGN_BENCHMARK_MAX_STALL_SECONDS", 3),
  sendDelayMs: positiveInteger("CAMPAIGN_BENCHMARK_SEND_DELAY_MS", 10),
  retryEvery: positiveInteger("CAMPAIGN_BENCHMARK_RETRY_EVERY", 20),
  drainTimeoutSeconds: positiveInteger("CAMPAIGN_BENCHMARK_DRAIN_TIMEOUT_SECONDS", 600),
  csvChunkBytes: positiveInteger("CAMPAIGN_BENCHMARK_CSV_CHUNK_BYTES", 16_384),
  configuredTps: positiveInteger("CAMPAIGN_BENCHMARK_CONFIGURED_TPS", 1_000_000),
  providerTpsLimit: positiveInteger("CAMPAIGN_BENCHMARK_PROVIDER_TPS_LIMIT", 1_000_000),
  // "benchmark": the simulated provider path. "production": the real
  // WhatsAppTemplateSender (preparation, per-message validation, durable
  // provider intent, outcome persistence) against the mock provider client,
  // so production-only per-message costs are measured, not assumed.
  sender: process.env.CAMPAIGN_BENCHMARK_SENDER === "production" ? "production" as const : "benchmark" as const,
};
/**
 * Terminal-result guarantee. Every run serializes exactly one result file at
 * the output path -- a full result on success, or a failure result carrying
 * the error and whatever was measured so far -- and it is written BEFORE any
 * teardown (runtime stop, organization delete, pool end) begins. Teardown of a
 * 200k-row benchmark can take minutes, so a result written only after it (or
 * an error printed only after it) is a result the driver never sees. A run
 * that ends without this file is therefore a driver or host defect, never a
 * benchmark state.
 */
const terminalResultPath = path.resolve(
  process.env.CAMPAIGN_BENCHMARK_OUTPUT ??
    `benchmark-results/campaign-${new Date().toISOString().replaceAll(":", "-")}.json`,
);
let terminalResultWritten = false;
const partialState: {
  phase: string;
  progressSamples?: unknown[];
  sent?: () => number;
  attempted?: () => number;
  claimCalls?: () => number;
} = { phase: "setup" };
/** Returns the write error, if any, after the result has been echoed to stdout. */
function writeTerminalResultSync(result: Record<string, unknown>): unknown {
  if (terminalResultWritten) return undefined;
  terminalResultWritten = true;
  const serializedResult = `${JSON.stringify(result, null, 2)}\n`;
  let writeError: unknown;
  try {
    mkdirSync(path.dirname(terminalResultPath), { recursive: true });
    // "wx": never overwrite a result another run already wrote to this path.
    writeFileSync(terminalResultPath, serializedResult, { flag: "wx" });
  } catch (error) {
    writeError = error;
    process.stderr.write(`BENCHMARK_RESULT_FALLBACK ${serializedResult}`);
    process.stderr.write(`benchmark: could not write ${terminalResultPath}: ${errorDescription(error)}\n`);
  }
  console.log(JSON.stringify({ output: terminalResultPath, ...result }, null, 2));
  return writeError;
}
function failureResult(status: "failed" | "interrupted", error: unknown): Record<string, unknown> {
  return {
    schemaVersion: 3,
    status,
    measuredAt: new Date().toISOString(),
    configuration: config,
    phase: partialState.phase,
    failure: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "Error", message: String(error) },
    partial: {
      sent: partialState.sent?.() ?? 0,
      attempted: partialState.attempted?.() ?? 0,
      claimCalls: partialState.claimCalls?.() ?? 0,
      progressSamples: partialState.progressSamples ?? [],
      dispatchMetrics: campaignDispatchMetrics.snapshot(),
      phoneLanes: benchmarkRuntime?.phoneLaneMetrics() ?? finalPhoneLaneMetrics,
    },
  };
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // A driver timeout must still leave a result behind: serialize
    // synchronously, then exit with the conventional signal status.
    writeTerminalResultSync(failureResult("interrupted", new Error(`benchmark received ${signal}`)));
    process.exit(signal === "SIGTERM" ? 143 : 130);
  });
}

function coordinatorMode(): "redis" | "memory" {
  const redisUrl = process.env.CAMPAIGN_REDIS_URL || process.env.REDIS_URL;
  const requestedMode = process.env.CAMPAIGN_COORDINATOR_MODE;
  if (requestedMode && requestedMode !== "memory" && requestedMode !== "redis") {
    throw new Error("Invalid CAMPAIGN_COORDINATOR_MODE");
  }
  if (process.env.NODE_ENV === "production" && !redisUrl) {
    throw new Error("CAMPAIGN_REDIS_URL or REDIS_URL is required in production");
  }
  if (requestedMode === "redis" && !redisUrl) {
    throw new Error("CAMPAIGN_REDIS_URL or REDIS_URL is required for Redis mode");
  }
  if (requestedMode === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Memory campaign coordinator is not allowed in production");
    }
    return "memory";
  }
  return redisUrl ? "redis" : "memory";
}
const pacingCoordinatorMode = coordinatorMode();
const effectivePhoneTps = Math.min(config.providerTpsLimit, CAMPAIGN_PLATFORM_MAX_TPS);
const effectiveRouteTps = Math.min(config.configuredTps, effectivePhoneTps, CAMPAIGN_PLATFORM_MAX_TPS);
if (config.configuredTps > config.providerTpsLimit) {
  throw new Error("CAMPAIGN_BENCHMARK_CONFIGURED_TPS cannot exceed CAMPAIGN_BENCHMARK_PROVIDER_TPS_LIMIT");
}
const estimatedSustainedCapacity = Math.ceil(
  effectivePhoneTps * config.phones * config.sustainedSeconds * 1.05,
);
if (config.rows < estimatedSustainedCapacity) {
  throw new Error(
    `CAMPAIGN_BENCHMARK_ROWS must be at least ${estimatedSustainedCapacity} for the effective sustained assertion`,
  );
}

const benchmarkUrl = new URL(process.env.CAMPAIGN_BENCHMARK_DATABASE_URL!);
const databaseName = decodeURIComponent(benchmarkUrl.pathname.replace(/^\//, ""));
assert.equal(process.env.DATABASE_URL, process.env.CAMPAIGN_BENCHMARK_DATABASE_URL);
assert.match(databaseName, /(^|[_-])(bench|benchmark)([_-]|$)/i);
assert.equal(process.env.CAMPAIGN_BENCHMARK_CONFIRM, databaseName);
const initialSource = sourceProfile();
if (process.env.CAMPAIGN_BENCHMARK_REQUIRE_CLEAN === "1") {
  assert.equal(initialSource.workingTreeDirty, false, "benchmark requires a clean source tree");
}

async function databaseSize(): Promise<number> {
  const result = await pool.query<{ bytes: string }>("select pg_database_size(current_database())::text as bytes");
  return Number(result.rows[0]!.bytes);
}

async function campaignRelationSize(): Promise<number> {
  const result = await pool.query<{ bytes: string }>(`
    select coalesce(sum(pg_total_relation_size(c.oid)), 0)::text as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema()
      and c.relname = any($1::text[])
  `, [[
    "campaign_contacts", "campaign_jobs", "campaign_metrics", "campaign_routes",
    "contact_import_sessions", "campaign_metric_deltas",
  ]]);
  return Number(result.rows[0]!.bytes);
}

async function dbCounters() {
  const result = await pool.query<{
    blks_read: string;
    blks_hit: string;
    blk_read_time: string;
    blk_write_time: string;
    deadlocks: string;
    conflicts: string;
    temp_bytes: string;
    temp_files: string;
    xact_commit: string;
    xact_rollback: string;
  }>(`
    select blks_read::text, blks_hit::text, blk_read_time::text, blk_write_time::text,
           deadlocks::text, conflicts::text, temp_bytes::text, temp_files::text,
           xact_commit::text, xact_rollback::text
    from pg_stat_database where datname = current_database()
  `);
  return Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]));
}

async function databaseProfile() {
  const result = await pool.query<{
    version: string;
    database: string;
    shared_buffers: string;
    work_mem: string;
    effective_cache_size: string;
    max_connections: string;
  }>(`
    select version(), current_database() as database,
      current_setting('shared_buffers') as shared_buffers,
      current_setting('work_mem') as work_mem,
      current_setting('effective_cache_size') as effective_cache_size,
      current_setting('max_connections') as max_connections
  `);
  return {
    ...result.rows[0]!,
    endpoint: `${benchmarkUrl.hostname}:${benchmarkUrl.port || "5432"}`,
  };
}

async function* generatedCsv(rows: number, chunkBytes: number): AsyncGenerator<Buffer> {
  let pending = "phone,name,segment,notes\r\n";
  for (let index = 0; index < rows; index += 1) {
    const phone = `+1${String(2_000_000_000 + index).padStart(10, "0")}`;
    pending += `${phone},Contact ${index},segment-${index % 12},"representative, streamed row ${index}"\r\n`;
    while (Buffer.byteLength(pending) >= chunkBytes) {
      const data = Buffer.from(pending);
      yield data.subarray(0, chunkBytes);
      pending = data.subarray(chunkBytes).toString();
    }
  }
  if (pending) yield Buffer.from(pending);
}

class BenchmarkSender implements ProviderSender {
  readonly claimLatenciesMs: number[] = [];
  readonly sentByRoute = new Map<number, number>();
  sendAttempts = 0;
  sent = 0;
  retries = 0;
  active = 0;
  peakActive = 0;
  readonly activeByRoute = new Map<number, number>();
  readonly peakActiveByRoute = new Map<number, number>();
  readonly attemptedAtMs: number[] = [];
  readonly acceptedAtMs: number[] = [];
  readonly attemptedAtByRoute = new Map<number, number[]>();
  readonly acceptedAtByRoute = new Map<number, number[]>();
  readonly scheduledAtByRoute = new Map<number, number[]>();
  readonly dispatchLatenessMsByRoute = new Map<number, number[]>();

  serializePreparedTransport(job: CampaignJob, _preparedContext?: unknown): SerializableTransportPayload | undefined {
    const contactOrdinal = Number(job.idempotencyKey.split(":").at(-1));
    const shouldRetry = job.attempts === 1
      && Number.isFinite(contactOrdinal)
      && contactOrdinal % config.retryEvery === 0;
    return {
      kind: "benchmark" as const,
      delayMs: config.sendDelayMs,
      providerMessageId: `benchmark-${job.idempotencyKey}-${job.attempts}`,
      error: shouldRetry
        ? { message: "benchmark injected retryable response", retryable: true, code: "429", status: 429 }
        : undefined,
    };
  }

  observeShardTransportStart(job: CampaignJob, startedAt: number) {
    this.attemptedAtMs.push(startedAt);
    this.sendAttempts += 1;
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    if (job.routeId) {
      const attempts = this.attemptedAtByRoute.get(job.routeId) ?? [];
      attempts.push(startedAt);
      this.attemptedAtByRoute.set(job.routeId, attempts);
      const scheduled = this.scheduledAtByRoute.get(job.routeId) ?? [];
      assert.ok(job.scheduledSendAt, "benchmark sends must retain a durable scheduledSendAt reservation");
      const scheduledAt = job.scheduledSendAt.getTime();
      scheduled.push(scheduledAt);
      this.scheduledAtByRoute.set(job.routeId, scheduled);
      const lateness = this.dispatchLatenessMsByRoute.get(job.routeId) ?? [];
      lateness.push(Math.max(0, startedAt - (scheduledAt - performance.timeOrigin)));
      this.dispatchLatenessMsByRoute.set(job.routeId, lateness);
      const routeActive = (this.activeByRoute.get(job.routeId) ?? 0) + 1;
      this.activeByRoute.set(job.routeId, routeActive);
      this.peakActiveByRoute.set(
        job.routeId,
        Math.max(this.peakActiveByRoute.get(job.routeId) ?? 0, routeActive),
      );
    }
  }

  observeShardTransport(
    job: CampaignJob,
    { startedAt, completedAt, error }: { startedAt?: number; completedAt?: number; error?: Error },
  ) {
    assert.ok(startedAt !== undefined && completedAt !== undefined, "shard transport must report provider-boundary timestamps");
    this.acceptedAtMs.push(completedAt);
    this.active = Math.max(0, this.active - 1);
    if (job.routeId) {
      const accepted = this.acceptedAtByRoute.get(job.routeId) ?? [];
      accepted.push(completedAt);
      this.acceptedAtByRoute.set(job.routeId, accepted);
      this.activeByRoute.set(job.routeId, Math.max(0, (this.activeByRoute.get(job.routeId) ?? 1) - 1));
    }
    if (error) {
      this.retries += 1;
      return;
    }
    this.sent += 1;
    if (job.routeId) this.sentByRoute.set(job.routeId, (this.sentByRoute.get(job.routeId) ?? 0) + 1);
  }

  async send(job: CampaignJob, { signal, idempotencyKey }: { signal: AbortSignal; idempotencyKey: string }) {
    const attemptedAt = performance.now();
    this.attemptedAtMs.push(attemptedAt);
    if (job.routeId) {
      const attempts = this.attemptedAtByRoute.get(job.routeId) ?? [];
      attempts.push(attemptedAt);
      this.attemptedAtByRoute.set(job.routeId, attempts);
      const scheduled = this.scheduledAtByRoute.get(job.routeId) ?? [];
      assert.ok(job.scheduledSendAt, "benchmark sends must retain a durable scheduledSendAt reservation");
      const scheduledAt = job.scheduledSendAt.getTime();
      scheduled.push(scheduledAt);
      this.scheduledAtByRoute.set(job.routeId, scheduled);
      const lateness = this.dispatchLatenessMsByRoute.get(job.routeId) ?? [];
      lateness.push(Math.max(0, Date.now() - scheduledAt));
      this.dispatchLatenessMsByRoute.set(job.routeId, lateness);
    }
    this.sendAttempts += 1;
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    if (job.routeId) {
      const routeActive = (this.activeByRoute.get(job.routeId) ?? 0) + 1;
      this.activeByRoute.set(job.routeId, routeActive);
      this.peakActiveByRoute.set(
        job.routeId,
        Math.max(this.peakActiveByRoute.get(job.routeId) ?? 0, routeActive),
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, config.sendDelayMs);
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("send aborted"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    } finally {
      this.active -= 1;
      if (job.routeId) {
        this.activeByRoute.set(job.routeId, Math.max(0, (this.activeByRoute.get(job.routeId) ?? 1) - 1));
      }
    }
    const contactOrdinal = Number(idempotencyKey.split(":").at(-1));
    if (job.attempts === 1 && Number.isFinite(contactOrdinal) && contactOrdinal % config.retryEvery === 0) {
      this.retries += 1;
      throw new ProviderRequestError("benchmark injected retryable response", true, "429", 429);
    }
    this.sent += 1;
    const acceptedAt = performance.now();
    this.acceptedAtMs.push(acceptedAt);
    if (job.routeId) {
      const accepted = this.acceptedAtByRoute.get(job.routeId) ?? [];
      accepted.push(acceptedAt);
      this.acceptedAtByRoute.set(job.routeId, accepted);
    }
    if (job.routeId) this.sentByRoute.set(job.routeId, (this.sentByRoute.get(job.routeId) ?? 0) + 1);
    return { providerMessageId: `benchmark-${idempotencyKey}-${job.attempts}` };
  }
}

/**
 * The production sender behind the benchmark's observation bookkeeping. Every
 * throughput and pacing assertion reads the counters BenchmarkSender maintains
 * in observeShardTransportStart/observeShardTransport; everything the job
 * actually goes through -- prepareBatch, validatePrepared, serialized
 * transport, durable outcome settlement, revocation -- is the real thing.
 * Retry injection is a BenchmarkSender payload feature the mock provider does
 * not have, so a production-path run measures a 0% injected-retry workload.
 */
class ProductionPathSender extends BenchmarkSender {
  private readonly production = new WhatsAppTemplateSender();
  prepareBatch(jobs: CampaignJob[], signal?: AbortSignal) { return this.production.prepareBatch(jobs, signal); }
  validatePrepared(preparedContext: unknown) { return this.production.validatePrepared(preparedContext); }
  validatePreparedBatch(items: ReadonlyArray<{ jobId: number; preparedContext: unknown }>) { return this.production.validatePreparedBatch(items); }
  preparedRecipient(preparedContext: unknown) { return this.production.preparedRecipient(preparedContext); }
  override serializePreparedTransport(job: CampaignJob, preparedContext?: unknown) {
    return this.production.serializePreparedTransport(job, preparedContext);
  }
  settlePreparedTransport(job: CampaignJob, preparedContext: unknown, outcome: { providerMessageId: string } | { error: unknown }) {
    return this.production.settlePreparedTransport(job, preparedContext, outcome);
  }
  revokePrepared(preparedContext: unknown, reason: unknown) { return this.production.revokePrepared(preparedContext, reason); }
  flushPreparedOutcomes() { return this.production.flushPreparedOutcomes(); }
}

type ClaimCounters = {
  calls: number;
  successful: number;
  idle: number;
  latenciesMs: number[];
};

class BenchmarkJobQueue extends DatabaseJobQueue {
  constructor(private readonly counters: ClaimCounters) {
    super();
  }

  override async claim(
    limiter: RouteTpsLimiter,
    workerId: string,
    leaseMs: number,
    now = new Date(),
    busyRouteIds?: ReadonlyMap<number, number>,
    getMaxInFlight?: (configuredTps: number) => number,
    claimingRouteIds?: Set<number>,
  ): Promise<CampaignJob | undefined> {
    this.counters.calls += 1;
    const started = performance.now();
    try {
      const job = await super.claim(
        limiter,
        workerId,
        leaseMs,
        now,
        busyRouteIds,
        getMaxInFlight,
        claimingRouteIds,
      );
      if (job) this.counters.successful += 1;
      return job;
    } finally {
      this.counters.latenciesMs.push(performance.now() - started);
    }
  }

  override async claimBatch(
    limiter: RouteTpsLimiter,
    workerId: string,
    leaseMs: number,
    batchSize: number,
    now = new Date(),
    busyRouteIds?: ReadonlyMap<number, number>,
    getMaxInFlight?: (configuredTps: number) => number,
    claimingRouteIds?: Set<number>,
    phoneNumberId?: number,
  ): Promise<CampaignJob[]> {
    this.counters.calls += 1;
    const started = performance.now();
    try {
      // The phone predicate must reach the real claim: without it every
      // reservoir lane claims across all phones, lanes race for the same
      // rows, and the losers' Redis slot reservations are burnt (never
      // refunded by design), punching 256-slot holes into each phone's
      // timeline. Production's claimPhoneBatch always forwards it.
      const jobs = await super.claimBatch(
        limiter,
        workerId,
        leaseMs,
        batchSize,
        now,
        busyRouteIds,
        getMaxInFlight,
        claimingRouteIds,
        phoneNumberId,
      );
      this.counters.successful += jobs.length;
      if (!jobs.length) this.counters.idle += 1;
      return jobs;
    } finally {
      this.counters.latenciesMs.push(performance.now() - started);
    }
  }
}

function intervalStats(timestamps: number[]) {
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
  if (!intervals.length) return { samples: 0, meanMs: 0, standardDeviationMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, p99Ms: 0 };
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  return {
    samples: intervals.length,
    meanMs: round(mean),
    standardDeviationMs: round(Math.sqrt(variance)),
    minMs: round(arrayMin(intervals)),
    maxMs: round(arrayMax(intervals)),
    p95Ms: round(percentile(intervals, 0.95)),
    p99Ms: round(percentile(intervals, 0.99)),
  };
}

function pacingStats(timestamps: number[], targetIntervalMs: number) {
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
  const burstCount = intervals.filter((interval) => interval < targetIntervalMs * 0.2).length;
  const idleGapCount = intervals.filter((interval) => interval > targetIntervalMs * 5).length;
  return {
    ...intervalStats(timestamps),
    burstCount,
    burstPercent: round((burstCount / Math.max(1, intervals.length)) * 100),
    idleGapCount,
    idleGapPercent: round((idleGapCount / Math.max(1, intervals.length)) * 100),
  };
}

function timestampsWithin(timestamps: number[], startMs: number, endMs: number) {
  return timestamps.filter((timestamp) => timestamp >= startMs && timestamp <= endMs);
}

const FLOATING_INTERVAL_TOLERANCE_MS = 0.01;

function rollingWindowPeak(timestamps: number[], windowMs: number) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let start = 0;
  let peak = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end]! - sorted[start]! >= windowMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

function rollingOneSecondPeak(timestamps: number[]) {
  return rollingWindowPeak(timestamps, 1_000);
}

function noCatchUpPacing(timestamps: number[], targetIntervalMs: number) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((timestamp, index) => timestamp - sorted[index]!);
  const minimumIntervalMs = intervals.length ? arrayMin(intervals) : 0;
  return {
    samples: sorted.length,
    monotonic: sorted.every((timestamp, index) => index === 0 || timestamp > sorted[index - 1]!),
    targetIntervalMs: round(targetIntervalMs),
    minimumIntervalMs: round(minimumIntervalMs),
    toleranceMs: FLOATING_INTERVAL_TOLERANCE_MS,
    satisfiesMinimumInterval: intervals.every((interval) => interval >= targetIntervalMs - FLOATING_INTERVAL_TOLERANCE_MS),
  };
}

class BenchmarkWorkerObserver implements CampaignWorkerObserver {
  readonly phases = new Map<CampaignWorkerPhase, { durationsMs: number[]; jobs: number }>();

  record(phase: CampaignWorkerPhase, durationMs: number, jobs: number): void {
    const value = this.phases.get(phase) ?? { durationsMs: [], jobs: 0 };
    value.durationsMs.push(durationMs);
    value.jobs += jobs;
    this.phases.set(phase, value);
  }

  summary() {
    return Object.fromEntries([...this.phases.entries()].map(([phase, value]) => [phase, {
      operations: value.durationsMs.length,
      jobs: value.jobs,
      totalMs: round(value.durationsMs.reduce((sum, duration) => sum + duration, 0)),
      p50Ms: round(percentile(value.durationsMs, 0.5)),
      p95Ms: round(percentile(value.durationsMs, 0.95)),
      p99Ms: round(percentile(value.durationsMs, 0.99)),
    }]));
  }
}

let organizationId: number | undefined;
let peakRss = process.memoryUsage().rss;
let peakHeapUsed = process.memoryUsage().heapUsed;
let peakWaitingLocks = 0;
let peakDatabaseConnections = 0;
let peakActiveDatabaseConnections = 0;
let minimumHostFreeMemoryBytes = os.freemem();
let maximumLoadAverage1m = os.loadavg()[0]!;
let memoryTimer: NodeJS.Timeout | undefined;
const lockSamples = new Set<Promise<void>>();
let benchmarkRuntime: CampaignRuntime | undefined;
let finalPhoneLaneMetrics: ReturnType<CampaignRuntime["phoneLaneMetrics"]> = [];
let finalDispatchMetrics = campaignDispatchMetrics.snapshot();
let finalWorkerPhaseTimings: ReturnType<BenchmarkWorkerObserver["summary"]> = {};
let finalEventLoopDelayMs = { mean: 0, min: 0, max: 0, p95: 0, p99: 0 };
let finalProcessCpu: { userMicros: number; systemMicros: number } = { userMicros: 0, systemMicros: 0 };
let finalEventLoopUtilization = { active: 0, idle: 0, utilization: 0 };
let workerObserverForFinalSnapshot: BenchmarkWorkerObserver | undefined;
let eventLoopForFinalSnapshot: ReturnType<typeof monitorEventLoopDelay> | undefined;
let processCpuStart: NodeJS.CpuUsage | undefined;
let eventLoopUtilizationStart: ReturnType<typeof performance.eventLoopUtilization> | undefined;
let samplerFailure: unknown;
let primaryFailure: unknown;

/**
 * This must run before pool.end on both the success and error paths. Workers
 * intentionally resolve after recording their unexpected error so every
 * outstanding query has settled and the first useful error is not replaced by
 * "Cannot use a pool after calling end".
 */
async function stopAndSettleWorkers(): Promise<unknown> {
  if (memoryTimer) {
    clearInterval(memoryTimer);
    memoryTimer = undefined;
  }
  if (benchmarkRuntime) finalPhoneLaneMetrics = benchmarkRuntime.phoneLaneMetrics();
  finalDispatchMetrics = campaignDispatchMetrics.snapshot();
  finalWorkerPhaseTimings = workerObserverForFinalSnapshot?.summary() ?? {};
  if (eventLoopForFinalSnapshot) {
    finalEventLoopDelayMs = {
      mean: round(eventLoopForFinalSnapshot.mean / 1e6),
      min: round(eventLoopForFinalSnapshot.min / 1e6),
      max: round(eventLoopForFinalSnapshot.max / 1e6),
      p95: round(eventLoopForFinalSnapshot.percentile(95) / 1e6),
      p99: round(eventLoopForFinalSnapshot.percentile(99) / 1e6),
    };
  }
  if (processCpuStart) {
    const cpu = process.cpuUsage(processCpuStart);
    finalProcessCpu = { userMicros: cpu.user, systemMicros: cpu.system };
  }
  if (eventLoopUtilizationStart) {
    finalEventLoopUtilization = performance.eventLoopUtilization(eventLoopUtilizationStart);
  }
  await benchmarkRuntime?.stop();
  benchmarkRuntime = undefined;
  await Promise.all([...lockSamples]);
  return samplerFailure;
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

try {
  const profile = await databaseProfile();
  const beforeDatabaseBytes = await databaseSize();
  const beforeRelationsBytes = await campaignRelationSize();
  const slug = `campaign-benchmark-${process.pid}-${Date.now()}`;

  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  organizationId = organization.id;
  const orgId = organization.id;
  const [waba] = await db.insert(wabasTable).values({
    organizationId: orgId, externalId: `${slug}-simulated`, displayName: "Benchmark simulated WABA",
  }).returning();
  const phones = await db.insert(phoneNumbersTable).values(
    Array.from({ length: config.phones }, (_, index) => ({
      organizationId: orgId,
      wabaId: waba.id,
      phone: `+1202555${String(100 + index).padStart(4, "0")}`,
      displayName: `Benchmark simulated phone ${index + 1}`,
      status: "Connected" as const,
      tpsLimit: config.providerTpsLimit,
      providerMetadata: { benchmark: true, credentialsUsed: false },
    })),
  ).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: orgId,
    wabaId: waba.id,
    name: `${slug}-template`,
    status: "Approved",
    body: "Benchmark message",
    components: [{ type: "BODY", text: "Benchmark message" }],
    metadata: { benchmark: true },
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId: orgId, name: slug, status: "Draft",
  }).returning();
  const routes = await db.insert(campaignRoutesTable).values(
    Array.from({ length: config.routes }, (_, index) => ({
      organizationId: orgId,
      campaignId: campaign.id,
      phoneNumberId: phones[index % phones.length]!.id,
      templateId: template.id,
      configuredTps: config.configuredTps,
    })),
  ).returning();
  const [plan] = await db.insert(campaignPlansTable).values({
    organizationId: orgId,
    campaignId: campaign.id,
    version: 1,
    allocatorVersion: "benchmark-production-shape-v1",
    partitionCount: Math.max(routes.length, 64),
    routes: routes.map((route, index) => {
      const phone = phones[index % phones.length]!;
      return {
        routeId: route.id,
        phoneNumberId: phone.id,
        templateId: template.id,
        configuredTps: config.configuredTps,
        providerTpsLimit: config.providerTpsLimit,
        phone: phone.phone,
        displayName: phone.displayName,
      };
    }),
    templateIds: [template.id],
    templatesSnapshot: [{
      id: template.id,
      name: template.name,
      language: template.language,
      wabaId: template.wabaId,
      body: template.body,
      components: template.components,
    }],
    mappingsSnapshot: [],
    status: "Active",
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({
    organizationId: orgId, campaignId: campaign.id, templateId: template.id,
  });
  const initialized = await initializeContactImport({
    organizationId: orgId,
    campaignId: campaign.id,
    idempotencyKey: `${slug}-import`,
    fileName: "generated-representative-contacts.csv",
    phoneColumn: "phone",
  });
  assert.ok(initialized.ok && !initialized.replay);
  const session = initialized.session;

  let bytesProcessed = 0;
  let rowNumber = 0;
  let columns: string[] = [];
  let batch: (typeof campaignContactsTable.$inferInsert)[] = [];
  const importStarted = performance.now();
  const flush = async () => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    await db.transaction(async (tx) => {
      await assertContactImportWritable(tx, orgId, campaign.id, session.id);
      const contacts = await tx.insert(campaignContactsTable).values(current).returning({
        id: campaignContactsTable.id,
        routeId: campaignContactsTable.routeId,
        key: campaignContactsTable.idempotencyKey,
      });
      const rowByKey = new Map(current.map((contact) => [contact.idempotencyKey, contact.rowNumber]));
      await tx.insert(campaignJobsTable).values(contacts.map((contact) => {
        const sourceRow = rowByKey.get(contact.key);
        assert.ok(sourceRow, "inserted contact must correspond to its streamed source row");
        return {
          organizationId: orgId,
          campaignId: campaign.id,
          routeId: contact.routeId,
          contactId: contact.id,
          configuredTps: config.configuredTps,
          templateId: template.id,
          planId: plan.id,
          type: "ResolveTemplateAndSend",
          idempotencyKey: `benchmark:${sourceRow}`,
          payload: { contactId: contact.id },
        };
      }));
      await tx.update(contactImportSessionsTable).set({
        columns,
        bytesProcessed,
        rowsProcessed: rowNumber,
        validRows: rowNumber - 1,
      }).where(eq(contactImportSessionsTable.id, session.id));
    });
  };
  async function* measuredCsv() {
    for await (const chunk of generatedCsv(config.rows, config.csvChunkBytes)) {
      bytesProcessed += chunk.length;
      yield chunk;
    }
  }
  for await (const values of parseCsv(measuredCsv())) {
    if (rowNumber++ === 0) {
      columns = values;
      continue;
    }
    const data = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    const normalized = normalizePhone(data.phone ?? "");
    assert.ok(normalized.value, normalized.error);
    const partition = partitionFor(normalized.value, Math.max(routes.length, 64));
    batch.push({
      organizationId: orgId,
      campaignId: campaign.id,
      importSessionId: session.id,
      rowNumber,
      rawPhone: data.phone,
      normalizedPhone: normalized.value,
      data,
      status: "Valid",
      partitionKey: partition,
      routeId: assignRoute(partition, routes.map((route) => route.id)),
      idempotencyKey: stableContactKey(campaign.id, normalized.value),
    });
    if (batch.length === BATCH_SIZE) await flush();
  }
  await flush();
  const importSeconds = (performance.now() - importStarted) / 1_000;
  assert.equal(rowNumber - 1, config.rows);
  await db.transaction(async (tx) => {
    await tx.update(contactImportSessionsTable).set({
      status: "Completed", bytesProcessed, rowsProcessed: config.rows, validRows: config.rows,
    }).where(eq(contactImportSessionsTable.id, session.id));
    await tx.insert(campaignMetricsTable).values({
      organizationId: orgId, campaignId: campaign.id, total: config.rows, valid: config.rows, queued: config.rows,
    });
    for (const route of routes) {
      const routeRows = await tx.select({ count: sql<number>`count(*)::int` }).from(campaignJobsTable)
        .where(eq(campaignJobsTable.routeId, route.id));
      await tx.update(campaignRoutesTable).set({ queueDepth: routeRows[0]!.count })
        .where(eq(campaignRoutesTable.id, route.id));
    }
    await tx.update(campaignsTable).set({
      status: "Running", audienceSize: config.rows, startedAt: new Date(),
    }).where(eq(campaignsTable.id, campaign.id));
  });
  const afterImportDatabaseBytes = await databaseSize();
  const afterImportRelationsBytes = await campaignRelationSize();

  // Simulate a process dying after an atomic claim and prove lease recovery.
  partialState.phase = "recovery-probe";
  const interrupted = await new DatabaseJobQueue().claim(
    new RouteTpsLimiter(), "benchmark-interrupted-worker", 250,
  );
  assert.ok(interrupted, "interruption fixture must claim a job");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const recoveryRuntime = new CampaignRuntime();
  await (recoveryRuntime as unknown as { reapExpiredLeases(now: Date): Promise<void> })
    .reapExpiredLeases(new Date());
  const [recovered] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, interrupted.id));
  assert.equal(recovered!.status, "Queued", "expired interrupted lease must be requeued");
  assert.equal(recovered!.attempts, 1);

  const workloadCounters = await dbCounters();
  const hostCpuBefore = hostCpuSnapshot();
  const processIoBefore = processIoSnapshot();
  const diskBefore = await statfs(process.cwd());
  const sender = config.sender === "production" ? new ProductionPathSender() : new BenchmarkSender();
  const workerObserver = new BenchmarkWorkerObserver();
  workerObserverForFinalSnapshot = workerObserver;
  const claimCounters: ClaimCounters = { calls: 0, successful: 0, idle: 0, latenciesMs: [] };
  let transientDatabaseRetries = 0;
  let deadlockRetries = 0;
  let serializationRetries = 0;
  let sampledClaimCount = 0;
  const progressSamples: Array<{
    elapsedSeconds: number;
    sent: number;
    sentDelta: number;
    sendsPerSecond: number;
    queued: number;
    processing: number;
    failed: number;
    claimCalls: number;
    successfulClaims: number;
    claimCallsDelta: number;
    successfulClaimsDelta: number;
    claimLatencyMsP95: number;
  }> = [];
  partialState.phase = "workload";
  partialState.progressSamples = progressSamples;
  partialState.sent = () => sender.sent;
  partialState.attempted = () => sender.attemptedAtMs.length;
  partialState.claimCalls = () => claimCounters.calls;
  const workloadStarted = performance.now();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
  eventLoopDelay.enable();
  eventLoopForFinalSnapshot = eventLoopDelay;
  processCpuStart = process.cpuUsage();
  eventLoopUtilizationStart = performance.eventLoopUtilization();

  global.gc?.();
  peakRss = process.memoryUsage().rss;
  peakHeapUsed = process.memoryUsage().heapUsed;
  memoryTimer = setInterval(() => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    minimumHostFreeMemoryBytes = Math.min(minimumHostFreeMemoryBytes, os.freemem());
    maximumLoadAverage1m = Math.max(maximumLoadAverage1m, os.loadavg()[0]!);
    const sample = pool.query<{ connections: string; active: string; waiting: string }>(
      `select count(*)::text as connections,
              count(*) filter (where state = 'active')::text as active,
              count(*) filter (where wait_event_type = 'Lock')::text as waiting
       from pg_stat_activity where datname=current_database()`,
    ).then((result) => {
      const row = result.rows[0]!;
      peakWaitingLocks = Math.max(peakWaitingLocks, Number(row.waiting));
      peakDatabaseConnections = Math.max(peakDatabaseConnections, Number(row.connections));
      peakActiveDatabaseConnections = Math.max(peakActiveDatabaseConnections, Number(row.active));
    }).catch((error: unknown) => {
      // Keep sampling errors for the benchmark result/error path instead of
      // leaving an unhandled rejection that can obscure a worker failure.
      samplerFailure ??= error;
    }).finally(() => {
      lockSamples.delete(sample);
    });
    lockSamples.add(sample);
  }, 100);
  // Exercise the exact production scheduler: adaptive lanes, bounded
  // per-tick claim budget, independent housekeeping, and the same shared
  // CampaignWorker route-in-flight state. The only injected pieces are the
  // simulated provider, observed queue, and batch size.
  benchmarkRuntime = new CampaignRuntime(sender, undefined, {
    queue: new BenchmarkJobQueue(claimCounters),
    observer: workerObserver,
    batchSize: config.batchSize,
  });
  benchmarkRuntime.start(20);

  const sustainedDeadline = workloadStarted + config.sustainedSeconds * 1_000;
  const steadyWindowStarted = workloadStarted + Math.min(1_000, config.sustainedSeconds * 100);
  let previousSent = 0;
  let lastProgressSampleAt = workloadStarted;
  let consecutiveStalledSamples = 0;
  let maxConsecutiveStalledSamples = 0;
  while (performance.now() < sustainedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const sentDelta = sender.sent - previousSent;
    const sampleAt = performance.now();
    const [progress] = await db.select({
      queued: campaignMetricsTable.queued,
      processing: campaignMetricsTable.processing,
      failed: campaignMetricsTable.failed,
    }).from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaign.id));
    const sampleClaimLatencies = claimCounters.latenciesMs.slice(sampledClaimCount);
    progressSamples.push({
      elapsedSeconds: round((sampleAt - workloadStarted) / 1_000),
      sent: sender.sent,
      sentDelta,
      sendsPerSecond: round(sentDelta / ((sampleAt - lastProgressSampleAt) / 1_000)),
      queued: progress!.queued,
      processing: progress!.processing,
      failed: progress!.failed,
      claimCalls: claimCounters.calls,
      successfulClaims: claimCounters.successful,
      claimCallsDelta: claimCounters.calls - (progressSamples.at(-1)?.claimCalls ?? 0),
      successfulClaimsDelta: claimCounters.successful - (progressSamples.at(-1)?.successfulClaims ?? 0),
      claimLatencyMsP95: round(percentile(sampleClaimLatencies, 0.95)),
    });
    sampledClaimCount = claimCounters.latenciesMs.length;
    lastProgressSampleAt = sampleAt;
    consecutiveStalledSamples = sentDelta > 0 ? 0 : consecutiveStalledSamples + 1;
    maxConsecutiveStalledSamples = Math.max(maxConsecutiveStalledSamples, consecutiveStalledSamples);
    assert.ok(
      consecutiveStalledSamples <= config.maxSustainedStallSeconds,
      `workers made no progress for more than ${config.maxSustainedStallSeconds} sustained-run samples`,
    );
    previousSent = sender.sent;
  }
  assert.ok(
    sender.sent > 0,
    `workers must make progress during the sustained interval: ${JSON.stringify({
      sendAttempts: sender.sendAttempts,
      retries: sender.retries,
      progressSamples,
      claimCounters: {
        calls: claimCounters.calls,
        successful: claimCounters.successful,
        idle: claimCounters.idle,
      },
      dispatchMetrics: campaignDispatchMetrics.snapshot(),
      phoneLanes: benchmarkRuntime.phoneLaneMetrics(),
    })}`,
  );

  partialState.phase = "drain";
  const drainDeadline = performance.now() + config.drainTimeoutSeconds * 1_000;
  let nextDrainProgressSampleAt = performance.now() + 60_000;
  while (performance.now() < drainDeadline) {
    const [counts] = await db.select({
      queued: campaignMetricsTable.queued,
      processing: campaignMetricsTable.processing,
      failed: campaignMetricsTable.failed,
    }).from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, campaign.id));
    if (counts!.queued + counts!.processing === 0) break;
    const sampleAt = performance.now();
    if (sampleAt >= nextDrainProgressSampleAt) {
      const sentDelta = sender.sent - previousSent;
      const sampleClaimLatencies = claimCounters.latenciesMs.slice(sampledClaimCount);
      progressSamples.push({
        elapsedSeconds: round((sampleAt - workloadStarted) / 1_000),
        sent: sender.sent,
        sentDelta,
        sendsPerSecond: round(sentDelta / ((sampleAt - lastProgressSampleAt) / 1_000)),
        queued: counts!.queued,
        processing: counts!.processing,
        failed: counts!.failed,
        claimCalls: claimCounters.calls,
        successfulClaims: claimCounters.successful,
        claimCallsDelta: claimCounters.calls - (progressSamples.at(-1)?.claimCalls ?? 0),
        successfulClaimsDelta: claimCounters.successful - (progressSamples.at(-1)?.successfulClaims ?? 0),
        claimLatencyMsP95: round(percentile(sampleClaimLatencies, 0.95)),
      });
      previousSent = sender.sent;
      sampledClaimCount = claimCounters.latenciesMs.length;
      lastProgressSampleAt = sampleAt;
      nextDrainProgressSampleAt = sampleAt + 60_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  partialState.phase = "verification";
  const lifecycleFailure = await stopAndSettleWorkers();
  eventLoopDelay.disable();
  if (lifecycleFailure) throw lifecycleFailure;
  assert.ok(sender.attemptedAtMs.length > 0 && sender.acceptedAtMs.length > 0);
  const workloadSeconds = Math.max(
    0.001,
    (sender.acceptedAtMs.at(-1)! - sender.attemptedAtMs[0]!) / 1_000,
  );
  const steadyWindowSeconds = Math.max(0.001, (sustainedDeadline - steadyWindowStarted) / 1_000);
  const steadyAttempted = timestampsWithin(sender.attemptedAtMs, steadyWindowStarted, sustainedDeadline);
  const steadyAccepted = timestampsWithin(sender.acceptedAtMs, steadyWindowStarted, sustainedDeadline);
  const perPhonePacing = phones.map((phone) => {
    const phoneRoutes = routes.filter((route) => route.phoneNumberId === phone.id);
    const routeIds = phoneRoutes.map((route) => route.id);
    const scheduledSlots = routeIds.flatMap((routeId) => sender.scheduledAtByRoute.get(routeId) ?? []);
    const attempted = routeIds.flatMap((routeId) => sender.attemptedAtByRoute.get(routeId) ?? []);
    const accepted = routeIds.flatMap((routeId) => sender.acceptedAtByRoute.get(routeId) ?? []);
    const targetIntervalMs = 1_000 / effectivePhoneTps;
    const reservedSlots = noCatchUpPacing(scheduledSlots, targetIntervalMs);
    const attemptedPeakInRollingSecond = rollingOneSecondPeak(attempted);
    const acceptedPeakInRollingSecond = rollingOneSecondPeak(accepted);
    // A durable scheduled_send_at slot is the pacing authority. It must never
    // move backward or be compacted to catch up after a worker delay.
    assert.ok(reservedSlots.monotonic, `phone ${phone.id} reserved slots must be monotonic`);
    assert.ok(
      reservedSlots.satisfiesMinimumInterval,
      `phone ${phone.id} reserved slots must be at least ${targetIntervalMs - FLOATING_INTERVAL_TOLERANCE_MS}ms apart`,
    );
    assert.ok(
      attemptedPeakInRollingSecond <= effectivePhoneTps,
      `phone ${phone.id} attempted sends exceeded the ${effectivePhoneTps} TPS rolling ceiling`,
    );
    return {
      phoneNumberId: phone.id,
      phone: phone.phone,
      routeIds,
      effectivePhoneTps,
      reservedSlotIntervals: intervalStats([...scheduledSlots].sort((a, b) => a - b)),
      reservedSlotPacing: reservedSlots,
      attemptedInterSendIntervals: pacingStats([...attempted].sort((a, b) => a - b), targetIntervalMs),
      dispatchStartInterSendIntervals: pacingStats([...attempted].sort((a, b) => a - b), targetIntervalMs),
      providerAcceptedInterSendIntervals: pacingStats([...accepted].sort((a, b) => a - b), targetIntervalMs),
      providerCompletionInterSendIntervals: pacingStats([...accepted].sort((a, b) => a - b), targetIntervalMs),
      attemptedPeakInRollingSecond,
      // Largest catch-up burst: provider starts inside any 10ms window.
      attemptedPeakInRolling10Ms: rollingWindowPeak(attempted, 10),
      providerAcceptedPeakInRollingSecond: acceptedPeakInRollingSecond,
      attemptedCeilingSatisfied: attemptedPeakInRollingSecond <= effectivePhoneTps,
      dispatchStartCeilingSatisfied: attemptedPeakInRollingSecond <= effectivePhoneTps,
      // Response completions are observational only: variable provider
      // latency can reorder or cluster acknowledgements even when request
      // initiation obeys the hard rolling ceiling.
      providerAcceptedCeilingSatisfied: null,
      providerCompletionCeilingSatisfied: null,
    };
  });
  const [finalCounts] = await db.select({
    queued: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Queued')::int`,
    processing: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Processing')::int`,
    sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int`,
    failed: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Failed')::int`,
  }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
  assert.equal(finalCounts!.queued, 0, "benchmark queue must drain");
  assert.equal(finalCounts!.processing, 0, "no leases may remain after recovery");
  assert.equal(finalCounts!.sent, config.rows, "every generated contact must be sent");
  assert.equal(finalCounts!.failed, 0);
  const [interruptedFinal] = await db.select().from(campaignJobsTable)
    .where(eq(campaignJobsTable.id, interrupted.id));
  assert.equal(interruptedFinal!.status, "Sent", "interrupted job must be sent after recovery");
  assert.equal(interruptedFinal!.attempts, 2, "recovery must create exactly one replacement attempt");

  const afterWorkloadDatabaseBytes = await databaseSize();
  const afterWorkloadRelationsBytes = await campaignRelationSize();
  const afterCounters = await dbCounters();
  const hostCpuAfter = hostCpuSnapshot();
  const processIoAfter = processIoSnapshot();
  const diskAfter = await statfs(process.cwd());
  const counterDelta = Object.fromEntries(
    Object.keys(afterCounters).map((key) => [
      key,
      afterCounters[key as keyof typeof afterCounters] - workloadCounters[key as keyof typeof workloadCounters],
    ]),
  );
  const finalSource = sourceProfile();
  assert.deepEqual(
    finalSource,
    initialSource,
    "benchmark source profile changed while the measurement was running",
  );
  const result = {
    schemaVersion: 3,
    status: "ok" as const,
    measuredAt: new Date().toISOString(),
    source: initialSource,
    configuration: config,
    hardware: {
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      cpuDuringWorkload: hostCpuDelta(hostCpuBefore, hostCpuAfter),
      benchmarkProcess: {
        pid: process.pid,
        providerStarts: sender.sendAttempts,
        cpuUserMicros: finalProcessCpu.userMicros,
        cpuSystemMicros: finalProcessCpu.systemMicros,
        eventLoopUtilization: round(finalEventLoopUtilization.utilization),
      },
      loadAverage1m: {
        peak: round(maximumLoadAverage1m),
        normalizedPeakPercent: round((maximumLoadAverage1m / Math.max(1, os.cpus().length)) * 100),
      },
      memoryDuringWorkload: {
        minimumFreeBytes: minimumHostFreeMemoryBytes,
        maximumUsedBytes: os.totalmem() - minimumHostFreeMemoryBytes,
        maximumUsedPercent: round(((os.totalmem() - minimumHostFreeMemoryBytes) / os.totalmem()) * 100),
      },
      disk: {
        path: process.cwd(),
        capacityBytes: diskAfter.blocks * diskAfter.bsize,
        freeBytesBefore: diskBefore.bavail * diskBefore.bsize,
        freeBytesAfter: diskAfter.bavail * diskAfter.bsize,
        freeBytesDelta: (diskAfter.bavail - diskBefore.bavail) * diskAfter.bsize,
        processIo:
          processIoBefore && processIoAfter
            ? {
                readBytes: processIoAfter.readBytes - processIoBefore.readBytes,
                writeBytes: processIoAfter.writeBytes - processIoBefore.writeBytes,
                cancelledWriteBytes:
                  processIoAfter.cancelledWriteBytes - processIoBefore.cancelledWriteBytes,
              }
            : null,
      },
    },
    database: profile,
    import: {
      rows: config.rows,
      csvBytes: bytesProcessed,
      seconds: round(importSeconds),
      rowsPerSecond: round(config.rows / importSeconds),
      productionBatchSize: BATCH_SIZE,
    },
    workload: {
      routes: config.routes,
      phones: config.phones,
      executionPath: "CampaignRuntime-adaptive-lanes",
      coordinatorMode: pacingCoordinatorMode,
      platformMaxTps: CAMPAIGN_PLATFORM_MAX_TPS,
      configuredTps: config.configuredTps,
      providerApprovedTps: config.providerTpsLimit,
      effectivePhoneTps,
      effectiveRouteTps,
      sustainedSecondsAsserted: config.sustainedSeconds,
      maxConsecutiveStalledSamples,
      totalElapsedSeconds: round((performance.now() - importStarted) / 1_000),
      activeSendSeconds: round(workloadSeconds),
      claimCalls: claimCounters.calls,
      successfulClaims: claimCounters.successful,
      claimCallsPerSecond: round(claimCounters.calls / workloadSeconds),
      successfulClaimsPerSecond: round(claimCounters.successful / workloadSeconds),
      claimLatencyMsP50: round(percentile(claimCounters.latenciesMs, 0.5)),
      claimLatencyMsP95: round(percentile(claimCounters.latenciesMs, 0.95)),
      claimLatencyMsP99: round(percentile(claimCounters.latenciesMs, 0.99)),
      sendAttempts: sender.sendAttempts,
      successfulSends: sender.sent,
      peakConcurrentProviderCalls: sender.peakActive,
      injectedRetries: sender.retries,
      retryPressurePercent: round((sender.retries / sender.sendAttempts) * 100),
      sendsPerSecond: round(sender.sent / workloadSeconds),
      steadyWindowSeconds: round(steadyWindowSeconds),
      providerStartTps: round(steadyAttempted.length / steadyWindowSeconds),
      steadyAttemptedTps: round(steadyAttempted.length / steadyWindowSeconds),
      steadySuccessfulTps: round(steadyAccepted.length / steadyWindowSeconds),
      minimumSustainedWindowSeconds: round(steadyWindowSeconds),
      attemptedInterSendIntervals: intervalStats(sender.attemptedAtMs),
      providerAcceptedInterSendIntervals: intervalStats(sender.acceptedAtMs),
      dispatchStartInterSendIntervals: intervalStats(sender.attemptedAtMs),
      providerCompletionInterSendIntervals: intervalStats(sender.acceptedAtMs),
      phaseTimings: finalWorkerPhaseTimings,
      authorizationLatencyMs: {
        samples: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        note: "Authorization is completed before the provider-start hot path; no authorization step runs between dispatch permit and provider start.",
      },
      dispatchMetrics: finalDispatchMetrics,
      phoneLaneMetrics: finalPhoneLaneMetrics,
      processCalls: claimCounters.calls,
      idleClaims: claimCounters.idle,
      idleClaimPercent: round((claimCounters.idle / Math.max(1, claimCounters.calls)) * 100),
      processOneLatencyMsP50: round(percentile(claimCounters.latenciesMs, 0.5)),
      processOneLatencyMsP95: round(percentile(claimCounters.latenciesMs, 0.95)),
      processOneLatencyMsP99: round(percentile(claimCounters.latenciesMs, 0.99)),
      workerErrors: 0,
      peakWaitingDatabaseLocks: peakWaitingLocks,
      peakDatabaseConnections,
      peakActiveDatabaseConnections,
      transientDatabaseRetries,
      deadlockRetries,
      serializationRetries,
      databaseCounterDelta: counterDelta,
      progressSamples,
      perPhonePacing,
      sendsByRoute: routes.map((route) => ({
        routeId: route.id,
        phoneNumberId: route.phoneNumberId,
        configuredTps: config.configuredTps,
        effectiveRouteTps,
        successfulSends: sender.sentByRoute.get(route.id) ?? 0,
        peakConcurrentProviderCalls: sender.peakActiveByRoute.get(route.id) ?? 0,
        steadyAttemptedTps: round(
          timestampsWithin(
            sender.attemptedAtByRoute.get(route.id) ?? [],
            steadyWindowStarted,
            sustainedDeadline,
          ).length / steadyWindowSeconds,
        ),
        steadySuccessfulTps: round(
          timestampsWithin(
            sender.acceptedAtByRoute.get(route.id) ?? [],
            steadyWindowStarted,
            sustainedDeadline,
          ).length / steadyWindowSeconds,
        ),
        attemptedInterSendIntervals: pacingStats(
          timestampsWithin(
            sender.attemptedAtByRoute.get(route.id) ?? [],
            steadyWindowStarted,
            sustainedDeadline,
          ),
          1_000 / effectiveRouteTps,
        ),
        dispatchStartInterSendIntervals: pacingStats(
          timestampsWithin(
            sender.attemptedAtByRoute.get(route.id) ?? [],
            steadyWindowStarted,
            sustainedDeadline,
          ),
          1_000 / effectiveRouteTps,
        ),
        providerAcceptedInterSendIntervals: pacingStats(
          timestampsWithin(
            sender.acceptedAtByRoute.get(route.id) ?? [],
            steadyWindowStarted,
            sustainedDeadline,
          ),
          1_000 / effectiveRouteTps,
        ),
        providerCompletionInterSendIntervals: pacingStats(
          timestampsWithin(
            sender.acceptedAtByRoute.get(route.id) ?? [],
            steadyWindowStarted,
            sustainedDeadline,
          ),
          1_000 / effectiveRouteTps,
        ),
        reservedSlotIntervals: intervalStats(
          (sender.scheduledAtByRoute.get(route.id) ?? []).sort((a, b) => a - b),
        ),
        reservedSlotPacing: noCatchUpPacing(
          sender.scheduledAtByRoute.get(route.id) ?? [],
          1_000 / effectiveRouteTps,
        ),
        dispatchLatenessMs: intervalStats(
          sender.dispatchLatenessMsByRoute.get(route.id) ?? [],
        ),
      })),
      eventLoopDelayMs: finalEventLoopDelayMs,
    },
    recoveryAssertions: {
      interruptedLeaseRequeued: true,
      interruptedJobEventuallySent: true,
      interruptedJobAttempts: interruptedFinal!.attempts,
      queueDrained: true,
      noProcessingLeasesRemain: true,
    },
    growth: {
      databaseBytes: {
        before: beforeDatabaseBytes,
        afterImport: afterImportDatabaseBytes,
        afterWorkload: afterWorkloadDatabaseBytes,
        importDelta: afterImportDatabaseBytes - beforeDatabaseBytes,
        totalDelta: afterWorkloadDatabaseBytes - beforeDatabaseBytes,
      },
      campaignRelationsBytes: {
        before: beforeRelationsBytes,
        afterImport: afterImportRelationsBytes,
        afterWorkload: afterWorkloadRelationsBytes,
        importDelta: afterImportRelationsBytes - beforeRelationsBytes,
        totalDelta: afterWorkloadRelationsBytes - beforeRelationsBytes,
      },
    },
    memory: {
      peakRssBytes: peakRss,
      peakHeapUsedBytes: peakHeapUsed,
    },
    limitations: [
      "Simulated sender; no Meta credentials, network, or provider behavior measured.",
      "Results apply only to the recorded configuration, hardware, and PostgreSQL profile.",
      "This result does not establish 10–20M contact capacity or 1000 TPS unless those values were directly configured and measured.",
    ],
  };

  partialState.phase = "result";
  const writeError = writeTerminalResultSync(result);
  // As before: a success result that could not be persisted fails the run.
  if (writeError) throw writeError;

  if (process.env.CAMPAIGN_BENCHMARK_KEEP_DATA !== "1") {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    organizationId = undefined;
  }
} catch (error) {
  primaryFailure = error;
  // Before teardown: the result must exist even if cleanup below is slow or fails.
  writeTerminalResultSync(failureResult("failed", error));
  throw error;
} finally {
  let cleanupFailure = await stopAndSettleWorkers();
  if (organizationId && process.env.CAMPAIGN_BENCHMARK_KEEP_DATA !== "1") {
    try {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  try {
    await pool.end();
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (primaryFailure && cleanupFailure) {
    process.stderr.write(`Benchmark cleanup failure suppressed after primary failure: ${errorDescription(cleanupFailure)}\n`);
  } else if (!primaryFailure && cleanupFailure) {
    throw cleanupFailure;
  }
  // The result is written and teardown is complete. Anything still keeping
  // the event loop alive (a straggling handle in a closed component) must not
  // turn a finished run into a driver timeout: exit deterministically.
  setTimeout(() => {
    process.stderr.write("benchmark: exiting; a handle kept the event loop alive after teardown\n");
    process.exit(primaryFailure ? 1 : 0);
  }, 5_000).unref();
}