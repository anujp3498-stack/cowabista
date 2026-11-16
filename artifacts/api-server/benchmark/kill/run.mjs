// Kill benchmark: crash ambiguity, duplicates, rate cap, takeover and throughput of the real transport under a
// hard kill, with a local fake Graph server as the ground truth of what reached the provider. Not part of Gate B's
// measured files; it measures whatever runtime source the checkout holds (identity.json records the commit, whether
// the tree is clean and measuredFilesSha256).
//
// Usage (from artifacts/api-server):
//   node benchmark/kill/run.mjs --label <name> [--mode static|auto] [--cells 2] [--phones 4] [--tps 1000]
//        [--rows-per-phone 90000] [--shards 8] [--latency-ms 50] [--jitter-ms 0] [--warmup-s 25] [--warmup-max-s 120]
//        [--restart-delay-ms 2000 | --no-restart] [--no-kill] [--settle-timeout-s 300]
// Env (same rules as benchmark/run.mjs): CAMPAIGN_BENCHMARK_DATABASE_URL (name with a bench/benchmark segment),
// CAMPAIGN_BENCHMARK_CONFIRM=<that name>, REDIS_URL (a Redis used for nothing else: it is flushed).
// Results: benchmark-results/kill/<label>/ (git-ignored): identity.json, seed.json, held.json, graph.ndjson,
// graph-stats.jsonl, cell-*.metrics.jsonl, cell-*.log, progress.jsonl, jobs.csv, result.json, summary.md.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { analyze } from "./analyze.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, "..", "..");
const repo = path.resolve(api, "..", "..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}
const flag = (name) => process.argv.includes(`--${name}`);
const int = (name, fallback) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
};
const config = {
  label: option("label"),
  mode: option("mode", "static"),
  cells: int("cells", 2),
  phones: int("phones", 4),
  tps: int("tps", 1000),
  rowsPerPhone: int("rows-per-phone", 90_000),
  shards: int("shards", 8),
  latencyMs: int("latency-ms", 50),
  jitterMs: int("jitter-ms", 0),
  warmupS: int("warmup-s", 25),
  warmupMaxS: int("warmup-max-s", 120),
  restartDelayMs: flag("no-restart") ? null : int("restart-delay-ms", 2000),
  kill: !flag("no-kill"),
  settleTimeoutS: int("settle-timeout-s", 300),
};
if (!config.label || !/^[A-Za-z0-9._-]+$/.test(config.label)) throw new Error("--label <name> is required (letters, digits, . _ -)");
if (!["static", "auto"].includes(config.mode)) throw new Error("--mode must be static or auto");
if (config.mode === "static") config.cells = 1;
if (config.phones < 1 || config.phones > 10) throw new Error("--phones must be 1..10");

// Same database rules as benchmark/run.mjs, plus: never production mode (the shard threads would ignore the fake
// Graph URL and call graph.facebook.com).
const databaseUrl = process.env.CAMPAIGN_BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("CAMPAIGN_BENCHMARK_DATABASE_URL is required");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
if (!/(^|[_-])(bench|benchmark)([_-]|$)/i.test(databaseName)) throw new Error(`Refusing database "${databaseName}": its name must contain a bench or benchmark segment`);
if (process.env.CAMPAIGN_BENCHMARK_CONFIRM !== databaseName) throw new Error(`Set CAMPAIGN_BENCHMARK_CONFIRM=${databaseName}`);
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL (a dedicated Redis; it is flushed) is required");
if (process.env.NODE_ENV === "production") throw new Error("Refusing NODE_ENV=production: sends would bypass the fake Graph server");

const out = path.join(api, "benchmark-results", "kill", config.label);
if (existsSync(out) && readdirSync(out).length) throw new Error(`result directory is not empty: ${out}`);
mkdirSync(out, { recursive: true });
const dist = path.join(out, ".dist");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[kill-bench ${new Date().toISOString()}] ${message}`);
const psql = (query) => execFileSync("psql", [databaseUrl, "-At", "-F", ",", "-c", query], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
/** Large results go straight to a file: execFileSync's output buffer would overflow on hundreds of thousands of rows. */
const psqlToFile = (query, file) => execFileSync("psql", [databaseUrl, "-At", "-F", ",", "-o", file, "-c", query], { stdio: ["ignore", "ignore", "inherit"] });

// 1. Identity of what is measured.
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const identity = {
  commit: git("rev-parse", "HEAD"),
  dirtyFiles: git("status", "--porcelain").split("\n").filter(Boolean).length,
  measuredFilesSha256: execFileSync("node", [path.join(repo, ".github/scripts/gate-b-hash.mjs")], { cwd: repo, encoding: "utf8" }).trim(),
  node: process.version,
  cpus: execFileSync("nproc", { encoding: "utf8" }).trim(),
  config,
  startedAt: new Date().toISOString(),
};
writeFileSync(path.join(out, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
log(`commit ${identity.commit.slice(0, 12)} dirty=${identity.dirtyFiles} ${identity.measuredFilesSha256}`);

// 2. Bundles (package-local for module resolution; under the git-ignored results directory).
const banner = { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" };
const external = ["pg-native", "pino", "pino-pretty", "thread-stream"];
for (const [entry, outfile] of [
  [path.join(here, "seed.ts"), "seed.mjs"],
  [path.join(here, "cell.ts"), "cell.mjs"],
  [path.join(api, "src/services/campaign-transport-shard-worker.ts"), "campaign-transport-shard-worker.mjs"],
]) {
  await build({ entryPoints: [entry], outfile: path.join(dist, outfile), bundle: true, platform: "node", format: "esm", sourcemap: "inline", external, banner, logLevel: "error" });
}

// 3. Fresh database and Redis (the kit's own prepare step: guarded push-force).
execFileSync(path.join(api, "benchmark/distributed/prepare.sh"), { stdio: ["ignore", "ignore", "inherit"], env: process.env });
log("database and Redis prepared");

const children = new Set();
const expectedExit = new Set();
const unexpectedExits = [];
function start(name, command, args, env, readyPattern) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: api, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const logFile = path.join(out, `${name}.log`);
    let buffered = "";
    let ready = false;
    const append = (chunk) => { writeFileSync(logFile, chunk, { flag: "a" }); };
    child.stdout.on("data", (chunk) => {
      append(chunk);
      if (ready) return;
      buffered += chunk.toString("utf8");
      const match = readyPattern.exec(buffered);
      if (match) { ready = true; buffered = ""; resolve({ child, match }); }
    });
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (!ready) reject(new Error(`${name} exited before it was ready (code=${code}, signal=${signal}); see ${logFile}`));
      else if (!expectedExit.has(child) && name !== "seed") {
        unexpectedExits.push({ name, code, signal, at: Date.now() });
        log(`UNEXPECTED EXIT of ${name} (code=${code}, signal=${signal}); see ${logFile}`);
      }
    });
  });
}
async function stop(child, timeoutMs = 30_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  expectedExit.add(child);
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
process.on("exit", () => { for (const child of children) child.kill("SIGKILL"); });

const baseEnv = { ...process.env };
for (const name of Object.keys(baseEnv)) {
  if (name.startsWith("CAMPAIGN_TEST_") || name.startsWith("CAMPAIGN_TRANSPORT_") || name === "NODE_ENV" || name === "CAMPAIGN_CELL") delete baseEnv[name];
}
const encryptionKey = randomBytes(32).toString("base64");
const token = `EAAG-kill-bench-${randomBytes(12).toString("hex")}`;

try {
  // 4. Fake Graph server.
  const { child: graph, match: graphReady } = await start("fake-graph", process.execPath, [
    path.join(here, "fake-graph.mjs"), "--port", "0", "--log", path.join(out, "graph.ndjson"), "--stats", path.join(out, "graph-stats.jsonl"),
    "--latency-ms", String(config.latencyMs), "--jitter-ms", String(config.jitterMs),
  ], baseEnv, /FAKE_GRAPH_READY port=(\d+)/);
  const graphPort = Number(graphReady[1]);
  log(`fake Graph server on 127.0.0.1:${graphPort}, latency ${config.latencyMs} ms`);

  // 5. Seed.
  const slug = `kill-${config.label}-${process.pid}`.toLowerCase().slice(0, 60);
  await start("seed", process.execPath, [path.join(dist, "seed.mjs")], {
    ...baseEnv, DATABASE_URL: databaseUrl, WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: encryptionKey, KILL_BENCH_TOKEN: token,
    KILL_BENCH_PHONES: String(config.phones), KILL_BENCH_TPS: String(config.tps), KILL_BENCH_ROWS_PER_PHONE: String(config.rowsPerPhone),
    KILL_BENCH_SLUG: slug, KILL_BENCH_SEED_OUT: path.join(out, "seed.json"),
  }, /KILL_BENCH_SEEDED/);
  while (!existsSync(path.join(out, "seed.json"))) await sleep(100);
  await sleep(500);
  const seed = JSON.parse(readFileSync(path.join(out, "seed.json"), "utf8"));
  log(`seeded campaign ${seed.campaignId}: ${seed.total} jobs on ${config.phones} phones in ${seed.seededMs} ms`);

  // 6. Cells.
  const phoneIds = seed.phones.map((phone) => phone.id);
  const cells = new Map(); // name -> { child, generation, prefix }
  const generations = new Map();
  async function startCell(name) {
    const generation = (generations.get(name) ?? 0) + 1;
    generations.set(name, generation);
    const prefix = `${name}-g${generation}`;
    const graphUrl = `http://127.0.0.1:${graphPort}/${prefix}`;
    const assignment = config.mode === "static"
      ? { CAMPAIGN_TRANSPORT_PHONE_IDS: phoneIds.join(",") }
      : { CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto" };
    const { child } = await start(prefix, process.execPath, [path.join(dist, "cell.mjs")], {
      ...baseEnv, ...assignment,
      DATABASE_URL: databaseUrl, CAMPAIGN_REDIS_URL: redisUrl, CAMPAIGN_COORDINATOR_MODE: "redis", CAMPAIGN_CELL: name,
      CAMPAIGN_TRANSPORT_SHARDS: String(config.shards), WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      CAMPAIGN_TEST_GRAPH_BASE_URL: graphUrl, KILL_BENCH_FAKE_GRAPH_URL: graphUrl,
      KILL_BENCH_METRICS: path.join(out, `${prefix}.metrics.jsonl`),
    }, /KILL_BENCH_CELL_READY pid=(\d+)/);
    const cell = { name, child, generation, prefix, pid: child.pid, startedAt: Date.now() };
    cells.set(name, cell);
    log(`started ${prefix} pid ${child.pid}`);
    return cell;
  }
  for (let k = 1; k <= config.cells; k += 1) await startCell(`cell-${k}`);
  const runStartedAt = Date.now();

  // Progress sampler (job states on one clock).
  const progress = [];
  const progressTimer = setInterval(() => {
    try {
      const [queued, processing, sent, failed] = psql(`select count(*) filter (where status='Queued'), count(*) filter (where status='Processing'),
        count(*) filter (where status='Sent'), count(*) filter (where status='Failed') from campaign_jobs where campaign_id=${seed.campaignId}`).split(",").map(Number);
      progress.push({ t: Date.now(), queued, processing, sent, failed });
    } catch { /* sampler only */ }
  }, 2_000);

  // 7. Warm-up: every phone near its rate for 5 s (and, automatic, every cell sending), at least warmupS.
  const statsFile = path.join(out, "graph-stats.jsonl");
  const lastStats = (count) => {
    if (!existsSync(statsFile)) return [];
    return readFileSync(statsFile, "utf8").trim().split("\n").filter(Boolean).slice(-count).map((line) => JSON.parse(line));
  };
  let warmed = false;
  while (Date.now() - runStartedAt < config.warmupMaxS * 1000 && !unexpectedExits.length) {
    await sleep(1_000);
    if (Date.now() - runStartedAt < config.warmupS * 1000) continue;
    const recent = lastStats(5);
    const phonesOk = recent.length === 5 && recent.every((sample) => seed.phones.every((phone) => (sample.phones[phone.providerPhoneId] ?? 0) >= 0.9 * config.tps));
    const live = [...cells.values()].map((cell) => cell.prefix);
    const cellsOk = config.mode === "static" || live.every((prefix) => (recent.at(-1)?.prefixes[prefix] ?? 0) > 0);
    if (phonesOk && cellsOk) { warmed = true; break; }
  }
  log(`warm-up ${warmed ? "reached" : "NOT reached (proceeding; recorded)"} after ${Math.round((Date.now() - runStartedAt) / 1000)} s`);

  // 8. Kill.
  let kill = null;
  if (config.kill) {
    const recent = lastStats(1)[0] ?? { prefixes: {} };
    const victim = [...cells.values()].sort((a, b) => (recent.prefixes[b.prefix] ?? 0) - (recent.prefixes[a.prefix] ?? 0))[0];
    const killedAt = Date.now();
    expectedExit.add(victim.child);
    await new Promise((resolve) => { victim.child.once("exit", resolve); victim.child.kill("SIGKILL"); });
    const held = psql(`select id, route_id from campaign_jobs where campaign_id=${seed.campaignId} and status='Processing'
      and locked_by like 'api-${victim.pid}-%'`).split("\n").filter(Boolean).map((line) => line.split(",").map(Number));
    kill = { victim: victim.name, prefix: victim.prefix, pid: victim.pid, killedAt, heldAtKill: held.length, heldReadMs: Date.now() - killedAt };
    writeFileSync(path.join(out, "held.json"), `${JSON.stringify({ ...kill, jobs: held.map(([id, routeId]) => ({ id, routeId })) })}\n`);
    log(`SIGKILL ${victim.prefix} (pid ${victim.pid}); it held ${held.length} jobs`);
    cells.delete(victim.name);
    if (config.restartDelayMs !== null) {
      await sleep(config.restartDelayMs);
      const restarted = await startCell(victim.name);
      kill.restartedAt = restarted.startedAt;
      kill.restartPrefix = restarted.prefix;
    }
  }

  // 9. Settle: no job left Queued or Processing.
  const settleStarted = Date.now();
  let settled = false;
  while (Date.now() - settleStarted < config.settleTimeoutS * 1000 && !unexpectedExits.length) {
    await sleep(2_000);
    const open = Number(psql(`select count(*) from campaign_jobs where campaign_id=${seed.campaignId} and status in ('Queued','Processing')`));
    if (open === 0) { settled = true; break; }
  }
  log(`jobs ${settled ? "settled" : "NOT settled within the timeout"}`);
  clearInterval(progressTimer);
  await sleep(2_000);
  for (const cell of cells.values()) await stop(cell.child);
  await stop(graph);
  writeFileSync(path.join(out, "progress.jsonl"), progress.map((row) => JSON.stringify(row)).join("\n") + "\n");

  // 10. Collect and analyse.
  psqlToFile(`select j.id, j.route_id, j.status, j.attempts, coalesce(regexp_replace(j.error_reason, '[,\\r\\n]+', ' ', 'g'), ''),
      coalesce((extract(epoch from j.scheduled_send_at) * 1000)::bigint::text, ''), c.normalized_phone,
      coalesce(pm.status, ''), coalesce(pm.provider_message_id, '')
    from campaign_jobs j join campaign_contacts c on c.id = j.contact_id
    left join provider_messages pm on pm.campaign_job_id = j.id
    where j.campaign_id = ${seed.campaignId} order by j.id`, path.join(out, "jobs.csv"));
  const result = analyze(out, { config, seed, kill, settled, warmed, runStartedAt, identity, unexpectedExits });
  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(out, "summary.md"), result.summary);
  console.log(result.summary);
} finally {
  for (const child of children) child.kill("SIGKILL");
}
process.exit(0);
