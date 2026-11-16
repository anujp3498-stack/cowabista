// Resource sampler for the kill benchmark (not a Gate B measured file). Once a second it appends one JSON line to
// resources.jsonl:
//   host:     CPU utilisation of the whole host (all cores, from /proc/stat) and load average
//   procs:    CPU (cores used since the last sample) and RSS of each named process: every cell (the node process,
//             all its worker threads included), the fake Graph server, redis-server and all PostgreSQL processes
//   redis:    instantaneous ops/s, connected clients, used memory, CPU (from INFO)
//   postgres: commits/s, rows written/s, blocks read/s for the benchmark database, and backends by state and by
//             wait event type (Lock waiters show contention) from pg_stat_activity
//   threads:  per cell, CPU of its main (event-loop) thread and of every other thread (shard workers, GC and libuv
//             helpers), largest first: tells a saturated event loop from busy shards. /proc counts on-CPU time only,
//             so a thread blocked in a futex wait (Atomics.wait) shows as idle here even when a profiler attributes
//             wall time to it.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const TICKS = 100; // USER_HZ on Linux
const readStat = (pid) => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const rssPages = Number(fields[21]);
    return { cpuTicks: Number(fields[11]) + Number(fields[12]), rssMb: Math.round((rssPages * 4096) / 1048576) };
  } catch {
    return null;
  }
};
const commOf = (pid) => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return ""; } };
const hostCpu = () => {
  const [line] = readFileSync("/proc/stat", "utf8").split("\n");
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = values[3] + (values[4] ?? 0);
  return { total: values.reduce((sum, value) => sum + value, 0), idle };
};

export function startResourceSampler({ file, namedPids, databaseUrl, databaseName, redisUrl }) {
  let previousHost = hostCpu();
  let previousAt = Date.now();
  const previousTicks = new Map();
  let previousDb = null;
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      const seconds = (now - previousAt) / 1000;
      previousAt = now;
      const host = hostCpu();
      const busy = 1 - (host.idle - previousHost.idle) / Math.max(1, host.total - previousHost.total);
      previousHost = host;
      const groups = new Map(); // name -> pids
      for (const [name, pid] of namedPids()) groups.set(name, [pid]);
      const postgres = [];
      const redis = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const comm = commOf(entry);
        if (comm === "postgres") postgres.push(Number(entry));
        else if (comm === "redis-server") redis.push(Number(entry));
      }
      groups.set("postgres", postgres);
      groups.set("redis", redis);
      const procs = {};
      for (const [name, pids] of groups) {
        let cores = 0;
        let rssMb = 0;
        for (const pid of pids) {
          const stat = readStat(pid);
          if (!stat) continue;
          const before = previousTicks.get(pid);
          previousTicks.set(pid, stat.cpuTicks);
          if (before !== undefined) cores += (stat.cpuTicks - before) / TICKS / seconds;
          rssMb += stat.rssMb;
        }
        procs[name] = { cores: Number(cores.toFixed(3)), rssMb, processes: pids.length };
      }
      const threads = {};
      for (const [name, pids] of groups) {
        if (!name.startsWith("cell-") || pids.length !== 1) continue;
        const pid = pids[0];
        let tids = [];
        try { tids = readdirSync(`/proc/${pid}/task`); } catch { continue; }
        const perThread = [];
        for (const tid of tids) {
          const stat = readStat(`${pid}/task/${tid}`);
          if (!stat) continue;
          const key = `${pid}/${tid}`;
          const before = previousTicks.get(key);
          previousTicks.set(key, stat.cpuTicks);
          if (before !== undefined) perThread.push({ main: tid === String(pid), cores: (stat.cpuTicks - before) / TICKS / seconds });
        }
        const main = perThread.find((thread) => thread.main)?.cores ?? null;
        const others = perThread.filter((thread) => !thread.main).map((thread) => Number(thread.cores.toFixed(3))).sort((a, b) => b - a);
        threads[name] = { main: main === null ? null : Number(main.toFixed(3)), others: others.slice(0, 16), count: perThread.length };
      }
      let redisInfo = null;
      try {
        const info = execFileSync("redis-cli", ["-u", redisUrl, "info"], { encoding: "utf8", timeout: 2_000 });
        const value = (key) => Number((new RegExp(`^${key}:(.*)$`, "m").exec(info) ?? [])[1]);
        redisInfo = {
          opsPerSec: value("instantaneous_ops_per_sec"), clients: value("connected_clients"),
          usedMemoryMb: Math.round(value("used_memory") / 1048576), cpuSeconds: value("used_cpu_sys") + value("used_cpu_user"),
        };
      } catch { /* sampler only */ }
      let postgresInfo = null;
      try {
        const row = execFileSync("psql", [databaseUrl, "-At", "-F", "|", "-c", `
          select (select xact_commit from pg_stat_database where datname = '${databaseName}'),
                 (select tup_inserted + tup_updated + tup_deleted from pg_stat_database where datname = '${databaseName}'),
                 (select blks_read from pg_stat_database where datname = '${databaseName}'),
                 (select count(*) from pg_stat_activity where datname = '${databaseName}' and state = 'active'),
                 (select count(*) from pg_stat_activity where datname = '${databaseName}'),
                 (select count(*) from pg_stat_activity where datname = '${databaseName}' and wait_event_type = 'Lock'),
                 (select count(*) from pg_stat_activity where datname = '${databaseName}' and wait_event_type = 'IO'),
                 (select count(*) from pg_stat_activity where datname = '${databaseName}' and wait_event_type = 'LWLock')`],
        { encoding: "utf8", timeout: 2_000 }).trim();
        const [commits, rowsWritten, blocksRead, active, backends, lockWaits, ioWaits, lwlockWaits] = row.split("|").map(Number);
        const current = { commits, rowsWritten, blocksRead };
        postgresInfo = { active, backends, lockWaits, ioWaits, lwlockWaits };
        if (previousDb) {
          postgresInfo.commitsPerSec = Math.round((commits - previousDb.commits) / seconds);
          postgresInfo.rowsWrittenPerSec = Math.round((rowsWritten - previousDb.rowsWritten) / seconds);
          postgresInfo.blocksReadPerSec = Math.round((blocksRead - previousDb.blocksRead) / seconds);
        }
        previousDb = current;
      } catch { /* sampler only */ }
      appendFileSync(file, `${JSON.stringify({
        t: now, host: { busy: Number(busy.toFixed(3)), load1: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) },
        procs, threads, redis: redisInfo, postgres: postgresInfo,
      })}\n`);
    } catch { /* sampler only */ }
  }, 1_000);
  return () => clearInterval(timer);
}
