# Reducing crash-induced delivery-unknown messages before very high sustained TPS

Status: plan only. Nothing here is implemented. Items that change the send payload or Graph API semantics need the
owner's approval first (CLAUDE.md). Every item is tested against the mock provider and the fake Graph server only.

## 1. Where the delivery-unknown messages come from

When a transport cell dies without a graceful stop (SIGKILL, OOM, host loss), its successor recovers the dead
consumer's **pending** broker entries. A pending entry is one the dead cell had read from the per-phone stream and
not yet acknowledged.

Decision 8 (`abandonBrokerEnvelopes`, campaign-queue.ts) settles each entry by the state of its job:
- **The lease is still live:** the entry is deferred.
- **The job was already settled:** the entry is acknowledged.
- **The job is still Processing under an expired lease (30 s):** delivery-unknown, failed for manual
  reconciliation, never re-sent.

This rule is correct and stays. The problem is how much never-sent work it has to treat as possibly sent. Today a
lane reads up to its capacity, `min(4096, ceil(TPS × 3 s))`, minus what it already holds. So at a crash, the dead
consumer's pending set covers about 3 s of the phone's traffic:

| Stage of a pending entry at the crash | Typical share of the 3 s | Reached the provider? |
|---|---|---|
| Adopted, waiting in the lane queue for the 500 ms transport admission horizon | about 2–2.5 s | no |
| Admitted to the shard, waiting for its paced slot | up to 0.5 s | no |
| HTTP call in flight (8 s timeout, usually 0.1–0.5 s) | TPS × latency | maybe |
| Completed, settlement or acknowledgement not yet durable | small | yes |

Only the last two rows are genuinely ambiguous. After a crash they can't be told apart from the first two, so all of
them fail as delivery-unknown.

**Measured** (`test:auto-assignment`, 10 TPS per phone, mock provider): 37–51 delivery-unknown per crash for two
phones, and 88 for two crashes. That is about 1.9–2.6 s of each affected phone's traffic. Projected at **1,000 TPS
per phone: about 2,000–2,600 per phone per crash, and 10,000–13,000 for a cell holding five such phones.** Each one
needs manual reconciliation.

## 2. Prioritised plan

### P0. Measure it and gate it

Do this first; it is small and changes no behaviour.
- **Counter.** Count delivery-unknown settled by reclaim, per phone and per crash (`abandonBrokerEnvelopes` "unknown"
  outcomes) in the dispatch metrics.
- **Sampled composition.** Sample each lane: queued, admitted-not-started, HTTP in flight, and awaiting settlement.
  That shows the live split of the table above at the target TPS.
- **Kill benchmark.** Extend the benchmark flow with a kill run at the target sustained TPS (fake Graph server):
  SIGKILL one cell under load, then report delivery-unknown per phone, duplicates (must be 0) and takeover time.
- **Acceptance threshold** before raising sustained TPS:
  - after P1: delivery-unknown per phone per crash ≤ TPS × 0.75 s;
  - after P2: ≤ TPS × 0.2 s;
  - 0 duplicates in every run.

### P1. Just-in-time consume

This is the largest reduction. It is internal, with no schema change, but it changes measured files (Gate B).
- **What.** Read from the stream only what the next admission window needs: about TPS × (0.5 s admission horizon +
  margin), instead of up to the 3 s lane capacity. Claim, prepare and publish still run up to 3 s ahead, so pacing
  and supply are unchanged.
- **Why it helps.** Work left unread in the stream is not pending. After a crash, the successor reads it as stale
  (older fencing token) and settles it not-started: requeued, attempt returned, intent revoked. That path already
  exists and is tested.
- **Expected effect.** Delivery-unknown per crash drops from about TPS × 2.5 s to about TPS × (0.5 s + HTTP latency).
- **Risks to cover:**
  - more `XREADGROUP` calls (about one per 100 ms per lane at 1,000 TPS; cheap);
  - starvation if a read is slow (keep a margin and adapt it to the measured consume latency);
  - interaction with the B13 R2/R4 accounting (`readyDepth`, deferred ids, admission timer).
- **Tests:**
  - the kill benchmark from P0;
  - the reservoir starvation and supply suites;
  - Gate B throughput evidence for the new hash.

### P2. Durable "about to start" record before the provider call

This makes the classification exact.
- **What.** Before invoking the provider for a batch, the shard records the batch's stream ids in Redis under a key
  per phone and consumer: `owner:token`, with a TTL at least the job lease. This is one pipelined write per batch,
  announced at most about 100 ms of slots ahead. If the write fails, nothing in that batch starts (fail closed).
- **Recovery.** A dead consumer's pending entry that is **not** in its record never started, so it is settled
  not-started. Only recorded entries can be delivery-unknown.
- **Expected effect.** Delivery-unknown per crash drops to about TPS × (HTTP latency + announce window).
- **Risks and work:**
  - prove the shard never starts an id it has not recorded (including retries and D2/D3/D4 refusals);
  - if Redis loses the record, fall back to today's behaviour (unknown), which is safe;
  - add a Redis write to the dispatch path (measure it);
  - Gate B.

### P3. Reconcile from provider status webhooks

This resolves the remainder automatically. It needs owner approval because it changes the send payload.
- **What.** Send an opaque correlation id with each message: the job id plus a lease hash, in the Cloud API's
  `biz_opaque_callback_data`. When a status webhook (sent, delivered, read, failed) carries the correlation of a
  delivery-unknown job, settle it accordingly, with an audit row.
- **Expected effect.** Genuinely sent messages leave manual review within minutes.
- **Rule that does not change:** the absence of a webhook is never evidence that a message was not sent, so nothing
  is re-sent automatically. Those jobs stay for an operator.
- **Tests:** mock provider and fake Graph webhooks only. Verify the field against the Graph version in use before
  relying on it.

### P4. Crash less

This is operational, and partly done.
- **Memory.** Keep memory headroom below `MemoryMax=3584M`, with an alert at `MemoryHigh`.
- **Graceful operations only.** Deploys and restarts must be graceful. A graceful stop produces no delivery-unknown;
  this is proven by the migration tests.
- **Alert** on `Campaign runtime tick failed` and on lease lapses.
- **Shards.** Respawn a dead transport shard instead of only releasing its phones (V2-372 releases them). That keeps
  throughput without adding unknowns.

### P5. Operator tooling for what remains

- **Bulk reconciliation.** A reviewed bulk action for delivery-unknown jobs: "confirmed not sent, requeue" or
  "confirmed sent, mark Sent". It needs explicit approval and an audit row, after checking the provider-side message
  log.
- **Existing tools.** The reconciliation view and the export already list them (Decision 2).

### P6. Faster resolution (no fewer unknowns)

Lower priority.
- A shorter job lease (30 s today) makes recovery decide sooner.
- It only shortens how long jobs sit in Processing, and it adds renewal load. Consider it only after P1 and P2.

## 3. Recommended order and gate

1. P0, then P1. **Required before enabling very high sustained TPS** (500+ per phone).
2. P2. Strongly recommended for 1,000 TPS per phone.
3. P3. After owner approval; independent of P1 and P2.
4. P4 and P5. In parallel; operational.

Each step that changes measured files needs:
- new Gate B evidence for its `measuredFilesSha256`;
- the kill benchmark's numbers at the target TPS.
