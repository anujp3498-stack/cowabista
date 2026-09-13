#!/usr/bin/env python3
"""Analyze a shared-campaign experiment (Experiment B): per-cell and per-phone provider-start TPS over the window in
which every cell sends, aggregate TPS, settlement phase timings, and the shared PostgreSQL/Redis deltas over the same
window. usage: analyze-shared.py <experiment dir> [--experiment-a <dir analyzed by analyze.py, for comparison>]
<experiment dir> holds shared-cell-*/cell.json + cell.jsonl (+ host.jsonl), seed.json, and progress.csv / pg.csv /
redis.csv from the samplers. Cell timestamps are host clocks (NTP within 50 ms); the campaign sent-rate in
progress.csv is on the sampler's clock and is printed alongside as the shared-clock cross-check."""
import argparse, csv, glob, json, os, statistics as st, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import host_cpu, pg_deltas, redis_deltas, pct  # noqa: E402

def load_cell(d):
    summary = json.load(open(os.path.join(d, "cell.json"))) if os.path.exists(os.path.join(d, "cell.json")) else None
    samples = [json.loads(l) for l in open(os.path.join(d, "cell.jsonl")) if l.strip()]
    return dict(dir=d, summary=summary, samples=[s for s in samples if s.get("event") == "sample"], events={s["event"]: s for s in samples if s.get("event") != "sample"})

def rates(samples):
    """per-second provider-start rate (total and per phone) keyed by the sample's second."""
    out = {}
    for a, b in zip(samples, samples[1:]):
        dt = (b["epoch"] - a["epoch"]) / 1000
        if dt <= 0: continue
        per_phone = {p: (b["startsByPhone"].get(p, 0) - a["startsByPhone"].get(p, 0)) / dt for p in b["startsByPhone"]}
        out[b["epoch"] // 1000] = dict(total=(b["starts"] - a["starts"]) / dt, phones=per_phone, sample=b)
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("dir"); ap.add_argument("--min-rate", type=float, default=500); a = ap.parse_args()
    cells = [load_cell(d) for d in sorted(glob.glob(os.path.join(a.dir, "shared-cell-*")))]
    seed = json.load(open(os.path.join(a.dir, "seed.json"))) if os.path.exists(os.path.join(a.dir, "seed.json")) else {}
    print(f"== {a.dir}: {len(cells)} cell(s), campaign {seed.get('campaignId')} rows {seed.get('rows')} commit {str(seed.get('source', {}).get('gitCommit', '?'))[:12]}")
    r = [rates(c["samples"]) for c in cells]
    both = sorted(s for s in set.intersection(*[set(x) for x in r]) if all(x[s]["total"] > a.min_rate for x in r)) if r and all(r) else []
    if len(both) < 10:
        print("  concurrent window too short: cells did not overlap above the minimum rate"); core = []
    else:
        core = both[3:-3]
    lo = core[0] * 1000 if core else None; hi = core[-1] * 1000 if core else None
    agg = [sum(x[s]["total"] for x in r) for s in core]
    if core: print(f"  concurrent window {len(core)}s: aggregate provider-start TPS mean {st.mean(agg):.0f} (p10 {pct(agg, .1):.0f} p90 {pct(agg, .9):.0f})")
    for c, x in zip(cells, r):
        s = c["summary"] or {}; name = os.path.basename(c["dir"])
        cell_tps = st.mean(x[t]["total"] for t in core) if core else float("nan")
        phones = sorted({p for t in core for p in x[t]["phones"]}, key=int) if core else []
        per_phone = {p: st.mean(x[t]["phones"].get(p, 0) for t in core) for p in phones}
        ph = s.get("phones", {})
        last = c["samples"][-1] if c["samples"] else {}
        dm = s.get("dispatchMetrics", {})
        pt = s.get("phaseTimings", {})
        settle = pt.get("success_settlement") or pt.get("settlement") or {}
        print(f"  {name} [{s.get('status')}] host {s.get('hostname')} scope {s.get('scope')}: window TPS {cell_tps:.0f}, per phone {[round(v) for v in per_phone.values()]} "
              f"| interval mean {[ph[p]['meanMs'] for p in phones if p in ph]} p99 {[ph[p]['p99Ms'] for p in phones if p in ph]} peak1s {[ph[p]['peakInRollingSecond'] for p in phones if p in ph]} ceilingOK {all(ph[p]['ceilingSatisfied'] for p in phones if p in ph)} "
              f"| shard lateness mean {1000*dm.get('shardEventLoopDelayMs',0)/max(1,dm.get('shardStarts',1)):.0f} us | slots peak {dm.get('settlementPeakPending')} refusals {dm.get('settlementBackpressureEvents')} starvation {dm.get('reservoirStarvationMs')}ms/{dm.get('reservoirStarvationEvents')} reclaims {dm.get('brokerRecovered')} denials {dm.get('ownershipDenials')} "
              f"| settlement {settle.get('p50Ms')}/{settle.get('p95Ms')}/{settle.get('p99Ms')} ms p50/p95/p99 mean {settle.get('meanMs')} ms per batch, {settle.get('jobsPerBusySecond')} jobs/s busy, {1000*dm.get('settlementDrainedJobs',0)/max(1,dm.get('settlementDrainDurationMs',1)):.0f} jobs/s drained "
              f"| supply refills {dm.get('supplyRefillSamples')} mean {dm.get('supplyRefillDurationMs',0)/max(1,dm.get('supplyRefillSamples',1)):.0f} ms | event loop p95/p99 {last.get('eventLoopP95Ms')}/{last.get('eventLoopP99Ms')} ms | starts {s.get('starts')} completions {s.get('completions')} errors {s.get('errors')} | peak RSS {round(s.get('peakRssBytes',0)/1e6)} MB | campaign {s.get('campaignStatus')}")
        for phase, v in pt.items():
            if phase != "success_settlement": print(f"      phase {phase}: n {v['count']} jobs {v['jobs']} mean {v['meanMs']} p95 {v['p95Ms']} p99 {v['p99Ms']} ms")
        hp = os.path.join(c["dir"], "host.jsonl")
        if os.path.exists(hp) and lo:
            h = host_cpu(hp, lo, hi)
            if h: print(f"      host: node {h['node']:.2f} cores (main util {100*h['main_util']:.0f}% runqueue {100*h['main_wait']:.1f}%), shard util {[round(100*v,1) for v in h['shard_util']]}% runqueue-wait {[round(100*v,1) for v in h['shard_wait']]}% | postgres {h['pg']:.2f} redis {h['redis']:.2f} cores on this host")
    pc = os.path.join(a.dir, "progress.csv")
    if core and os.path.exists(pc) and seed.get("campaignId"):
        rows = [x for x in csv.DictReader(open(pc)) if x.get("sent") and int(x["campaign_id"]) == int(seed["campaignId"])]
        pts = sorted((int(x["epoch_ms"]), int(x["sent"])) for x in rows)
        sr = [(t1, (s1 - s0) / ((t1 - t0) / 1000)) for (t0, s0), (t1, s1) in zip(pts, pts[1:]) if t1 > t0 and lo <= t1 <= hi]
        if sr: print(f"  shared-clock cross-check: campaign sent-rate over the window mean {st.mean(v for _, v in sr):.0f}/s (settled, lags provider starts by the in-flight window)")
    tps = st.mean(agg) if core else None
    if tps and os.path.exists(os.path.join(a.dir, "pg.csv")):
        p = pg_deltas(os.path.join(a.dir, "pg.csv"), lo, hi, tps)
        if p: print(f"== PostgreSQL (deltas, window): WAL {p['wal_mb_s']:.2f} MB/s = {p['wal_kb_msg']:.2f} KB/msg | commits {p['commits_s']:.0f}/s = {p['commits_msg']:.3f}/msg | tuple updates {p['tup_s']:.0f}/s = {p['tup_msg']:.2f}/msg | inserts {p['ins_msg']:.2f}/msg | active backends mean {p['active']:.1f} max {p['active_max']} | lock waiters mean {p['waiting']:.2f} max {p['waiting_max']} | connections max {p['conns_max']} | mean statement latency {p['stmt_lat_ms'] if p['stmt_lat_ms'] is None else round(p['stmt_lat_ms'],3)} ms")
    if tps and os.path.exists(os.path.join(a.dir, "redis.csv")):
        rd = redis_deltas(os.path.join(a.dir, "redis.csv"), lo, hi, tps)
        if rd: print(f"== Redis: {rd['cores']:.3f} cores = {rd['core_ms_msg']:.4f} core-ms/msg | {rd['ops']:.0f} ops/s = {rd['ops_msg']:.2f} ops/msg | clients max {rd['clients']}")
    print("== read against Experiment A: if this aggregate plateaus while independent campaigns scale, and success_settlement p95 and PostgreSQL lock waiters rise with it, the campaign-row settlement lock is the proven ceiling.")

if __name__ == "__main__": main()
