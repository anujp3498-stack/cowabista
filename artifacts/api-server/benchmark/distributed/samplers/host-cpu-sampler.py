#!/usr/bin/env python3
"""Fork-free 1s CPU sampler: per-thread run/run-queue-wait (schedstat) of the runtime process, plus node/postgres/redis process CPU on this host.
usage: host-cpu-sampler.py <out.jsonl> <cmdline substring of the runtime process>"""
import os, sys, time, json
out, want = sys.argv[1], sys.argv[2]
def pid_of():
    for p in os.listdir("/proc"):
        if not p.isdigit(): continue
        try:
            if open(f"/proc/{p}/comm").read().strip() != "node": continue
            if want in open(f"/proc/{p}/cmdline", "rb").read().replace(b"\0", b" ").decode(): return int(p)
        except Exception: pass
    return None
def by_comm():
    m = {}
    for p in os.listdir("/proc"):
        if p.isdigit():
            try: m.setdefault(open(f"/proc/{p}/comm").read().strip(), []).append(int(p))
            except Exception: pass
    return m
def ticks(p):
    try: f = open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split(); return int(f[11]) + int(f[12])
    except Exception: return 0
f = open(out, "w"); pid = None; last = 0; comms = {}
while True:
    t = time.time()
    if pid is None or not os.path.exists(f"/proc/{pid}"): pid = pid_of()
    if t - last > 2: comms = by_comm(); last = t
    rec = {"t": int(t*1000), "pid": pid, "node": sum(ticks(p) for p in comms.get("node", [])), "postgres": sum(ticks(p) for p in comms.get("postgres", [])), "redis": sum(ticks(p) for p in comms.get("redis-server", []))}
    try: rec["running"] = int([l for l in open("/proc/stat") if l.startswith("procs_running")][0].split()[1])
    except Exception: pass
    th = {}
    if pid:
        try:
            for tid in os.listdir(f"/proc/{pid}/task"):
                try: s = open(f"/proc/{pid}/task/{tid}/schedstat").read().split(); th[tid] = [int(s[0]), int(s[1])]
                except Exception: pass
        except Exception: pass
    rec["threads"] = th
    f.write(json.dumps(rec) + "\n"); f.flush()
    time.sleep(max(0, 1.0 - (time.time() - t)))
