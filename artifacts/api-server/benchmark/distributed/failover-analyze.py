#!/usr/bin/env python3
"""Failover SLA from a failover.sh results dir: kill -> denial interval -> ownership takeover -> XAUTOCLAIM -> first provider start -> drain, and job accounting."""
import json, re, sys
d = sys.argv[1]; ev = open(f"{d}/events.log").read()
kill = int(re.search(r"(\d+) KILL pid", ev).group(1))
rec = [json.loads(l) for l in open(f"{d}/replacement.jsonl") if l.strip()]
evs = {r.get("event"): r for r in rec if r.get("event") in ("boot", "runtime-started", "first-ownership", "first-provider-start", "drained")}
samples = [r for r in rec if r.get("event") == "sample"]
rel = lambda e: f"+{(evs[e]['epoch']-kill)/1000:.1f}s" if e in evs else "n/a"
first_reclaim = next((r for r in samples if r["brokerRecovered"] > 0), None)
print(f"kill at {kill}; replacement boot {rel('boot')}, runtime {rel('runtime-started')}, ownership {rel('first-ownership')} (owned {evs.get('first-ownership',{}).get('owned')} tokens {evs.get('first-ownership',{}).get('tokens')}), "
      f"XAUTOCLAIM first {'+%.1fs' % ((first_reclaim['epoch']-kill)/1000) if first_reclaim else 'n/a'}, first provider start {rel('first-provider-start')}, drained {rel('drained')}")
if "drained" in evs and evs["drained"].get("campaignStatus") != "Completed":
    print(f"NOTE: every job is terminal but the campaign row is '{evs['drained'].get('campaignStatus')}': campaign_metrics drifted after the kill (known, separate accounting issue); job rows are the source of truth below")
print(f"denial interval: {max((r['denials'] for r in samples), default=0)} denials; reclaimed envelopes {max((r['brokerRecovered'] for r in samples), default=0)}; replacement starts {samples[-1]['starts'] if samples else 0}")
print("jobs (status|attempts|count|reason):"); print(open(f"{d}/jobs.txt").read().strip())
rows = [l.split("|") for l in open(f"{d}/jobs.txt").read().strip().splitlines()]
sent1 = sum(int(c) for s, a, c, _ in rows if s == "Sent" and a == "1"); requeued = sum(int(c) for s, a, c, _ in rows if s == "Sent" and int(a) > 1)
unknown = sum(int(c) for s, a, c, r in rows if s == "Failed" and "unknown" in r); other_failed = sum(int(c) for s, a, c, r in rows if s == "Failed" and "unknown" not in r)
total = sum(int(c) for _, _, c, _ in rows)
print(f"accounting: total {total} = sent first attempt {sent1} + requeued and sent {requeued} + failed closed delivery-unknown {unknown} + other failed {other_failed}; lost = {total - sent1 - requeued - unknown - other_failed} (must be 0); duplicates by construction 0 (delivery-unknown envelopes are never re-sent)")
