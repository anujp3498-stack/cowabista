import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const sizes = (process.env.CAMPAIGN_BENCHMARK_STEPS ?? "6000,8000,10000")
  .split(",")
  .map((value) => Number(value.trim()));
if (!sizes.length || sizes.some((value) => !Number.isSafeInteger(value) || value < 1)) {
  throw new Error("CAMPAIGN_BENCHMARK_STEPS must be a comma-separated list of positive integers");
}
const repeats = positiveInteger("CAMPAIGN_BENCHMARK_REPEATS", 3);
const maxRunSeconds = positiveInteger("CAMPAIGN_BENCHMARK_MAX_RUN_SECONDS", 900);
const studyId = process.env.CAMPAIGN_BENCHMARK_STUDY_ID;
if (!studyId || !/^[a-z0-9][a-z0-9-]*$/i.test(studyId)) {
  throw new Error("CAMPAIGN_BENCHMARK_STUDY_ID is required and must contain only letters, digits, and hyphens");
}
const outputDir = path.resolve(process.env.CAMPAIGN_BENCHMARK_STUDY_OUTPUT_DIR ?? `benchmark-results/${studyId}`);
await mkdir(outputDir, { recursive: true });
const workspaceRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const initialCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: workspaceRoot,
  encoding: "utf8",
}).trim();
const initialStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: workspaceRoot,
  encoding: "utf8",
}).trim();
if (initialStatus) throw new Error("Stepped campaign studies require a clean Git working tree");

function runOne(rows, repeat, output) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["./benchmark/run.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CAMPAIGN_BENCHMARK_ROWS: String(rows),
        CAMPAIGN_BENCHMARK_OUTPUT: output,
        CAMPAIGN_BENCHMARK_REQUIRE_CLEAN: "1",
      },
      stdio: "inherit",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), maxRunSeconds * 1000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ rows, repeat, seconds: (Date.now() - started) / 1000, code, signal });
    });
  });
}

const runs = [];
let stopCondition = { kind: "all-configured-steps-passed" };
for (const rows of sizes) {
  let passed = true;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const output = path.join(outputDir, `campaign-${rows}-repeat-${repeat}.json`);
    const execution = await runOne(rows, repeat, output);
    if (execution.code !== 0) {
      runs.push({ ...execution, passed: false });
      stopCondition = {
        kind: execution.signal ? "run-time-limit" : "benchmark-failure",
        rows,
        repeat,
        maxRunSeconds,
      };
      passed = false;
      break;
    }
    const result = JSON.parse(await readFile(output, "utf8"));
    if (result.source.workingTreeDirty || result.source.gitCommit !== initialCommit) {
      throw new Error(`Run ${rows} repeat ${repeat} did not preserve the clean starting source`);
    }
    runs.push({
      ...execution,
      passed: true,
      output: path.basename(output),
      measuredAt: result.measuredAt,
      source: result.source,
      importRowsPerSecond: result.import.rowsPerSecond,
      sendsPerSecond: result.workload.sendsPerSecond,
      attemptedInterSendIntervals: result.workload.attemptedInterSendIntervals,
      providerAcceptedInterSendIntervals: result.workload.providerAcceptedInterSendIntervals,
      phaseTimings: result.workload.phaseTimings,
      claimLatencyMsP95: result.workload.claimLatencyMsP95,
      peakRssBytes: result.memory.peakRssBytes,
      hostCpuBusyPercent: result.hardware.cpuDuringWorkload.busyPercent,
      hostMemoryUsedPercent: result.hardware.memoryDuringWorkload.maximumUsedPercent,
      postgresPeakConnections: result.workload.peakDatabaseConnections,
      postgresPeakWaitingLocks: result.workload.peakWaitingDatabaseLocks,
      postgresTempBytes: result.workload.databaseCounterDelta.temp_bytes,
    });
  }
  if (!passed) break;
}

const passingSizes = sizes.filter((rows) => runs.filter((run) => run.rows === rows && run.passed).length === repeats);
const largestRepeatedlyPassingRows = passingSizes.at(-1) ?? null;
const summary = {
  schemaVersion: 1,
  studyId,
  createdAt: new Date().toISOString(),
  policy: { sizes, repeats, maxRunSeconds },
  stopCondition,
  largestRepeatedlyPassingRows,
  runs,
};
const summaryPath = path.join(outputDir, "study-summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ summaryPath, largestRepeatedlyPassingRows, stopCondition }, null, 2));
if (!largestRepeatedlyPassingRows) process.exitCode = 1;