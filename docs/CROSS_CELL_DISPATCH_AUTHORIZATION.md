# Cross-cell dispatch authorization: findings and proposed design

Status: the design is **approved in principle (2026-11-04), not for production rollout**. Each phase is
implemented and reviewed separately. **Phase 0 (defect fixes) is implemented** on
`feature/v2-370-phase0-cross-cell-safety` (section 4.1). Phases 1 to 3 are not implemented, so the cross-cell
window in section 2 is still today's behaviour. The 1 s bound is a target until a phase demonstrates it, with
the freshness and fail-closed guarantees proven under listener loss and database outages. Written for PR #1
(Step 369 follow-up), at code state `282653a`.

## 1. The problem

Production runs two API cells. A pause, cancel, emergency kill, route pause, inbound STOP or manual
suppression is served by one cell. That cell aborts its own in-flight work at once
(`inFlightRegistry.abortCampaign` / `abortRecipient`, `services/campaign-inflight.ts`). That registry is
**process-local**, though, so the other cell learns of the change only from PostgreSQL:

- **Its lane queue:** re-checked by `renewQueuedReservoirLeases` on the renewal pass, every `leaseMs / 3`
  (10 s in production).
- **Its transport pacing backlog:** never re-checked. This is up to about 3 s of prepared, paced work per
  phone, inside the shard workers.
- **Envelopes still in the broker:** re-checked at consume, but that check has no suppression predicate. A
  STOP is caught there only by the renewal pass.

## 2. What was measured and confirmed (not inferred)

All of this used two isolated cells: separate OS processes, sharing only the local PostgreSQL and Redis,
with mock sends only. The suite is `test:cross-cell-characterization`.

| Action served by the other cell | Sends by the sending cell after the commit | Last send after the commit |
|---|---|---|
| Pause | 48 | 2.48 s |
| Emergency kill | 47 | 2.45 s |
| STOP of an already-claimed recipient | the one claimed message | about 1.1 s |

- **No duplicate provider dispatch** in any run.
- **Every terminal state was correct:**
  - after a pause, jobs are only Sent or requeued;
  - after a kill, jobs are only Sent or Cancelled ("Emergency kill");
  - a STOPped recipient who was not yet claimed is never sent, and fails at preparation.
- **Today's bound** is 7.85 s at the test lease. It is asserted, and so is the existence of the gap.

**Defect D1 (pre-existing; reproduced twice, 45 and then 46 of 240 jobs).** Suppose a cross-cell pause
leaves the other cell with no Running campaign on a phone:

1. That cell drops the lane, and the shard worker cancels the lane's paced backlog before start.
2. The parent-side registration was never aborted, so `dispatchReservoirEnvelope` rethrows the
   cancellation as a plain error.
3. A plain error is not a retryable provider error, so the failure settlement marks the job **Failed** with
   "Send aborted before provider start".
4. Those messages were never sent, and resume will not retry them.

On the serving cell the same pause requeues correctly. **Fixed in Phase 0** (section 4.1). The acceptance
test in the suite now passes, where before the fix it was recorded as `todo`.

**Other defects confirmed by reading the code:**
- **D2.** `campaign-transport-shard-worker.ts`: a second `if (!owns(item)) continue;`, just after the
  start checks, posts no outcome. The parent's dispatch promise would never settle. This is reachable only
  if ownership expires in the microseconds between two synchronous statements.
- **D3.** A cancel seen inside `invoke` is reported as a provider error and recorded `delivery_unknown`,
  although no call was made.

**Inferred, not reproduced:**
- **D1b.** "Transport ownership unavailable" on the parent side is recorded as `delivery_unknown` and the
  job fails.
- **Unfenced revoke.** The `revokePrepared` UPDATE is not fenced to a lease. So a stale broker envelope
  discarded after its job was re-armed under a new lease can flip the newer intent to `rejected`.

## 3. Proposed mechanism (recommended after a three-design panel and two independent judges)

### 3.1 Control events: PostgreSQL NOTIFY inside the writer's own transaction

- Each control writer calls `select pg_notify('wabista_dispatch_control_v1', <payload>)` inside its own
  transaction.
  - PostgreSQL delivers it only if that transaction commits, and in commit order.
  - The writers are the lifecycle action, STOP, manual suppression, route pause or delete, and campaign
    delete.
- The payload is versioned and under 200 bytes: the kind (campaign, route or recipient), the ids, and the
  action.
- **No schema change and no trigger.**
- Resume and activation emit nothing. Section 3.3 explains why none is needed.
- **An emergency kill is never refused.** If the commit fails because the notification queue is full, it
  is retried once without NOTIFY, and the other cells' poll catches it.

### 3.2 Each cell: a listener, a heartbeat proof, a poll backstop and a freshness word

- **Listener.** One dedicated connection per cell, outside the pools, runs `LISTEN`. That is one extra
  PostgreSQL connection per cell.
- **Heartbeat.** Every 200 ms the cell sends a NOTIFY to itself on that connection.
  - Delivery is in commit order. So when its own heartbeat arrives, every control event committed before it
    was sent has already been applied.
  - That makes the heartbeat's send time a proven freshness point (`n`).
- **Poll.** Every 250 ms, on the pool, two queries:
  1. one primary-key read of the routes the cell holds: campaign Running, not killed, route Active;
  2. a paged id-range read of new suppressions.
  A poll advances the second freshness point (`p`) only if both queries complete and the last page is
  short.
- **Freshness word.** `authorizedUntil = min(max(n, p) + W, p + Pmax)`, with W = 1 s and Pmax = 5 s, the
  ownership TTL.
  - All times are local monotonic. No cross-host clock is involved.
  - It is published to the shard workers through a shared 8-byte `SharedArrayBuffer`.

### 3.3 Applying a revocation

- **Matching.** A local revocation cache compares sequence numbers. Work is revoked only if its authorizing
  read began before the revocation was applied. Work claimed after a resume is therefore never blocked.
- **Aborting.** The registry gains campaign, route and recipient indexes, so aborts are O(k) and scoped
  exactly. Another campaign on the same phone is never touched.
- **Where work is stopped:**
  - Lane queue: discarded in one batch and requeued (or Cancelled on a kill).
  - Transport: the item's SAB flag is set, so the worker sees it before start.
  - Broker and in-flight consume: refused at adoption.
  - Preparation: diverted before publish.
- **Started calls are never aborted** by a cross-cell revocation (`keepStarted`). They complete and are
  settled truthfully, so no `delivery_unknown` comes from cross-cell control.

### 3.4 The check immediately before provider dispatch (no DB or network call on the hot path)

- **Where.** In `drain()`, and again in the shard worker just before start.
- **Order of checks:**
  1. aborted → cancel before start;
  2. ownership token differs → cancel;
  3. past the lease deadline minus a margin (9 s in production) → cancel before start;
  4. freshness word stale, or ownership lapsed under the same token → **hold**, never cancel;
  5. otherwise → start.
- **Cost.** One `Atomics.load` plus a monotonic clock read, about 0.1 µs per message.
- **TPS is preserved:** no per-message query, and the transport boundary still makes no DB call.

### 3.5 Bounds

| Situation | From control commit to the last possible start on the other cell |
|---|---|
| Healthy | NOTIFY delivery plus main-loop lag: a few ms; target p99 ≤ 25 ms; CI asserts 250 ms |
| Any degraded mode, for every instrumented writer | **≤ W = 1 s** (a stale view holds the cell) |
| Listener down, pool healthy | about 300 ms |
| Uninstrumented writes: old-version cell mid-deploy, operator SQL, a missed writer | about 300 ms while the poll is healthy; **hard bound 5 s** |
| Today | lane queue up to 10 s; transport about 3 s, never re-checked |

### 3.6 Fail-closed without unnecessary cancellation

- **Unknown means hold, never cancel.** A lost listener, a failed poll, a pool stall or a same-token
  ownership lapse all only hold work. Resume is paced, with no burst.
- **Known means cancel only what has not started.** It is scoped to the exact campaign, route or recipient.
- **Revoked work gets the serving cell's own semantics:** requeued on pause, Cancelled on kill or cancel.
- **Fencing and lease tokens are untouched.** The gate only removes or delays starts. It never renews or
  resurrects a lease, and settlement stays fenced to the exact lease.

## 4. Phases (each one a separately approved sending-behaviour change)

| Phase | Content | Sending change |
|---|---|---|
| A (done, PR #1) | Characterization suite, 4 tests passing, plus the D1 acceptance test as `todo` | none |
| 0 (implemented, section 4.1) | Defect fixes. **D1:** cancelled-before-start is requeued, not Failed; D1b, D2 and D3; a lease-fenced intent revoke; batched not-started settlement. Registry indexes moved to phase 2, the first phase that aborts cross-cell | yes: these jobs failed permanently before |
| 1 | NOTIFY emission and the listener, heartbeat, poll and cache in **observe** mode (metrics only); manual suppression takes the STOP advisory lock | no, except manual suppression |
| 2 | **invalidate:** revocations applied (aborts, adoption refusal, preparation divert, keepStarted) | yes |
| 3 | **enforce:** the freshness gate in drain and the worker, hold on lapse, lease-deadline margin | yes |
| 4 (optional) | The serving cell's own pause, STOP and lane drop also keep started calls | yes |
| D (optional) | Additive NOTIFY triggers and a `provider_messages.armed_lease_token` column, planned with the owner | schema |

### 4.1 Phase 0 as implemented

**Rule.** Work this runtime *knows* never reached the provider is requeued:

- the attempt its claim spent is returned (`attempts = greatest(0, attempts - 1)`), in the same requeue UPDATE,
  fenced to the exact lease token;
- its durable intent is rejected, so its next preparation re-arms it.

Work that *may* have reached the provider keeps today's semantics.

| Path | Before Phase 0 | Phase 0 |
|---|---|---|
| **D1.** A lane drop or ownership loss cancels the paced transport backlog (the worker reports `cancelledBeforeStart`; the parent registration is not aborted) | Failed: "Send aborted before provider start" | requeued, attempt returned, intent rejected; batched per campaign through the failure-settlement pump |
| **D1b.** The shard parent refuses the hand-off: transport ownership unavailable, shards closed, or the signal aborted before hand-off | rejected, then `delivery_unknown` and Failed | a not-started outcome, settled as D1 |
| **D2.** Ownership lapses between the worker's two start checks | no outcome posted; the parent's promise never settled | a not-started outcome |
| **D3.** A cancel is seen inside `invoke`, before the provider call | reported as a provider error: `delivery_unknown` | a not-started outcome |
| Envelopes published but not yet consumed when a lane drops or the runtime stops | the lease expired, the reaper requeued the job with its intent still pending, and re-preparation failed it for manual reconciliation | requeued at once, attempt returned, intent rejected |
| Aborted before transport (the pre-dispatch check, the prepare-time revoke, lane and broker discards) | requeued, attempt spent | requeued, attempt returned |
| Aborted after transport may have started (STOP, kill, or pause on the serving cell; lease loss during a call) | unchanged | unchanged |

**Fenced intent revoke.** `revokePrepared(context, reason, leaseToken)` rejects a pending intent only when no
*other* live lease holds the job (no row that is `Processing` under a different lease token). No schema change.
Every wrapper forwards the token: the runtime's `DelegatingWhatsAppSender` and the benchmark's production
wrapper. A revoke without a token never rejects a live lease's intent.

- A stale envelope can no longer reject a newer lease's intent.
- A job that was reaped and is unclaimed is still revoked, so it no longer falls into manual reconciliation.
- **Residual:** a job reaped *and re-claimed* by another runtime before the old holder's revoke runs is still
  prepared against the old pending intent, and fails for manual reconciliation. It is never sent twice. The
  exact fix is the `armed_lease_token` column (phase D, decision 2).

**Not in Phase 0, by design:**
- the registry indexes (phase 2);
- every freshness, listener-loss and database-outage guarantee (phases 1 to 3);
- the non-reservoir `processBatch` path, which production does not run: its revokes are fenced, and its
  settlement is unchanged.

**Coverage:**
- `test:not-started-settlement` (single process, through the real shard workers): D1 lane drop, then
  re-ownership and an exactly-once send; D1b; the fenced revoke in all three lease states.
- `test:reservoir-lease-renewal`: unconsumed published envelopes at a lane drop and at stop.
- `test:cross-cell-characterization` (two OS-process cells), in addition to the four characterization tests:
  - D1 acceptance;
  - pause, then resume;
  - the ownership race (owner frozen past its ownership TTL);
  - crash recovery (owner SIGKILLed).

**Release impact.** `campaign-queue.ts` changed, so the Gate B `measuredFilesSha256`, `dist/index.mjs` and the
shard worker bundle change too.

- **Mode switch.** `CAMPAIGN_DISPATCH_AUTHORIZATION = off | observe | invalidate | enforce`, default `off`.
- **Rollout.** Enabled one cell at a time, only on GO. Rollback is `off`.
- **Release impact.** Every phase from 0 onward changes `campaign-queue.ts` (Gate B measured) and
  `dist/index.mjs`. So it needs fresh Gate B and release-artifact hashes; today's values must not be
  reused.

## 5. Decisions needed from the owner

1. **Approval and branch.** Approve this design and its phase split. Do phases 0–3 go on a new branch cut
   from PR #1, which keeps PR #1's behaviour unchanged?
2. **Phase 0 residual.** With the fenced intent revoke as implemented, only a job whose lease was reaped
   *and re-claimed* before its old holder's revoke ends in manual reconciliation (never a duplicate). Is that
   acceptable, or do you want the exact fix through the additive `armed_lease_token` column?
3. **W.** Keep W at 1 s (a stall longer than W on both the pool and the listener makes a cell hold), or
   set it from observe-mode data?
4. **Phase 4.** Should the serving cell's own aborts also stop aborting started HTTP calls? Today those
   aborts create `delivery_unknown`.
5. **Throttled routes.** Revoke them, as today's checks do, or hold them until reactivation?
6. **STOP timeouts.** STOP and manual-suppression transactions would get 5 s statement and
   idle-in-transaction timeouts. Under DB stress a STOP webhook could then fail and rely on Meta's retry.
7. **Production configuration, only on GO.** The new environment variables, one extra connection per cell
   (101 ≤ max_connections 120 per `deploy/postgres/campaign.conf`), and confirmation that the cells reach
   PostgreSQL directly or through a session-mode pooler, never a transaction-mode one.

## 6. Residual risks

- **Uninstrumented writers** are bounded by 5 s, not 1 s, until the optional triggers exist.
- **PostgreSQL becomes a soft dependency for starting sends** in enforce mode. It fails closed (hold), which
  costs availability. Observe mode measures the hold time first.
- **New code on a safety path:** the cache, the sequence tombstones and the worker hold state. This is
  mitigated by phasing, observe mode, unit tests and the off switch.
- **Requeues after a possible start still spend an attempt.** Since Phase 0, a requeue returns the attempt
  only when the work is known not to have started.
- **NOTIFY commits serialize cluster-wide.** That is negligible at control rates, but it must never be
  added to claim, prepare or settlement. A static writer test will enforce that.

## 7. Tests

- **In place, passing today** (`test:cross-cell-characterization`):
  - healthy two-cell baseline: exactly once, within the per-phone rate cap;
  - cross-cell pause, kill and STOP: the bounds, no duplicates, terminal states;
  - D1 acceptance (passing since Phase 0), pause then resume, the ownership race and crash recovery.
- **Acceptance tests to add with each phase:**
  - cross-cell pause, kill, STOP and suppression within 250 ms, with the shared phone untouched;
  - adoption race;
  - listener killed;
  - partitions shorter than and longer than the ownership TTL and the lease (hold, no Failed, no
    duplicate);
  - keepStarted;
  - worker gate hold and FIFO release;
  - the cache and freshness rules;
  - every control writer emits NOTIFY and no hot path does;
  - a kill when NOTIFY fails;
  - healthy load in enforce mode with zero revocations or holds and a throughput floor.
