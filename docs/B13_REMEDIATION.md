# B13 remediation (branch `b13-remediation`, base `2884382f`)

Gate B13 failed on release `2884382f` (2026-11-07, isolated Hetzner benchmark). The investigation and diagnostics
(T1 pinning test, T2 receipt-backed failovers) traced each failure to a cause. This branch fixes the application
defects. It changes no acceptance criterion, removes or renames no counter, and keeps at-most-once delivery: an
uncertain delivery is still never re-sent and still fails closed for manual reconciliation.

Every fix has a regression test that fails on `2884382f` and passes here (`test:b13-remediation`,
`test:receipt-ledger`).

**Historical measured-files hash (ab2c8c8, before independent-review corrections):**
`6cd2a56049dccced635d70c5f5a74cb84ce1b89070fc9ad69bca08cd0243efea` (27 files).
The independent-review edits changed some of those files, so the historical hash is already stale.
**This candidate also expands the Gate B file list to include the transport shard, reservoir, pacing,
provider senders and broker (39 measured files in this exported source).** Its final Gate B hash must be
recomputed on a clean Git commit using `.github/scripts/gate-b-hash.mjs`; never reuse the historical hash.

**History of the first fix commit (`fa9d89c`, hash `abbea4b6…`).** In the full suite it broke 5 existing suites
(19 tests), the only regression the branch caused. Both causes were changed contracts of existing callers, not
test defects:
- the reservoir called a worker method that test stand-ins do not have;
- the reaper had started to use runtime state, which a test relies on it not using.

`d3a1990` restored both contracts without editing any existing test.

## Fixes

| # | Defect (evidence) | Change | Regression |
|---|---|---|---|
| R1 | A no-fault production-path run failed 0.3-2.6% of jobs for manual reconciliation, in batches of 256, never sent (T2) | `WhatsAppTemplateSender.prepareBatch` reserves durable-outcome capacity **before** arming intents; a refusal throws `PreparationBackpressureError` with nothing armed, and `prepareReservoirBatch` returns that work as not started (attempt returned). The reservoir claims no more than `preparationHeadroom()`, and a claim that found work but prepared none no longer parks the lane on the source-empty ladder | R1a, R1b |
| R2 | After a cell died, a taken-over lane sent nothing for ~30 s (FO1 all lanes, FO2/FO3 some) | A lane's ready supply excludes the dead owner's deferred deliveries (`deferredDeliveryIds`, rebuilt by each recovery pass). They stay pending and are handled exactly as before (Decision 8); only refill gating changes. The `brokerDepth` metric still reports them | R2 |
| R3 | A reclaimed job whose intent was already `sent` was failed as delivery-unknown (T2 FO3: 4 jobs) | Before failing an expired-lease delivery closed, the reclaim reads `recordedSentOutcomes`; a recorded send is settled Sent with its provider message id. Nothing is sent | R3 |
| R4 | The settlement-slot pool sat at its 4,096 cap at the pacing ceiling; 500k-590k refused drain probes per cell | `drain()` admits an envelope into transport (taking its slot) only within `TRANSPORT_ADMISSION_HORIZON_MS` (500 ms) of its paced send time; later work waits in the lane, where its lease is renewed. The refusal counter is unchanged and still counts every refused probe | R4 |
| R5 | Starvation was a bare total | Each event is logged with phone, start, end and the lane's state when it went empty (`reservoirStarvationLog`, `reservoirStarvationByCause`); totals unchanged | R5 |
| R6 | A healthy campaign's `campaign_metrics` froze 6-11 s while another cell's expired leases were reaped | Metric deltas are folded on their own timer; the reaper works in 100-row batches within a 250 ms budget per housekeeping pass. Each row's transition is unchanged | R6 (30,000 leases: 54.6 s freeze before, 130 ms longest gap after) |
| R7 | Duplicate delivery during SIGKILL was asserted, not measured | `test/receipt-ledger.ts` reconciles the mock provider's cross-process receipts with job rows and intents; `test:receipt-ledger` kills a runtime process mid-campaign and requires 0 duplicates, 0 Sent without receipt, 0 definite failures delivered, nothing open, with a negative control | receipt-ledger |
| R8 | Shard run-queue wait about 2% (criterion: under 2%) | Investigation only, no code change (see below) | none |

## Independent review of `ab2c8c8` and its fixes
An independent code review of `ab2c8c8` found:

| Finding | Severity | Fix |
|---|---|---|
| With 0 preparation headroom, `runRefill` stopped before its first await and `pumpRefills` re-armed it in the same microtask chain: an event-loop livelock (no timers, no outcome flush, no lease renewal) | **Critical, introduced by R1** | `refillIfNeeded` and `pumpRefills` arm no refill without headroom; the next service tick (a timer) re-arms. Regression R1c drives the real re-arm path |
| `PreparationBackpressureError` was not a retryable provider error, so `send()`/`processBatch` failed the job permanently | Medium, introduced by R1 | It extends `ProviderRequestError` (retryable), as the error it replaced did |
| A database error while settling not-started work fell through to `settleFailedBatch` and failed it permanently | Low-medium | The not-started settlement failure leaves the jobs leased; nothing was armed, so lease expiry requeues them |
| The reaper's pass budget is checked only between batches; a 500-row batch can take 0.5-1 s on a networked database | Low | `REAP_BATCH_LIMIT` 100 |
| The receipt ledger counts "manual reconciliation" as an acceptable unknown, so a crash test cannot catch a no-fault failure | Test gap | New process-level no-fault test at outcome-capacity pressure (4 phones x 1,000/s, 10,000 jobs): every job Sent with exactly one receipt |

Reviewed and kept, as bounded:
- the deferred-set over-refill while a stalled holder acknowledges its own entries (at most one recovery interval);
- head-of-line waiting in `drain()` if a lane queue is not in `scheduledSendAt` order (at most the pacing
  lookahead, and leases are renewed);
- a reclaim racing an intent that turns `sent` just after it is read (fails closed as before).

## Measured impact (to be confirmed by the B13 rerun)
- R1: no-fault manual-reconciliation failures were 3,840/150,000 in the T2 dry run. Expected 0; the rerun's
  receipt ledger measures it.
- R2: full-rate recovery after takeover was about kill+31 s in all three failovers. Expected within about 1 s of
  takeover on every lane.
- R4: refusals at the ceiling should drop because in-flight per lane falls from the full share (1,024) to about
  550 at 1,000/s. Lanes will also hold more queued work, which changes how often the starvation counter sees an
  empty queue. The rerun must report starvation causes, not only totals.
- R6: measured in the test above.

## R8 (not changed here)
- **Where the wait comes from.** The shard thread wakes about 1,000 times a second per phone: a futex wait to
  each 1 ms send slot, then a `start` and an `outcome` message per send. T1 measured about 2% wait whether the four
  shards shared one CPU or four, with 0 CPU steal: per-wakeup scheduling latency, not contention.
- **The kit analyzer** picked shard threads by highest wait and reported 2.6%. On the recorded shard thread ids
  (`pin.log`, now used by `analyze.py`) the same official control reads 1.6-1.8% in the analyzer's window, or
  1.8-2.3% in a 20-80% window. That is near the threshold, not clearly under it.
- **Meeting the criterion with margin needs fewer wakeups.** Coalescing sends due within the same 1-2 ms changes
  pacing granularity; spinning costs a core per shard. Both need an owner decision and measurement on the B13
  hardware.

## Benchmark kit
- `analyze.py` identifies shard threads from `pin.log` and prints starvation by cause.
- Not changed, for the owner to decide:
  - `progress-sampler.sh` still reads `campaign_metrics`. R6 removes the freeze, but job rows are the
    authoritative count.
  - `analyze-shared.py` has no `--experiment-a` option; the runbook's mention of it is wrong.


## Additional launch hardening in exported candidate (not production deployed)

- D4: The shard checks its exact phone ownership token and lease again immediately before `invoke` enters the
  provider path. An expired lease during the post-`start` gap is reported as `cancelledBeforeStart`, not sent.
- `campaign-transport-shards.test.ts` contains D4's regression: the parent expires the lease after seeing the
  `start` notification while the shard is deliberately paused before `invoke`.
- Gate B now covers critical transport files. `.github/scripts/check-gate-b-scope.mjs` enforces its minimum
  file set in CI, making it impossible to change the shard without changing the benchmark identity.
- This is a local exported source candidate without a Git ref or full dependency-backed suite evidence; do not
  deploy or declare B13 PASS until independent validation.

- R7 test hardening: `parseProviderLog()` now rejects a nonempty mock provider log line with no recipient;
  previously such a record disappeared from the receipt ledger and could undercount true provider sends.
  The receipt-ledger regression checks malformed input and duplicate detection.
