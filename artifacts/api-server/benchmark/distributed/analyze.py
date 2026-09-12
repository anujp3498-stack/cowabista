#!/usr/bin/env python3
"""Analyze a distributed benchmark experiment: per-cell metrics, true concurrent aggregate, scaling efficiency,
and delta-based PostgreSQL/Redis cost per message with a scaling classification.

usage: analyze.py <experiment dir> [--control <control experiment dir>]
  <experiment dir> holds cell-*/harness.json (+ cell-*/host.jsonl), and optionally progress.csv, pg.csv, redis.csv
  written by the samplers. Efficiency = concurrent aggregate / (N x control single-cell TPS).
"""
import argparse, csv, glob, json, os, statistics as st, collections

def pct(xs, q):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else float("nan")

def load_cells(d):
    cells = []
    for h in sorted(glob.glob(os.path.join(d, "cell-*", "harness.json"))):
        j = json.load(open(h)); w = j.get("workload"); dm = w["dispatchMetrics"] if w else None
        cells.append(dict(dir=os.path.dirname(h), status=j.get("status"), phase=j.get("phase"), w=w, dm=dm, recovery=j.get("recoveryAssertions")))
    return cells

def cell_summary(c):
    w, dm = c["w"], c["dm"]
    if not w: return f"  {os.path.basename(c['dir'])}: {c['status']} at phase {c['phase']} ({(json.load(open(os.path.join(c['dir'],'harness.json'))).get('failure') or {}).get('message','')[:120]})"
    pp = w["perPhonePacing"]
    lanes = w.get("phoneLaneMetrics", [])
    return (f"  {os.path.basename(c['dir'])} [{c['status']}]: provider-start TPS {w['providerStartTps']:.0f} steady {w['steadySuccessfulTps']:.0f} routes {[round(r['steadySuccessfulTps']) for r in w['sendsByRoute']]} "
            f"| owned {sorted(int(k) for k in dm['phoneOwnership'])} denials {dm.get('ownershipDenials')} ownership lat mean {dm['ownershipCoordinationLatencyMs']/max(1,dm['ownershipCoordinationSamples']):.1f} max {dm['ownershipCoordinationLatencyMaxMs']:.0f} ms "
            f"| interval mean {[p['attemptedInterSendIntervals']['meanMs'] for p in pp]} p99 {[p['attemptedInterSendIntervals']['p99Ms'] for p in pp]} peak1s {[p['attemptedPeakInRollingSecond'] for p in pp]} ceilingOK {all(p['attemptedCeilingSatisfied'] for p in pp)} "
            f"| shard lateness mean {1000*dm['shardEventLoopDelayMs']/max(1,dm['shardStarts']):.0f} us mainEL p95/p99 {w['eventLoopDelayMs']['p95']}/{w['eventLoopDelayMs']['p99']} "
            f"| slots peak {dm['settlementPeakPending']} refusals {dm['settlementBackpressureEvents']} starvation {dm['reservoirStarvationMs']}ms/{dm['reservoirStarvationEvents']} reclaims {dm['brokerRecovered']} "
            f"| settlement p50/p95 {w['phaseTimings']['success_settlement']['p50Ms']}/{w['phaseTimings']['success_settlement']['p95Ms']} ms, {1000*dm['settlementDrainedJobs']/max(1,dm['settlementDrainDurationMs']):.0f} jobs/s busy | supply {w['successfulClaimsPerSecond']:.0f}/s claim p95 {w['claimLatencyMsP95']} "
            f"| sent {w['successfulSends']} attempts {w['sendAttempts']} | recovery {c['recovery']}")

def host_cpu(path, lo=None, hi=None):
    recs = [json.loads(l) for l in open(path) if l.strip()]
    dl = []
    for a, b in zip(recs, recs[1:]):
        dt = (b["t"] - a["t"]) / 1000
        if dt <= 0: continue
        th = {}
        for tid, v in b["threads"].items():
            if tid in a["threads"]: th[tid] = ((v[0] - a["threads"][tid][0]) / 1e9 / dt, (v[1] - a["threads"][tid][1]) / 1e9 / dt)
        dl.append(dict(t=b["t"], node=(b["node"] - a["node"]) / dt / 100, pg=(b["postgres"] - a["postgres"]) / dt / 100, redis=(b["redis"] - a["redis"]) / dt / 100, running=b.get("running", 0), th=th))
    if lo is None:
        tot = collections.defaultdict(float)
        for x in dl:
            for tid, (r, w) in x["th"].items(): tot[tid] += r
        main = max(tot, key=tot.get) if tot else None
        act = [x for x in dl if main and x["th"].get(main, (0, 0))[0] > 0.5]
        if len(act) < 10: return None
        lo, hi = act[int(.2 * len(act))]["t"], act[int(.8 * len(act))]["t"]
    w = [x for x in dl if lo <= x["t"] <= hi]
    if not w: return None
    tot = collections.defaultdict(lambda: [0.0, 0.0])
    for x in w:
        for tid, (r, q) in x["th"].items(): tot[tid][0] += r; tot[tid][1] += q
    order = sorted(tot.items(), key=lambda kv: -kv[1][0]); main = order[0][0] if order else None
    cands = [tid for tid, v in order[1:] if v[0] > 0.01 * len(w)]
    shards = sorted(cands, key=lambda tid: -tot[tid][1])[:4]
    n = len(w)
    return dict(lo=lo, hi=hi, node=st.mean(x["node"] for x in w), pg=st.mean(x["pg"] for x in w), redis=st.mean(x["redis"] for x in w), running=st.median(x["running"] for x in w),
                main_util=tot[main][0] / n if main else 0, main_wait=tot[main][1] / n if main else 0, shard_util=[tot[t][0] / n for t in shards], shard_wait=[tot[t][1] / n for t in shards])

def concurrent_aggregate(progress_csv, min_rate=500):
    rows = [r for r in csv.DictReader(open(progress_csv)) if r.get("sent")]
    by = collections.defaultdict(list)
    for r in rows: by[int(r["campaign_id"])].append((int(r["epoch_ms"]), int(r["sent"])))
    rates = {}
    for c, pts in by.items():
        pts.sort(); rates[c] = {}
        for (t0, s0), (t1, s1) in zip(pts, pts[1:]):
            dt = (t1 - t0) / 1000
            if dt > 0: rates[c][t1 // 1000] = (s1 - s0) / dt
    camps = sorted(rates); secs = sorted(set().union(*[set(v) for v in rates.values()])) if rates else []
    both = [s for s in secs if all(rates[c].get(s, 0) > min_rate for c in camps)]
    if len(both) < 10: return None
    core = both[3:-3]
    agg = [sum(rates[c][s] for c in camps) for s in core]
    return dict(seconds=len(core), lo=core[0] * 1000, hi=core[-1] * 1000, mean=st.mean(agg), p10=pct(agg, .1), p90=pct(agg, .9), per_cell={c: st.mean(rates[c][s] for s in core) for c in camps})

def pg_deltas(pg_csv, lo, hi, tps):
    rows = [r for r in csv.DictReader(open(pg_csv)) if r.get("wal_bytes")]
    d = []
    for a, b in zip(rows, rows[1:]):
        t = int(b["epoch_ms"]); dt = (t - int(a["epoch_ms"])) / 1000
        if dt <= 0 or not (lo <= t <= hi): continue
        calls = int(b["stmt_calls"]) - int(a["stmt_calls"]); exec_ms = float(b["stmt_exec_ms"]) - float(a["stmt_exec_ms"])
        d.append(dict(wal=(int(b["wal_bytes"]) - int(a["wal_bytes"])) / dt, commits=(int(b["xact_commit"]) - int(a["xact_commit"])) / dt, tup=(int(b["tup_updated"]) - int(a["tup_updated"])) / dt,
                      ins=(int(b["tup_inserted"]) - int(a["tup_inserted"])) / dt, active=int(b["active"]), waiting=int(b["waiting"]), conns=int(b["conns"]), lat=(exec_ms / calls) if calls > 0 else None))
    if not d: return None
    m = lambda k: st.mean(x[k] for x in d)
    lats = [x["lat"] for x in d if x["lat"] is not None]
    return dict(wal_mb_s=m("wal") / 1e6, wal_kb_msg=m("wal") / tps / 1024, commits_s=m("commits"), commits_msg=m("commits") / tps, tup_s=m("tup"), tup_msg=m("tup") / tps, ins_msg=m("ins") / tps,
                active=m("active"), active_max=max(x["active"] for x in d), waiting=m("waiting"), waiting_max=max(x["waiting"] for x in d), conns_max=max(x["conns"] for x in d), stmt_lat_ms=st.mean(lats) if lats else None)

def redis_deltas(redis_csv, lo, hi, tps):
    rows = [r for r in csv.DictReader(open(redis_csv)) if r.get("ops_per_sec") and lo <= int(r["epoch_ms"]) <= hi]
    if len(rows) < 2: return None
    cpu = (float(rows[-1]["cpu_sys"]) + float(rows[-1]["cpu_user"]) - float(rows[0]["cpu_sys"]) - float(rows[0]["cpu_user"])) / ((int(rows[-1]["epoch_ms"]) - int(rows[0]["epoch_ms"])) / 1000)
    ops = st.mean(int(r["ops_per_sec"]) for r in rows)
    return dict(cores=cpu, core_ms_msg=1000 * cpu / tps, ops=ops, ops_msg=ops / tps, clients=max(int(r["clients"]) for r in rows))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("dir"); ap.add_argument("--control"); a = ap.parse_args()
    cells = load_cells(a.dir); print(f"== {a.dir}: {len(cells)} cell(s)")
    for c in cells: print(cell_summary(c))
    ok = [c for c in cells if c["w"]]
    tps_sum = sum(c["w"]["steadySuccessfulTps"] for c in ok)
    agg = None
    if os.path.exists(os.path.join(a.dir, "progress.csv")) and len(ok) > 1:
        agg = concurrent_aggregate(os.path.join(a.dir, "progress.csv"))
        if agg: print(f"  concurrent window {agg['seconds']}s: aggregate TPS mean {agg['mean']:.0f} (p10 {agg['p10']:.0f} p90 {agg['p90']:.0f}), per campaign {[round(v) for v in agg['per_cell'].values()]}")
        else: print("  concurrent window too short: cells did not overlap; start them closer together")
    tps = agg["mean"] if agg else tps_sum
    lo = agg["lo"] if agg else None; hi = agg["hi"] if agg else None
    for c in ok:
        hp = os.path.join(c["dir"], "host.jsonl")
        if os.path.exists(hp):
            h = host_cpu(hp, lo, hi)
            if h: print(f"  {os.path.basename(c['dir'])} host: node {h['node']:.2f} cores (main util {100*h['main_util']:.0f}% runqueue {100*h['main_wait']:.1f}%), shard util {[round(100*v,1) for v in h['shard_util']]}% runqueue-wait {[round(100*v,1) for v in h['shard_wait']]}% -> scheduler stall {1000*st.mean(h['shard_wait'])/(c['w']['steadySuccessfulTps']/4):.3f} ms/msg | postgres {h['pg']:.2f} redis {h['redis']:.2f} cores on this host | runnable p50 {h['running']:.0f}")
            if lo is None: lo, hi = h["lo"], h["hi"]
    if a.control:
        ctl = [c for c in load_cells(a.control) if c["w"]]
        if ctl:
            base = st.mean(c["w"]["steadySuccessfulTps"] for c in ctl)
            print(f"== control: {len(ctl)} rep(s) single-cell TPS mean {base:.0f} ({[round(c['w']['steadySuccessfulTps']) for c in ctl]})")
            if agg: print(f"== scaling efficiency: {agg['mean']:.0f} / ({len(ok)} x {base:.0f}) = {agg['mean']/(len(ok)*base):.3f}  (>=0.90 acceptable, >=0.95 strong)")
            else: print(f"== per-cell steady sum {tps_sum:.0f} / ({len(ok)} x {base:.0f}) = {tps_sum/(len(ok)*base):.3f} (not a concurrent aggregate: run progress-sampler for the true number)")
    if lo is not None and os.path.exists(os.path.join(a.dir, "pg.csv")):
        p = pg_deltas(os.path.join(a.dir, "pg.csv"), lo, hi, tps)
        if p: print(f"== PostgreSQL (deltas, window): WAL {p['wal_mb_s']:.2f} MB/s = {p['wal_kb_msg']:.2f} KB/msg | commits {p['commits_s']:.0f}/s = {p['commits_msg']:.3f}/msg | tuple updates {p['tup_s']:.0f}/s = {p['tup_msg']:.2f}/msg | inserts {p['ins_msg']:.2f}/msg | active backends mean {p['active']:.1f} max {p['active_max']} | lock waiters mean {p['waiting']:.2f} max {p['waiting_max']} | connections max {p['conns_max']} | mean statement latency {p['stmt_lat_ms'] if p['stmt_lat_ms'] is None else round(p['stmt_lat_ms'],3)} ms")
    if lo is not None and os.path.exists(os.path.join(a.dir, "redis.csv")):
        r = redis_deltas(os.path.join(a.dir, "redis.csv"), lo, hi, tps)
        if r: print(f"== Redis: {r['cores']:.3f} cores = {r['core_ms_msg']:.4f} core-ms/msg | {r['ops']:.0f} ops/s = {r['ops_msg']:.2f} ops/msg | clients max {r['clients']}")
    print("== classification guide: compare PostgreSQL cores/msg, WAL/msg, commits/msg, statement latency and lock waiters between the control and the N-cell run. Flat per-message costs and flat latency = A (linear/provisionable); rising cores/msg or latency = B (emerging); per-message cost growing faster than N = C (superlinear); PostgreSQL below ~50% of its domain with flat latency = D (not limiting).")

if __name__ == "__main__": main()
