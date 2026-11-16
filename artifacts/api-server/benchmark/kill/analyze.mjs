// Analysis for the kill benchmark. Joins the database's job outcomes with the fake Graph server's log (what really
// reached the provider) and computes: the classification of every job, duplicates, the per-phone rate cap, takeover,
// throughput before and after the kill, recovery time and pacing lateness. Usable on its own:
//   node benchmark/kill/analyze.mjs <results-dir>   (needs identity.json, seed.json, jobs.csv, graph.ndjson)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PATH_A = /delivery is unknown after broker consumer loss/i;
const PATH_B = /manual reconciliation is required/i;
const TIMEOUT = /timed out after/i;
const CONNECTION = /connection to whatsapp failed/i;
const UNKNOWN = /unknown|manual reconciliation|timed out after|connection to whatsapp failed/i;

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1) ?? null };
}
/** Spreading 300K values into Math.min/max overflows the stack: scan instead. */
function minOf(values, fallback = null) { let result = Infinity; for (const value of values) if (value < result) result = value; return Number.isFinite(result) ? result : fallback; }
function maxOf(values, fallback = null) { let result = -Infinity; for (const value of values) if (value > result) result = value; return Number.isFinite(result) ? result : fallback; }
function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function analyze(dir, context) {
  const seed = context.seed ?? JSON.parse(readFileSync(path.join(dir, "seed.json"), "utf8"));
  const config = context.config;
  const kill = context.kill ?? null;
  const tps = seed.tps;
  const phoneOfProvider = new Map(seed.phones.map((phone) => [phone.providerPhoneId, phone.index]));

  // Ground truth: every request whose whole body reached the fake provider.
  const graph = readJsonLines(path.join(dir, "graph.ndjson"));
  const reached = graph.filter((entry) => entry.outcome === "responded" || entry.outcome === "client-gone");
  const partialBodies = graph.filter((entry) => entry.outcome === "partial-body").length;
  const byRecipient = new Map();
  for (const entry of reached) {
    const list = byRecipient.get(entry.to) ?? [];
    list.push(entry);
    byRecipient.set(entry.to, list);
  }
  const duplicates = [...byRecipient.entries()].filter(([, list]) => list.length > 1);

  // Jobs: id, route, status, attempts, error, scheduledSendAt, recipient, intent status, wamid.
  // One job per record. Exports before the newline-safe query could split an error reason over several lines: a
  // record starts with id,route,status,attempts and continuation lines are joined back to it.
  const records = [];
  for (const line of readFileSync(path.join(dir, "jobs.csv"), "utf8").split("\n")) {
    if (/^\d+,\d+,[A-Za-z]+,\d+,/.test(line)) records.push(line);
    else if (line && records.length) records[records.length - 1] += ` ${line.trim()}`;
  }
  const jobs = records.map((line) => {
    const [id, routeId, status, attempts, error, scheduledMs, recipient, intent, wamid] = line.split(",");
    return { id: Number(id), routeId: Number(routeId), status, attempts: Number(attempts), error, scheduledMs: scheduledMs ? Number(scheduledMs) : null, recipient, intent, wamid };
  });
  const held = new Set(kill && existsSync(path.join(dir, "held.json")) ? JSON.parse(readFileSync(path.join(dir, "held.json"), "utf8")).jobs.map((job) => job.id) : []);

  const classes = {
    sentReachedOnce: 0, sentNotReached: 0, sentWamidMismatch: 0,
    unknownReached: 0, unknownNotReached: 0,
    unknownByPath: { pathA: 0, pathB: 0, timeout: 0, connection: 0, other: 0 },
    unknownNotReachedByPath: { pathA: 0, pathB: 0, timeout: 0, connection: 0, other: 0 },
    otherFailed: {}, open: 0, sentAfterRequeue: 0,
  };
  const heldOutcome = { total: held.size, sent: 0, sentAfterRequeue: 0, unknownReached: 0, unknownNotReached: 0, otherFailed: 0, open: 0 };
  let unknownNotHeld = 0;
  const lateness = [];
  for (const job of jobs) {
    const arrivals = byRecipient.get(job.recipient) ?? [];
    const isHeld = held.has(job.id);
    if (job.status === "Sent") {
      if (arrivals.length === 0) classes.sentNotReached += 1;
      else classes.sentReachedOnce += arrivals.length === 1 ? 1 : 0;
      if (arrivals.length && job.wamid && !arrivals.some((entry) => job.wamid.endsWith(`.${entry.seq}`))) classes.sentWamidMismatch += 1;
      if (job.attempts > 1) classes.sentAfterRequeue += 1;
      if (isHeld) { heldOutcome.sent += 1; if (job.attempts > 1) heldOutcome.sentAfterRequeue += 1; }
      if (arrivals.length && job.scheduledMs) lateness.push(arrivals[0].tArrive - job.scheduledMs);
    } else if (job.status === "Failed" && UNKNOWN.test(job.error)) {
      const key = PATH_A.test(job.error) ? "pathA" : PATH_B.test(job.error) ? "pathB" : TIMEOUT.test(job.error) ? "timeout" : CONNECTION.test(job.error) ? "connection" : "other";
      classes.unknownByPath[key] += 1;
      if (arrivals.length) classes.unknownReached += 1;
      else { classes.unknownNotReached += 1; classes.unknownNotReachedByPath[key] += 1; }
      if (isHeld) { if (arrivals.length) heldOutcome.unknownReached += 1; else heldOutcome.unknownNotReached += 1; }
      else unknownNotHeld += 1;
    } else if (job.status === "Failed") {
      classes.otherFailed[job.error] = (classes.otherFailed[job.error] ?? 0) + 1;
      if (isHeld) heldOutcome.otherFailed += 1;
    } else {
      classes.open += 1;
      if (isHeld) heldOutcome.open += 1;
    }
  }
  const unknownTotal = classes.unknownReached + classes.unknownNotReached;

  // Per-phone rolling one-second maximum of arrivals (all senders together): Meta's per-number limit.
  const arrivalsByPhone = new Map();
  for (const entry of reached) {
    const index = phoneOfProvider.get(entry.phone);
    if (index === undefined) continue;
    const list = arrivalsByPhone.get(index) ?? [];
    list.push(entry.tArrive);
    arrivalsByPhone.set(index, list);
  }
  // A sender's first connections are slower to set up, so its first requests can arrive closer together than they
  // started. Reported both over the whole run and after each sender's first 2 s (connection warm-up).
  const warmupEnd = new Map();
  for (const entry of reached) {
    const first = warmupEnd.get(entry.prefix);
    if (first === undefined || entry.tArrive + 2000 < first) warmupEnd.set(entry.prefix, entry.tArrive + 2000);
  }
  const peakOf = (list) => {
    list.sort((a, b) => a - b);
    let start = 0;
    let peak = 0;
    for (let end = 0; end < list.length; end += 1) {
      while (list[end] - list[start] >= 1000) start += 1;
      peak = Math.max(peak, end - start + 1);
    }
    return peak;
  };
  const rateCap = {};
  const rateCapAfterWarmup = {};
  for (const [index, list] of arrivalsByPhone) rateCap[index] = peakOf([...list]);
  const steadyArrivals = new Map();
  for (const entry of reached) {
    const index = phoneOfProvider.get(entry.phone);
    if (index === undefined || entry.tArrive < warmupEnd.get(entry.prefix)) continue;
    const list = steadyArrivals.get(index) ?? [];
    list.push(entry.tArrive);
    steadyArrivals.set(index, list);
  }
  for (const [index, list] of steadyArrivals) rateCapAfterWarmup[index] = peakOf(list);
  // The shard holds the limit on its own start clock (campaign-shard-pacing.ts rolling guard); arrival times add a
  // few milliseconds of transmission jitter, which can put one extra request into a window edge. The check allows
  // exactly that one request; the raw peaks are reported as measured.
  const rateCapExceeded = Object.values(rateCapAfterWarmup).some((peak) => peak > tps + 1);
  const rateCapExceededIncludingWarmup = Object.values(rateCap).some((peak) => peak > tps + 1);

  // Throughput per second on the fake provider's clock.
  const firstArrival = minOf(reached.map((entry) => entry.tArrive), 0);
  const perSecond = new Map();
  for (const entry of reached) {
    const second = Math.floor((entry.tArrive - firstArrival) / 1000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  }
  const seconds = [...perSecond.keys()].sort((a, b) => a - b);
  const series = seconds.map((second) => ({ second, sent: perSecond.get(second) }));
  const meanOver = (from, to) => {
    let total = 0;
    let count = 0;
    for (let second = from; second < to; second += 1) { total += perSecond.get(second) ?? 0; count += 1; }
    return count ? total / count : 0;
  };
  const throughput = { targetTps: tps * seed.phones.length };
  let failover = null;
  if (kill) {
    const killSecond = Math.floor((kill.killedAt - firstArrival) / 1000);
    const before = meanOver(Math.max(0, killSecond - 10), killSecond);
    throughput.preKillTps = Math.round(before);
    // Recovery: first second after the kill from which 3 consecutive seconds reach 95 % of the pre-kill rate.
    let recoveredSecond = null;
    for (let second = killSecond + 1; second <= (seconds.at(-1) ?? killSecond); second += 1) {
      if ([0, 1, 2].every((offset) => (perSecond.get(second + offset) ?? 0) >= 0.95 * before)) { recoveredSecond = second; break; }
    }
    const lostSends = Math.round([...Array(Math.max(0, (recoveredSecond ?? killSecond) - killSecond)).keys()]
      .reduce((sum, offset) => sum + Math.max(0, before - (perSecond.get(killSecond + offset) ?? 0)), 0));
    // Takeover per phone the victim was sending: first arrival from any other sender after the kill.
    const victimPhones = [...new Set(reached.filter((entry) => entry.prefix === kill.prefix && entry.tArrive >= kill.killedAt - 2000).map((entry) => entry.phone))];
    const takeover = {};
    for (const phone of victimPhones) {
      const lastVictim = maxOf(reached.filter((entry) => entry.prefix === kill.prefix && entry.phone === phone).map((entry) => entry.tArrive), kill.killedAt);
      const next = reached.filter((entry) => entry.phone === phone && entry.prefix !== kill.prefix && entry.tArrive > kill.killedAt).reduce((min, entry) => Math.min(min, entry.tArrive), Infinity);
      takeover[phoneOfProvider.get(phone)] = {
        lastVictimArrivalAfterKillMs: lastVictim - kill.killedAt,
        firstSuccessorArrivalMs: Number.isFinite(next) ? next - kill.killedAt : null,
        successor: Number.isFinite(next) ? reached.find((entry) => entry.phone === phone && entry.tArrive === next)?.prefix ?? null : null,
      };
    }
    failover = {
      victim: kill.prefix, heldAtKill: kill.heldAtKill, heldReadMs: kill.heldReadMs, restartedAfterMs: kill.restartedAt ? kill.restartedAt - kill.killedAt : null,
      recoveryTo95PercentMs: recoveredSecond === null ? null : Math.max(0, (recoveredSecond - killSecond) * 1000 - ((kill.killedAt - firstArrival) % 1000)),
      sendsBelowPreKillRate: lostSends, takeover,
    };
  } else {
    const last = seconds.at(-1) ?? 0;
    throughput.steadyTps = Math.round(meanOver(Math.min(10, last), Math.max(Math.min(10, last), last - 5)));
  }

  // Accepted by the provider (it answered 200 with a message id): the throughput a campaign actually gets, on the
  // provider's clock. Sustained = the per-second accepted rate between 5 % and 95 % of the run's accepted requests
  // (no ramp-up, no tail; a kill's dip stays in). Per phone likewise.
  const accepted = reached.filter((entry) => entry.outcome === "responded" && entry.tResponded).map((entry) => ({ ...entry, t: entry.tResponded }))
    .sort((a, b) => a.t - b.t);
  const sustained = (list) => {
    if (list.length < 20) return null;
    const from = list[Math.floor(list.length * 0.05)].t;
    const to = list[Math.floor(list.length * 0.95)].t;
    const bySecond = new Map();
    for (const entry of list) {
      if (entry.t < from || entry.t >= to) continue;
      const second = Math.floor((entry.t - from) / 1000);
      bySecond.set(second, (bySecond.get(second) ?? 0) + 1);
    }
    const spanSeconds = Math.max(1, Math.floor((to - from) / 1000));
    const counts = [...Array(spanSeconds).keys()].map((second) => bySecond.get(second) ?? 0).sort((a, b) => a - b);
    const inWindow = counts.reduce((sum, count) => sum + count, 0);
    return {
      windowSeconds: spanSeconds,
      meanTps: Math.round(inWindow / spanSeconds),
      p50Tps: percentile(counts, 0.5), p10Tps: percentile(counts, 0.1), minTps: counts[0] ?? 0, maxTps: counts.at(-1) ?? 0,
    };
  };
  const acceptedSpanMs = accepted.length > 1 ? accepted.at(-1).t - accepted[0].t : 0;
  throughput.accepted = {
    total: accepted.length,
    wallClockTps: acceptedSpanMs ? Math.round(accepted.length / (acceptedSpanMs / 1000)) : null,
    firstToLastSeconds: Math.round(acceptedSpanMs / 100) / 10,
    sustained: sustained(accepted),
    perPhone: Object.fromEntries([...new Set(accepted.map((entry) => entry.phone))].sort()
      .map((phone) => [phoneOfProvider.get(phone), sustained(accepted.filter((entry) => entry.phone === phone))?.meanTps ?? null])),
  };

  // Latency from the cells' per-job timings (cell.ts, KILL_BENCH_TIMINGS; absent in runs made before it existed):
  //   claim, prepare     per batch: the claim query, and preparation (template resolution, intents, validation)
  //   preparation        per job: claim start to its batch prepared
  //   provider (HTTP)    per job: the shard's HTTP call to the provider, worker clock
  //   end-to-end         per job: claim start to the provider's acceptance seen by the cell (includes the pacing
  //                      schedule: claims run up to 3 s ahead of each job's send slot by design)
  //   admission          per job: handed to transport to accepted (paced wait in the shard plus the call)
  const timingFiles = readdirSync(dir).filter((name) => name.endsWith(".timings.csv")).sort();
  const claimMs = [];
  const prepareMs = [];
  const preparationMs = [];
  const httpMs = [];
  const endToEndMs = [];
  const admissionMs = [];
  for (const name of timingFiles) {
    for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
      const f = line.split(",");
      if (f[0] === "C" && f.length >= 4) claimMs.push(Number(f[2]) - Number(f[1]));
      else if (f[0] === "P" && f.length >= 5) prepareMs.push(Number(f[2]) - Number(f[1]));
      else if (f[0] === "J" && f.length >= 7) {
        const [claimStart, prepared, dispatched, http, accepted] = f.slice(2).map((v) => (v === "" ? NaN : Number(v)));
        if (Number.isFinite(claimStart) && Number.isFinite(prepared)) preparationMs.push(prepared - claimStart);
        if (Number.isFinite(http)) httpMs.push(http);
        if (Number.isFinite(claimStart) && Number.isFinite(accepted)) endToEndMs.push(accepted - claimStart);
        if (Number.isFinite(dispatched) && Number.isFinite(accepted)) admissionMs.push(accepted - dispatched);
      }
    }
  }
  const latency = timingFiles.length ? {
    claimBatchMs: stats(claimMs), prepareBatchMs: stats(prepareMs), preparationMs: stats(preparationMs),
    providerHttpMs: stats(httpMs), endToEndMs: stats(endToEndMs), admissionToAcceptMs: stats(admissionMs),
  } : null;

  // Resources (resources.jsonl from resources.mjs; absent in older runs).
  const resourceSamples = existsSync(path.join(dir, "resources.jsonl")) ? readJsonLines(path.join(dir, "resources.jsonl")) : [];
  const summarizeSeries = (values) => {
    const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!list.length) return null;
    return { mean: Number((list.reduce((sum, v) => sum + v, 0) / list.length).toFixed(3)), p95: percentile(list, 0.95), max: list.at(-1) };
  };
  let resources = null;
  if (resourceSamples.length) {
    const names = [...new Set(resourceSamples.flatMap((sample) => Object.keys(sample.procs ?? {})))].sort();
    const cellCores = resourceSamples.map((sample) => Object.entries(sample.procs ?? {}).filter(([n]) => n.startsWith("cell-")).reduce((sum, [, p]) => sum + p.cores, 0));
    resources = {
      samples: resourceSamples.length,
      hostBusy: summarizeSeries(resourceSamples.map((sample) => sample.host?.busy)),
      cores: Object.fromEntries(names.map((name) => [name, summarizeSeries(resourceSamples.map((sample) => sample.procs?.[name]?.cores))])),
      cellsCoresTotal: summarizeSeries(cellCores),
      rssMb: Object.fromEntries(names.map((name) => [name, summarizeSeries(resourceSamples.map((sample) => sample.procs?.[name]?.rssMb))?.max ?? null])),
      redisOpsPerSec: summarizeSeries(resourceSamples.map((sample) => sample.redis?.opsPerSec)),
      redisMemoryMb: summarizeSeries(resourceSamples.map((sample) => sample.redis?.usedMemoryMb))?.max ?? null,
      postgresCommitsPerSec: summarizeSeries(resourceSamples.map((sample) => sample.postgres?.commitsPerSec)),
      postgresRowsWrittenPerSec: summarizeSeries(resourceSamples.map((sample) => sample.postgres?.rowsWrittenPerSec)),
      postgresActiveBackends: summarizeSeries(resourceSamples.map((sample) => sample.postgres?.active)),
      postgresLockWaiters: summarizeSeries(resourceSamples.map((sample) => sample.postgres?.lockWaits)),
      postgresLwlockWaiters: summarizeSeries(resourceSamples.map((sample) => sample.postgres?.lwlockWaits)),
    };
  }
  const statementsFile = path.join(dir, "pg-statements.psv");
  const topStatements = existsSync(statementsFile)
    ? readFileSync(statementsFile, "utf8").split("\n").filter(Boolean).slice(0, 10).map((line) => {
      const [totalMs, calls, meanMs, rows, ...query] = line.split("|");
      return { totalMs: Number(totalMs), calls: Number(calls), meanMs: Number(meanMs), rows: Number(rows), query: query.join("|").slice(0, 160) };
    })
    : null;

  // Fake provider's own latency and health.
  const responseMs = stats(reached.filter((entry) => entry.tResponded).map((entry) => entry.tResponded - entry.tBodyEnd));
  const graphStats = readJsonLines(path.join(dir, "graph-stats.jsonl"));
  const fakeGraph = { responseMs, eventLoopP99MaxMs: maxOf(graphStats.map((sample) => sample.eventLoopP99Ms), 0), partialBodies };
  const cellFiles = readdirSync(dir).filter((name) => name.endsWith(".metrics.jsonl")).sort();
  const cells = cellFiles.map((name) => {
    const samples = readJsonLines(path.join(dir, name));
    const last = samples.at(-1);
    return {
      cell: name.replace(/\.metrics\.jsonl$/, ""), samples: samples.length,
      eventLoopP99MaxMs: maxOf(samples.map((sample) => sample.eventLoopP99Ms), 0), rssMaxMb: maxOf(samples.map((sample) => sample.rssMb), 0),
      dispatch: last?.dispatch ?? null,
    };
  });

  const result = {
    identity: context.identity ?? null, config, warmed: context.warmed ?? null, settled: context.settled ?? null,
    jobs: jobs.length, reachedRequests: reached.length, distinctRecipientsReached: byRecipient.size,
    duplicates: duplicates.length, duplicateExamples: duplicates.slice(0, 5).map(([to, list]) => ({ to, prefixes: list.map((entry) => entry.prefix) })),
    classes, unknownTotal, unknownNotHeld, heldOutcome,
    rateCap, rateCapAfterWarmup, rateCapExceeded, rateCapExceededIncludingWarmup, throughput, failover, pacingLatenessMs: stats(lateness), fakeGraph, cells,
    latency, resources, topStatements,
    // The approved per-phone ceiling with no allowance at all (the provider-clock check below allows one request of
    // arrival jitter): reported, so a breach of the raw ceiling is visible even when it is within jitter.
    rateCapStrictHeld: Object.values(rateCap).every((peak) => peak <= tps),
    series,
  };
  result.checks = {
    noDuplicates: duplicates.length === 0,
    noPhantomSends: classes.sentNotReached === 0,
    wamidsMatch: classes.sentWamidMismatch === 0,
    rateCapHeldAfterConnectionWarmup: !rateCapExceeded,
    allSettled: classes.open === 0,
    noUnknownWithoutCrash: kill ? unknownNotHeld === 0 : unknownTotal === 0,
    noOtherFailures: Object.keys(classes.otherFailed).length === 0,
    noUnexpectedCellExit: !(context.unexpectedExits ?? []).length,
  };
  result.unexpectedExits = context.unexpectedExits ?? [];
  result.summary = summarize(result);
  return result;
}

function summarize(result) {
  const c = result.classes;
  const lines = [];
  lines.push(`# Kill benchmark: ${result.config.label}`, "");
  if (result.identity) lines.push(`- Source: \`${result.identity.commit.slice(0, 12)}\` dirty=${result.identity.dirtyFiles}, ${result.identity.measuredFilesSha256}`);
  lines.push(`- Mode ${result.config.mode}, ${result.config.cells} cell(s), ${result.config.phones} phones x ${result.config.tps} TPS, fake provider latency ${result.config.latencyMs} ms, shards ${result.config.shards}`);
  lines.push(`- Warm-up reached: ${result.warmed}; all jobs settled: ${result.settled}`);
  lines.push("", "## Checks");
  for (const [name, ok] of Object.entries(result.checks)) lines.push(`- ${ok ? "PASS" : "FAIL"} ${name}`);
  lines.push("", "## Accounting (ground truth = the fake provider's log)");
  lines.push(`- jobs ${result.jobs}; requests that reached the provider ${result.reachedRequests}; distinct recipients ${result.distinctRecipientsReached}; duplicates ${result.duplicates}`);
  lines.push(`- Sent and reached once ${c.sentReachedOnce}; Sent but never reached ${c.sentNotReached}; sent after a requeue ${c.sentAfterRequeue}`);
  lines.push(`- delivery-unknown ${result.unknownTotal}: reached the provider ${c.unknownReached}, never reached it ${c.unknownNotReached} (avoidable)`);
  lines.push(`  - by path: ${JSON.stringify(c.unknownByPath)}; never reached, by path: ${JSON.stringify(c.unknownNotReachedByPath)}`);
  lines.push(`- other failures ${JSON.stringify(c.otherFailed)}; still open ${c.open}; delivery-unknown not held by the killed cell ${result.unknownNotHeld}`);
  if (result.failover) {
    const f = result.failover;
    const h = result.heldOutcome;
    lines.push("", "## Failover");
    lines.push(`- victim ${f.victim}: held ${f.heldAtKill} jobs at the kill (read ${f.heldReadMs} ms after it); restarted after ${f.restartedAfterMs ?? "-"} ms`);
    lines.push(`- held jobs ended: Sent ${h.sent} (after requeue ${h.sentAfterRequeue}), delivery-unknown reached ${h.unknownReached}, delivery-unknown never reached ${h.unknownNotReached}, other failed ${h.otherFailed}, open ${h.open}`);
    lines.push(`- throughput before the kill ${result.throughput.preKillTps}/s of ${result.throughput.targetTps}; back to 95 % after ${f.recoveryTo95PercentMs ?? "never"} ms; sends below the pre-kill rate meanwhile ${f.sendsBelowPreKillRate}`);
    for (const [phone, t] of Object.entries(f.takeover)) lines.push(`- phone ${phone}: victim's last arrival ${t.lastVictimArrivalAfterKillMs} ms after the kill; first successor arrival ${t.firstSuccessorArrivalMs ?? "none"} ms (${t.successor ?? "-"})`);
  } else {
    lines.push("", "## Throughput", `- steady ${result.throughput.steadyTps}/s of ${result.throughput.targetTps}`);
  }
  const a = result.throughput.accepted;
  if (a) {
    lines.push("", "## Accepted throughput (provider answered 200; its clock)");
    lines.push(`- accepted ${a.total} over ${a.firstToLastSeconds} s: wall-clock ${a.wallClockTps}/s; sustained (5-95 % of the run) mean ${a.sustained?.meanTps}/s, p50 ${a.sustained?.p50Tps}/s, p10 ${a.sustained?.p10Tps}/s, min ${a.sustained?.minTps}/s over ${a.sustained?.windowSeconds} s; per phone mean ${JSON.stringify(a.perPhone)} (target ${result.throughput.targetTps}/s)`);
  }
  if (result.latency) {
    const l = result.latency;
    const fmt = (s) => s ? `p50 ${s.p50} / p95 ${s.p95} / p99 ${s.p99} / max ${s.max} (n=${s.samples})` : "-";
    lines.push("", "## Latency (cells' per-job timings, ms)");
    lines.push(`- claim batch: ${fmt(l.claimBatchMs)}; prepare batch: ${fmt(l.prepareBatchMs)}`);
    lines.push(`- preparation (claim start to prepared): ${fmt(l.preparationMs)}`);
    lines.push(`- provider HTTP call: ${fmt(l.providerHttpMs)}`);
    lines.push(`- end-to-end (claim start to accepted; includes the up-to-3 s pacing schedule): ${fmt(l.endToEndMs)}`);
    lines.push(`- admission to accepted (paced wait in the shard plus the call): ${fmt(l.admissionToAcceptMs)}`);
  }
  if (result.resources) {
    const r = result.resources;
    lines.push("", "## Resources (1 s samples)");
    lines.push(`- host CPU busy: ${JSON.stringify(r.hostBusy)} (fraction of all cores)`);
    lines.push(`- cores by process: ${JSON.stringify(r.cores)}; all cells together ${JSON.stringify(r.cellsCoresTotal)}`);
    lines.push(`- RSS max MB: ${JSON.stringify(r.rssMb)}`);
    lines.push(`- Redis ops/s ${JSON.stringify(r.redisOpsPerSec)}, memory max ${r.redisMemoryMb} MB`);
    lines.push(`- PostgreSQL commits/s ${JSON.stringify(r.postgresCommitsPerSec)}, rows written/s ${JSON.stringify(r.postgresRowsWrittenPerSec)}, active backends ${JSON.stringify(r.postgresActiveBackends)}, lock waiters ${JSON.stringify(r.postgresLockWaiters)}, LWLock waiters ${JSON.stringify(r.postgresLwlockWaiters)}`);
  }
  if (result.topStatements?.length) {
    lines.push("", "## Heaviest PostgreSQL statements (pg_stat_statements)");
    for (const statement of result.topStatements.slice(0, 6)) lines.push(`- ${statement.totalMs} ms total, ${statement.calls} calls, ${statement.meanMs} ms mean: ${statement.query}`);
  }
  lines.push("", "## Rate and latency");
  lines.push(`- strict approved ceiling (no jitter allowance) held on the provider's clock: ${result.rateCapStrictHeld}`);
  lines.push(`- per-phone peak arrivals in any rolling second, whole run: ${JSON.stringify(result.rateCap)}; after each sender's first 2 s: ${JSON.stringify(result.rateCapAfterWarmup)} (limit ${result.config.tps}; the check allows one request of arrival jitter)`);
  lines.push(`- pacing lateness (arrival minus scheduled slot) ms: ${JSON.stringify(result.pacingLatenessMs)}`);
  lines.push(`- fake provider response ms: ${JSON.stringify(result.fakeGraph.responseMs)}; its event-loop p99 max ${result.fakeGraph.eventLoopP99MaxMs} ms; partial bodies ${result.fakeGraph.partialBodies}`);
  for (const cell of result.cells) lines.push(`- ${cell.cell}: event-loop p99 max ${cell.eventLoopP99MaxMs} ms, RSS max ${cell.rssMaxMb} MB, ownership denials ${cell.dispatch?.ownershipDenials ?? "-"}, settlement backpressure ${cell.dispatch?.settlementBackpressureEvents ?? "-"}`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? ".");
  const identity = JSON.parse(readFileSync(path.join(dir, "identity.json"), "utf8"));
  const kill = existsSync(path.join(dir, "held.json")) ? JSON.parse(readFileSync(path.join(dir, "held.json"), "utf8")) : null;
  // Re-analysis of a finished run keeps what only the run itself observed (warm-up, settling, cell exits) and writes
  // beside the run's own result: result.reanalysis.json and summary.reanalysis.md.
  const prior = existsSync(path.join(dir, "result.json")) ? JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) : {};
  const result = analyze(dir, { config: identity.config, identity, kill, warmed: prior.warmed, settled: prior.settled, unexpectedExits: prior.unexpectedExits });
  if (process.argv.includes("--write")) {
    writeFileSync(path.join(dir, "result.reanalysis.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(path.join(dir, "summary.reanalysis.md"), result.summary);
  }
  console.log(result.summary);
}
