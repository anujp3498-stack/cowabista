#!/usr/bin/env node
// Runs the API server's `test:*` scripts one at a time and summarises them, as the local regression does.
// The DB-backed suites share one disposable database, so they never run concurrently within a job.
//
//   SUITE_SHARD=2/4     run the 2nd of 4 deterministic shards (round-robin over the sorted script names)
//   SUITE_ONLY=<regex>  run only matching script names (local use)
//   SUITE_LOG_DIR=<dir> where each suite's full output goes (default ./suite-logs)
//   SUITE_TIMEOUT_MS    per-suite timeout (default 30 minutes)
//
// Exits non-zero if any suite exits non-zero or reports a failing test. Never retries: a failure is reported
// with the tail of its log, not hidden.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(path.join(root, "artifacts/api-server/package.json"), "utf8"));
const only = process.env.SUITE_ONLY ? new RegExp(process.env.SUITE_ONLY) : undefined;
const all = Object.keys(pkg.scripts).filter((name) => name.startsWith("test:") && (!only || only.test(name))).sort();

const [index, total] = (process.env.SUITE_SHARD ?? "1/1").split("/").map(Number);
if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
  console.error(`SUITE_SHARD must look like 2/4, got ${process.env.SUITE_SHARD}`);
  process.exit(2);
}
const suites = all.filter((_, position) => position % total === index - 1);
const logDir = path.resolve(process.env.SUITE_LOG_DIR ?? path.join(root, "suite-logs"));
const timeoutMs = Number(process.env.SUITE_TIMEOUT_MS ?? 30 * 60 * 1000);
mkdirSync(logDir, { recursive: true });

function run(name, logFile) {
  return new Promise((resolve) => {
    const out = createWriteStream(logFile);
    const child = spawn("pnpm", ["--filter", "@workspace/api-server", "run", name], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end(() => resolve({ code: code ?? (signal ? 128 : 1), timedOut }));
    });
  });
}

const sum = (text, label) => [...text.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))]
  .reduce((total, match) => total + Number(match[1]), 0);

console.log(`Shard ${index}/${total}: ${suites.length} of ${all.length} suites`);
const results = [];
for (const name of suites) {
  const logFile = path.join(logDir, `${name.replace(/[^a-z0-9.-]/gi, "_")}.log`);
  const started = Date.now();
  const { code, timedOut } = await run(name, logFile);
  const text = readFileSync(logFile, "utf8");
  const result = {
    name,
    code,
    timedOut,
    pass: sum(text, "pass"),
    fail: sum(text, "fail"),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  results.push(result);
  const ok = code === 0 && result.fail === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(40)} rc=${String(code).padEnd(3)} pass=${String(result.pass).padEnd(4)} fail=${String(result.fail).padEnd(3)} ${result.seconds}s${timedOut ? " (timed out)" : ""}`);
  if (!ok) {
    console.log(`----- last 120 lines of ${name} -----`);
    console.log(text.split("\n").slice(-120).join("\n"));
    console.log(`----- end of ${name} -----`);
  }
}

const failed = results.filter((result) => result.code !== 0 || result.fail > 0);
const totals = results.reduce((acc, r) => ({ pass: acc.pass + r.pass, fail: acc.fail + r.fail }), { pass: 0, fail: 0 });
console.log(`Shard ${index}/${total}: ${results.length} suites, ${totals.pass} tests passed, ${totals.fail} failed, ${failed.length} suite(s) failing`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.code === 0 && r.fail === 0 ? "✅" : "❌"} | \`${r.name}\` | ${r.code} | ${r.pass} | ${r.fail} | ${r.seconds}s |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### API suites, shard ${index}/${total}`,
    "",
    `${results.length} suites, ${totals.pass} passed, ${totals.fail} failed`,
    "",
    "| | Suite | Exit | Pass | Fail | Time |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"));
}
process.exit(failed.length ? 1 : 0);
