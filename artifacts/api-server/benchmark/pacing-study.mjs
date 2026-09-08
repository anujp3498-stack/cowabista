import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function list(name, fallback) {
  const values = (process.env[name] ?? fallback).split(",").map((value) => Number(value.trim()));
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  }
  return values;
}

const tpsStages = list("CAMPAIGN_PACING_TPS_STAGES", "100,250,500,750,1000");
const phoneStages = list("CAMPAIGN_PACING_PHONE_STAGES", "1,2,4,8");
const repeats = positiveInteger("CAMPAIGN_BENCHMARK_REPEATS", 3);
const measurementSeconds = positiveInteger("CAMPAIGN_BENCHMARK_SUSTAINED_SECONDS", 15);
const maximumVariancePercent = positiveInteger("CAMPAIGN_PACING_MAX_VARIANCE_PERCENT", 12);
const maximumP99Multiplier = positiveInteger("CAMPAIGN_PACING_MAX_P99_MULTIPLIER", 5);
const studyId = process.env.CAMPAIGN_BENCHMARK_STUDY_ID;
if (!studyId || !/^[a-z0-9][a-z0-9-]*$/i.test(studyId)) {
  throw new Error("CAMPAIGN_BENCHMARK_STUDY_ID is required and must contain only letters, digits, and hyphens");
}
const outputDir = path.resolve(process.env.CAMPAIGN_BENCHMARK_STUDY_OUTPUT_DIR ?? `benchmark-results/${studyId}`);
await mkdir(outputDir, { recursive: true });
const workspaceRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: workspaceRoot, encoding: "utf8" }).trim());
if (workingTreeDirty && process.env.CAMPAIGN_PACING_ALLOW_DIRTY !== "1") {
  throw new Error("Pacing studies require a clean Git working tree");
}

function runOne({ tps, phones, repeat, output }) {
  const retryFactor = 1.06;
  const rows = Math.ceil(tps * phones * measurementSeconds * retryFactor);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./benchmark/run.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CAMPAIGN_BENCHMARK_CONFIGURED_TPS: String(tps),
        CAMPAIGN_BENCHMARK_PROVIDER_TPS_LIMIT: String(tps),
        CAMPAIGN_BENCHMARK_PHONES: String(phones),
        CAMPAIGN_BENCHMARK_ROUTES: String(phones),
        CAMPAIGN_BENCHMARK_ROWS: String(rows),
        CAMPAIGN_BENCHMARK_OUTPUT: output,
        CAMPAIGN_BENCHMARK_REQUIRE_CLEAN: workingTreeDirty ? "0" : "1",
        CAMPAIGN_BENCHMARK_SKIP_SCHEMA_PUSH: repeat === 1 && phones === phoneStages[0] && tps === tpsStages[0] ? "0" : "1",
        CAMPAIGN_BENCHMARK_RETRY_EVERY: process.env.CAMPAIGN_PACING_RETRY_EVERY ?? "1000000000",
      },
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => resolve({ code, signal, rows }));
  });
}

const stages = [];
let singleNumberCertified = true;
let previousScaleCertified = true;
for (const phones of phoneStages) {
  if (phones > 1 && (!singleNumberCertified || !previousScaleCertified)) break;
  let thisScaleCertified = true;
  for (const tps of tpsStages) {
    const runs = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const output = path.join(outputDir, `phones-${phones}-tps-${tps}-repeat-${repeat}.json`);
      const execution = await runOne({ tps, phones, repeat, output });
      if (execution.code !== 0) {
        runs.push({ repeat, passed: false, ...execution });
        break;
      }
      const result = JSON.parse(await readFile(output, "utf8"));
      runs.push({
        repeat,
        passed: true,
        output: path.basename(output),
        coordinatorMode: result.workload.coordinatorMode,
        platformMaxTps: result.workload.platformMaxTps,
        configuredTps: result.workload.configuredTps,
        providerApprovedTps: result.workload.providerApprovedTps,
        effectivePhoneTps: result.workload.effectivePhoneTps,
        effectiveRouteTps: result.workload.effectiveRouteTps,
        achievedSuccessfulTps: result.workload.steadySuccessfulTps,
        achievedAttemptedTps: result.workload.steadyAttemptedTps,
        attemptedIntervals: result.workload.attemptedInterSendIntervals,
        acceptedIntervals: result.workload.providerAcceptedInterSendIntervals,
        dispatchStartIntervals: result.workload.dispatchStartInterSendIntervals,
        providerCompletionIntervals: result.workload.providerCompletionInterSendIntervals,
        phaseTimings: result.workload.phaseTimings,
        maxConsecutiveStalledSamples: result.workload.maxConsecutiveStalledSamples,
        perPhone: result.workload.perPhonePacing,
        perRoute: result.workload.sendsByRoute,
      });
    }
    const achieved = runs.filter((run) => run.passed).map((run) => run.achievedSuccessfulTps);
    const mean = achieved.reduce((sum, value) => sum + value, 0) / Math.max(1, achieved.length);
    const variancePercent = achieved.length
      ? ((Math.max(...achieved) - Math.min(...achieved)) / mean) * 100
      : Infinity;
    const passed = runs.length === repeats
      && runs.every((run) => run.passed)
      && variancePercent <= maximumVariancePercent
      && mean >= tps * phones * 0.85
      && mean <= tps * phones * 1.02
      && (phones !== 1 || tps !== 1_000
        || runs.every((run) => run.achievedSuccessfulTps >= 950))
      && runs.every((run) => run.perPhone.every((phone) =>
        phone.reservedSlotPacing.monotonic
        && phone.reservedSlotPacing.satisfiesMinimumInterval
        && phone.attemptedCeilingSatisfied))
      && runs.every((run) => run.perRoute.every((route) =>
        route.dispatchStartInterSendIntervals.p99Ms <= (1_000 / tps) * maximumP99Multiplier
        && route.dispatchStartInterSendIntervals.burstPercent <= 0.5
        && route.dispatchStartInterSendIntervals.idleGapPercent <= 0.5));
    const minimumSuccessfulTps = achieved.length ? Math.min(...achieved) : 0;
    const maximumSuccessfulTps = achieved.length ? Math.max(...achieved) : 0;
    stages.push({
      phones,
      tpsPerPhone: tps,
      meanSuccessfulTps: mean,
      minimumSuccessfulTps,
      maximumSuccessfulTps,
      variancePercent,
      cadenceClassification: {
        authoritativeSignal: "dispatch-start",
        observationalSignal: "provider-completion",
        meaningfulPercentThreshold: 0.5,
        completionCadenceAffectsPass: false,
      },
      pacingFlags: runs.filter((run) => run.passed).map((run) => {
        const dispatchStartBurstThenIdleObserved = run.perPhone.some((phone) =>
          phone.dispatchStartInterSendIntervals.burstCount > 0
          && phone.dispatchStartInterSendIntervals.idleGapCount > 0);
        const dispatchStartBurstThenIdleMeaningful = run.perPhone.some((phone) =>
          phone.dispatchStartInterSendIntervals.burstPercent > 0.5
          && phone.dispatchStartInterSendIntervals.idleGapPercent > 0.5);
        const providerCompletionBurstThenIdleObserved = run.perPhone.some((phone) =>
          phone.providerCompletionInterSendIntervals.burstCount > 0
          && phone.providerCompletionInterSendIntervals.idleGapCount > 0);
        return {
          repeat: run.repeat,
          dispatchStartBurstThenIdleObserved,
          dispatchStartBurstThenIdleMeaningful,
          providerCompletionBurstThenIdleObserved,
          providerCompletionCadenceObservationalOnly: true,
          stalled: run.maxConsecutiveStalledSamples > 0,
          maxConsecutiveStalledSamples: run.maxConsecutiveStalledSamples,
        };
      }),
      passed,
      runs,
    });
    if (phones === 1 && !passed) singleNumberCertified = false;
    if (!passed) {
      thisScaleCertified = false;
      break;
    }
  }
  previousScaleCertified = thisScaleCertified;
}

const summary = {
  schemaVersion: 3,
  studyId,
  createdAt: new Date().toISOString(),
  policy: {
    tpsStages,
    phoneStages,
    repeats,
    measurementSeconds,
    maximumVariancePercent,
    maximumP99Multiplier,
    workingTreeDirty,
    largeContactRunsBlockedUntilAllStagesPass: true,
  },
  singleNumberCertified,
  allConfiguredStagesPassed: stages.length === tpsStages.length * phoneStages.length && stages.every((stage) => stage.passed),
  stages,
};
const summaryPath = path.join(outputDir, "pacing-study-summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ summaryPath, singleNumberCertified, allConfiguredStagesPassed: summary.allConfiguredStagesPassed }, null, 2));
if (!summary.allConfiguredStagesPassed) process.exitCode = 1;