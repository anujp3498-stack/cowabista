#!/usr/bin/env python3
"""Pin the 4 transport shard threads of a runtime process to dedicated CPUs (Linux, needs permission to set affinity).
usage: pin-transport-threads.py <pid> <shard cpus e.g. 3> [other cpus e.g. 0,1,2]
Shard threads are identified as the 4 non-main threads with the most run-queue wait among those using >1% CPU,
observed over one second; verify the printed thread ids against the process if in doubt."""
import os, sys, time
pid = int(sys.argv[1]); shard = {int(x) for x in sys.argv[2].split(",")}
others = {int(x) for x in sys.argv[3].split(",")} if len(sys.argv) > 3 and sys.argv[3] else None
def snap():
    d = {}
    for t in os.listdir(f"/proc/{pid}/task"):
        try: s = open(f"/proc/{pid}/task/{t}/schedstat").read().split(); d[int(t)] = (int(s[0]), int(s[1]))
        except Exception: pass
    return d
a = snap(); time.sleep(1.0); b = snap()
ranked = sorted(((b[t][0]-a[t][0], b[t][1]-a[t][1], t) for t in b if t in a), reverse=True)
main = ranked[0][2]
cands = [r for r in ranked[1:] if r[0] > 10_000_000]
shards = [r[2] for r in sorted(cands, key=lambda r: -r[1])[:4]]
if others is not None:
    for t in b: 
        try: os.sched_setaffinity(t, others)
        except Exception as e: print("affinity failed", t, e)
for t in shards:
    try: os.sched_setaffinity(t, shard)
    except Exception as e: print("affinity failed", t, e)
print({"main": main, "shards": shards, "shard_cpus": sorted(shard), "other_cpus": sorted(others) if others else "unchanged"})
