import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// A benchmark run measured at ~44 sends/sec (100k contacts, ~40min, zero
// deadlocks/stalls) when the dev "API Server" workflow was stopped first --
// but an earlier 100k run left it running and stalled at ~5.4 sends/sec
// after 48 minutes, because that workflow's own campaign-runtime worker and
// normal traffic share this container's CPU/IO with the benchmark database
// (same Postgres server, different database) and starve it under load. This
// preflight check exists so that mistake produces an immediate, actionable
// error instead of a misleading multi-hour stall + wrong diagnosis.
function checkForContendingWorkflow() {
  if (process.env.CAMPAIGN_BENCHMARK_SKIP_CONTENTION_CHECK === "1") return;
  let psOutput = "";
  try {
    psOutput = execSync("ps aux", { encoding: "utf8" });
  } catch {
    return; // best-effort only; never fail the benchmark because `ps` is unavailable
  }
  const contending = psOutput
    .split("\n")
    .filter((line) => line.includes("dist/index.mjs") && !line.includes("grep"));
  if (contending.length > 0) {
    throw new Error(
      "The dev \"API Server\" workflow (dist/index.mjs) appears to be running. Its campaign-runtime worker " +
      "and normal traffic contend with the benchmark database for this container's CPU/IO, which has been " +
      "measured to collapse benchmark throughput ~8x and produce a false stall. Stop the " +
      "`artifacts/api-server: API Server` workflow before running this benchmark, then restart it afterward. " +
      "Set CAMPAIGN_BENCHMARK_SKIP_CONTENTION_CHECK=1 to bypass this check if you are certain it is safe.",
    );
  }
}
checkForContendingWorkflow();

const databaseUrl = process.env.CAMPAIGN_BENCHMARK_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("CAMPAIGN_BENCHMARK_DATABASE_URL is required; the benchmark never uses DATABASE_URL implicitly");
}
const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
if (!/(^|[_-])(bench|benchmark)([_-]|$)/i.test(databaseName)) {
  throw new Error(`Refusing database "${databaseName}": its name must contain a bench or benchmark segment`);
}
if (process.env.CAMPAIGN_BENCHMARK_CONFIRM !== databaseName) {
  throw new Error(`Set CAMPAIGN_BENCHMARK_CONFIRM=${databaseName} to confirm the dedicated database`);
}

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(benchmarkDir, "..");
const repoRoot = path.resolve(artifactDir, "..", "..");

// A fresh dedicated benchmark database has no tables yet -- without this,
// the very first query in campaign-benchmark.ts fails with a bare "relation
// does not exist" and no indication that a schema push was the missing
// step. Push (not migrate) is correct here: this is a disposable benchmark
// database recreated from the current dev schema, not a real environment
// with migration history to preserve. --force is required because this
// process has no TTY to answer drizzle-kit's interactive prompts.
if (process.env.CAMPAIGN_BENCHMARK_SKIP_SCHEMA_PUSH !== "1") {
  console.log(`Pushing current schema to benchmark database "${databaseName}"...`);
  const push = spawnSync("pnpm", ["--filter", "@workspace/db", "run", "push-force"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (push.status !== 0) {
    throw new Error(`Schema push to the benchmark database failed (exit ${push.status})`);
  }
}

const outputDir = path.join(artifactDir, ".benchmark-dist");
const output = path.join(outputDir, "campaign-benchmark.mjs");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(benchmarkDir, "campaign-benchmark.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);",
  },
});
await build({
  entryPoints: [path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts")],
  outfile: path.join(outputDir, "campaign-transport-shard-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);" },
});

const child = spawn(process.execPath, ["--expose-gc", output], {
  cwd: artifactDir,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "inherit",
});
child.on("exit", async (code, signal) => {
  await rm(outputDir, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});