# Reducing crash-induced delivery-unknown messages before very high sustained TPS

Status: plan only. Only the graceful-stop drain (P4) is implemented, in V2-372. Items that change the send payload or
Graph API semantics need the owner's approval first (CLAUDE.md). Every item is tested against the mock provider and the
fake Graph server only.

## 1. Where the delivery-unknown messages come from

A delivery-unknown job is failed for manual reconciliation and never re-sent, because it may have reached the
provider. That rule is correct and stays. The problem is how much never-sent work ends up there after a crash
(SIGKILL, OOM, host loss).

### 1.1 The two crash paths

**A. Broker reclaim (Decision 8, `abandonBrokerEnvelopes` in `campaign-queue.ts`).** The successor reads the dead
consumer's pending entries, meaning entries the dead cell had read from the per-phone stream and not acknowledged. It
settles each by the state of its job:
- lease still live: deferred;
- job already settled: acknowledged;
- a sent outcome already recorded: settled Sent (B13 R3);
- job still Processing under an expired lease: failed with "Provider delivery is unknown after broker consumer
  loss".

**B. Reaper requeue, then re-preparation (Decision 2).**
- Housekeeping runs every 100 ms and reaps expired job leases. The leases are renewed while the cell lives, so they
  lapse 20–30 s after a crash.
- A reaped job is queued again. When it is prepared again, its provider intent from the dead cell is still `pending`,
  so preparation fails it with "Provider delivery is unknown; manual reconciliation is required".
- This catches every job the dead cell had prepared (intent armed) that path A did not settle first:
  - published entries the successor did not read and discard in time;
  - jobs prepared but not yet published (the refill window).

### 1.2 Stage of a job at the crash

The lane reads up to `min(4096, ceil(TPS × 3 s))` minus what it holds. Each cell can hold at most 4,096 prepared and
unsettled jobs: the sender's durable-outcome slots (`OUTCOME_QUEUE_CAPACITY`) are reserved at preparation and freed
only when the outcome is durable.

| Stage at the crash | Reached the provider? | Result today |
|---|---|---|
| Prepared, not yet published (refill window) | no | unknown (path B) |
| Published, unread in the stream | no | not-started if the successor discards it as stale before the lease lapses; otherwise unknown (path B) |
| Read, waiting in the lane queue for the 500 ms admission horizon (most of the 3 s) | no | unknown (path A) |
| Admitted to the shard, waiting for its paced slot (up to 0.5 s) | no | unknown (path A) |
| HTTP call in flight (8 s timeout, usually 0.1–0.5 s) | maybe | unknown (path A) |
| Completed, outcome not yet flushed (≤ 25 ms normally, up to 4,096 under backpressure) | yes | unknown (path A) |
| Completed, outcome durable | yes | Sent |
| Completed, only the acknowledgement missing | yes | acknowledged |

Only the HTTP-in-flight and not-yet-flushed rows are genuinely ambiguous. Today the dead cell's other rows cannot be
told apart from them, so they fail too.

### 1.3 Sources outside a cell crash

- **Transport shard death.** When a shard worker exits, the parent rejects every item it had posted to that shard,
  including items that never started. A fix is possible: the shard announces each start, and the parent treats an
  item with no announcement as not started. It is only safe once it is confirmed that the worker's messages posted
  before `exit` are always delivered first.
- **Campaign pause or cancel, and lease loss.** These abort the campaign's (or lease's) sends mid-HTTP through the
  in-flight registry (`routes/campaign-engine.ts`, `campaign-runtime.ts` `abortLease`), and those end unknown. The
  remedy is the same as for the graceful stop below: stop admitting, and let started calls finish within a bound.

### 1.4 Measured and projected

**Measured** (`test:auto-assignment`, 10 TPS per phone, mock provider, test timings):
- failover test, two phones on the killed cell: 36–51 delivery-unknown per crash over five runs (41, 39, 51, 41, 36),
  about 1.8–2.6 s of those phones' traffic;
- mixed-state test, two kills: 88–98.

**Projected per crash**, roughly `min(phones × TPS × ~2.5 s, 4,096)` per killed cell:
- one phone at 1,000 TPS: about 2,000–2,600;
- five phones at 1,000 TPS: capped near 4,096 for the cell (about 820 per phone).

At that rate, the 4,096-slot cap also limits the cell's preparation lookahead to about 0.8 s. P0 must measure both.

**Graceful stop.** Before V2-372, a graceful stop aborted sends in flight, so every restart under latency produced
delivery-unknown too. The stop now waits up to 10 s for them (section P4). `test:auto-assignment` measured this at
400 ms provider latency: zero delivery-unknown, with a stop of 1.6 s.

## 2. Prioritised plan

### P0. Measure it and gate it

Do this first. It is small and changes no behaviour.
- **Counters,** per phone and per crash, kept separate:
  - path A (`abandonBrokerEnvelopes` unknown outcomes);
  - path B (re-preparation failures on a `pending` intent);
  - shard-death and abort-caused unknowns.
- **Sampled composition** per lane: prepared-unpublished, published-unread, queued, admitted-not-started, HTTP in
  flight, outcome not flushed. Also the cell's outcome-slot use.
- **Kill benchmark.** Extend the benchmark flow with a kill run at the target sustained TPS (fake Graph server):
  SIGKILL one cell under load, and report delivery-unknown per phone by path, duplicates (must be 0), takeover time,
  and the provider's p99 latency.
- **Acceptance gates before raising sustained TPS.** They are relative to the measured p99 provider latency, `L`:
  - after P1: unknown per phone per crash ≤ TPS × (0.5 s + L + 0.25 s);
  - after P2: ≤ TPS × (L + 0.1 s);
  - 0 duplicates in every run.

### P1. Just-in-time consume, with a timely stale discard

This is the largest reduction. It is internal, with no schema change, but it changes measured files (Gate B).
- **What.** Read from the stream only what the next admission window needs: about TPS × (0.5 s + margin), instead
  of up to the 3 s lane capacity. Claim, prepare and publish still run up to 3 s ahead, so pacing and supply do not
  change.
- **Precondition, without which P1 gains nothing.** Unread entries move from path A to path B unless the successor
  discards them as stale before the dead owner's job leases lapse (about 20 s; the revoke is fenced to that lease).
  Either:
  - the successor reads and discards a dead consumer's stream backlog within that window, measured under load; or
  - the reaper, before requeuing, settles a job not-started when its entry is beyond the consumer group's
    last-delivered id (published, never read).
- **Expected effect.** Unknown per crash drops from about TPS × 2.5 s to about TPS × (0.5 s + L).
- **Risks to cover:**
  - more `XREADGROUP` calls (about one per 100 ms per lane at 1,000 TPS; cheap);
  - starvation if a read is slow (keep a margin and adapt it to the measured consume latency);
  - interaction with the B13 R2/R4 accounting (`readyDepth`, deferred ids, admission timer).
- **Tests:**
  - the P0 kill benchmark, by path;
  - a crash with a large unread backlog, proving it ends not-started and not unknown;
  - the reservoir starvation and supply suites;
  - Gate B throughput evidence for the new hash.

### P2. Durable "started" record before the provider call

This makes the classification exact. It needs a design review before code.
- **Who writes it.** Either:
  - the parent, when it admits an item to the shard, before posting it; or
  - the shard, which awaits the parent's announce before starting the HTTP call.

  It is one pipelined write per batch, at most about 100 ms ahead. If the write fails, nothing in the batch starts
  (fail closed).
- **Fencing.** A Lua script writes the record only while the phone's current fence token is the writer's, so a
  stale owner cannot add to it after a takeover.
- **When recovery may use it.** Only while the dead owner's job leases are live, or by a reaper that consults the
  record before requeuing. Otherwise path B fails the job first. An alternative is a PostgreSQL start mark on the
  intent (`started` before HTTP), at one more database write per batch.
- **Redis loss.** A record created per consumer at lane start lets recovery tell "no record" (Redis lost it:
  unknown, as today, which is safe) from "not recorded" (not started).
- **Expected effect.** Unknown per crash drops to about TPS × (L + announce window).
- **Risks and work:**
  - prove that the shard never starts an id it has not recorded, including retries and D2/D3/D4 refusals;
  - the Redis write on the dispatch path (measure it);
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

### P4. Crash less, and keep planned operations clean

Partly done.
- **Done in V2-372: graceful stop drains transport.** SIGTERM stops claiming and admitting, waits up to 10 s for
  sends already in transport, then aborts what is left (logged as a warning). `test:auto-assignment` proves zero
  delivery-unknown at 400 ms latency; it failed before the change.
- **To do:**
  - **Pause, cancel and lease loss.** Apply the same drain to campaign pause and cancel: let started calls finish,
    and abort only queued work.
  - **Shards.** Implement the shard-death start announcement (1.3), and respawn a dead shard instead of only
    releasing its phones.
  - **Memory.** Keep memory headroom below `MemoryMax=3584M`, with an alert at `MemoryHigh`.
  - **Alerts:** on `Campaign runtime tick failed`, on lease lapses, and on `Campaign runtime stopping with sends
    still in transport`.

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

1. P0, then P1 with its precondition. **Required before enabling very high sustained TPS** (500+ per phone).
2. P2. Strongly recommended for 1,000 TPS per phone.
3. P4's remaining items, in parallel. They are small and independent.
4. P3, after owner approval. Independent of P1 and P2.
5. P5. Operational.

Each step that changes measured files needs:
- new Gate B evidence for its `measuredFilesSha256`;
- the kill benchmark's numbers by path at the target TPS.
