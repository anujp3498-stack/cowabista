# Automatic phone-to-cell assignment (V2-372)

Branch `feature/v2-372-auto-phone-assignment`, based on `feature/professional-tps-ui` (`ef8d32e`). Nothing here has
been deployed. No database schema change. Mock provider only in every test.

## 1. The defect and its class

The two transport cells ran with fixed scopes, `CAMPAIGN_TRANSPORT_PHONE_IDS=1-4` and `5-8`. A newly connected phone
got id 9. It was inside no scope, so no runtime ever discovered it, took its ownership lease or sent its campaigns,
and nothing reported it. The immediate production fix widened cell 2 to `5-9`.

The class of defect is a static, hand-maintained map from phone ids to cells. It goes stale each time a phone is
connected, re-connected under a new id, or a cell is added or replaced. Before this change the only safeguard was
that an operator remembered to update two env files and the manifest, then restarted both cells.

## 2. Verified root causes

Each one was confirmed by reading the code path end to end and is covered by a test in section 6.

| # | Root cause | Effect on real sending |
|---|---|---|
| R1 | Static scopes: discovery (`campaign-phone-reservoir.ts` `discover()`) only reads phones inside the scope. | A phone in no scope is never sent, silently. |
| R2 | With the reservoir's global capacity full (16,384 = five 1,000-TPS lanes), `discover()` took the lease first, then refused to build a lane, and renewed that lease every tick. | That phone never sends, and no other runtime can take it either. |
| R3 | A workspace credential that failed to bind was retried every 100 ms tick (decrypt and database read each time). | Load, plus a fixed retry rhythm that an automatic plan would have kept handing back to the failing cell. |
| R4 | A dead transport shard thread is never replaced. `dispatch()` rejected at `waitForWorkerReady` before posting, and the caller recorded that as a provider failure. | Every message for about 1/8 of the cell's phones failed as delivery-unknown (manual reconciliation) although nothing was sent. The phones stayed owned, so no other cell could take them. |
| R5 | The broker's publish-dedupe hash (`campaign:prepared:{phone:N}:published`) gained one field per message, acknowledgement never removed it, and every publish re-armed its 24 h expiry. | Unbounded Redis growth. Redis runs `maxmemory 2gb` with `noeviction`, so the end state is every write failing on every cell, with no ownership, pacing or publishing anywhere. |
| R6 | `consume()` read deliveries (they move to this consumer's pending list) and then validated them. If validation threw, or the stale discard or its acknowledgement failed, nothing ever came back for them, because recovery skips the lane's own token. | Jobs never sent. Their leases lapsed into manual-reconciliation failures, and the orphaned entries kept the lane above low water, so the phone stopped claiming. |
| R7 | Lane teardown settled queued work one transaction per envelope, each taking the campaign row lock, and `discover()` awaited it, so every other lease waited. Discovery also made one ownership round trip per route row, not per phone. | Pausing a high-TPS campaign could block discovery for seconds, so every other phone's 5 s lease lapsed (a cascade). |
| R8 | Lease validity was Redis `TIME` + TTL, compared with the cell's own clock. | A cell more than the TTL ahead of Redis refused every send; one behind held a lease past its real expiry. |
| R9 | The fencing counter expired 100 s after its last use, so tokens restarted at 1. | A new owner could reuse a dead owner's token, and recovery would then treat the dead consumer's entries as its own in-flight work and never resolve them. |
| R10 | A lane's capacity was fixed when the lane was built. | A phone whose TPS was raised by the Meta sync (for example 80 to 1,000) stayed capped at its old in-flight bound until the lane was rebuilt. |
| R11 | No signal anywhere said that a Running campaign's phone had no transport owner. | The phone-9 incident could only be found by noticing that nothing was sent. |

## 3. The design

### 3.1 Modes (`CAMPAIGN_TRANSPORT_ASSIGNMENT`)

| Mode | Configuration | Behaviour |
|---|---|---|
| `auto` (new, recommended) | `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto`, no `CAMPAIGN_TRANSPORT_PHONE_IDS`, `CAMPAIGN_CELL=<name>` (the systemd unit sets it to the instance name) | The live cells divide every sendable phone between them. |
| `static` (unchanged) | `CAMPAIGN_TRANSPORT_PHONE_IDS=<ids>` | Exactly the phones in the scope. This is also the rollback. |
| unscoped (unchanged) | neither | Every phone, first come first served. For development and single-runtime use; the systemd guard refuses it. |

The runtime refuses `auto` together with a scope. The guard additionally checks the manifest's third column: `auto` or
the static scope.

### 3.2 How the cells agree (`src/services/campaign-phone-assignment.ts`)

- **Membership.** Every second each cell refreshes its name in the Redis sorted set
  `campaign:cells:{campaign-cells}:members`. The score is an expiry computed on Redis `TIME`, and the TTL is 5 s, so
  a killed cell drops out by itself. A graceful stop removes the cell at once.
- **The plan.** It is a pure function of the live cells and the sendable phones with their lane weight
  (`ceil(TPS × 3 s)`), so every cell computes the same plan.
  - Each phone ranks the cells by rendezvous hashing (SHA-256 of cell name and phone).
  - Heavier phones are placed first. Each goes to the first cell in its ranking that stays within a load bound of
    1.25 × an even share (never below the heaviest phone), and within the cell's capacity.
  - The result is an ordered cell list per phone. Adding a phone moves at most a couple of others, and a cell
    leaving moves only that cell's phones.
- **Acquisition.**
  - The first cell in a phone's list asks the coordinator for it as soon as nobody holds it.
  - The k-th cell asks only after the phone has been seen unowned for k × 2 s. That covers an assigned cell that has
    no capacity, whose credential does not bind, whose shard died, or that is wedged.
  - A cell never asks for a phone it cannot serve: capacity, bind back-off and a failed shard are checked before
    the lease is touched.
- **Rebalance by graceful handoff.**
  1. A phone held by a cell other than its assigned cell is requested by the assigned cell. The request is a
     short-lived Redis key, renewed while still wanted. It is made only after the requester has been a member for
     5 s, and only for a phone it can serve.
  2. The holder honours a request from the cell its own plan names, after the lane has been held for at least 15 s,
     one handoff at a time, at most one start every 2 s.
  3. During the handoff the holder stops claiming. It keeps consuming and sending what it already prepared, then
     releases the lease when its broker entries, queue, transport and acknowledgements for that phone are all
     empty. If that has not happened within 15 s, the handoff expires:
     - the holder adopts and admits nothing more;
     - work that never reached transport is settled not-started (requeued, attempt returned);
     - the lease and transport are kept until the sends already in transport have finished, because revoking
       them would abort those HTTP calls into delivery-unknown;
     - only after a further 120 s is the lane released regardless;
     - settling and releasing run detached from the discovery tick, so a slow settlement never delays other
       phones' lease renewals. Until a phone's teardown completes, this cell neither renews nor re-acquires it,
       so no lane can be rebuilt for it while its stream entries are still being settled.
  4. The requester then acquires the phone with a new fencing token.
  5. A handoff costs no attempt and fails nothing.

### 3.3 Why this cannot send twice

None of the assignment state grants anything. The only authority over who may send for a phone is still the
coordinator's fenced lease (`ensurePhoneOwnership`, unchanged apart from R8 and R9):
- one owner at a time;
- a new token on every change of owner (now strictly increasing for ever);
- the transport is fenced to that token;
- every message is fenced to its own exact database lease;
- the previous owner's broker entries are recovered as before (Decision 8: deferred while its lease is live, acknowledged
  once released, delivery-unknown only if it expired).

A stale membership view, a disagreement between cells or a lost handoff request can delay a phone by a grace period
or cost an extra handoff. None of them can make two runtimes send for the same phone.

### 3.4 Why the TPS holds across cells

Pacing is one Redis cursor per phone (`campaign:pacing:{campaign-pacing:<org>:<phone>}:phone`), shared by every cell.
- A handoff is a hand-over: the holder stops claiming, sends only work it already reserved slots for, and releases.
- The new owner reserves slots after those.
- A failover starts after the dead owner's lease (5 s), so their slots cannot interleave.

The remaining dependency is clock skew between cells. Slots are on Redis time and each cell waits on its own clock,
so the clock gate (G-CLOCK, under 1 s) still applies.

### 3.5 What an operator sees

| Signal | Where |
|---|---|
| `Campaign runtime started` with `assignment` and `cell` | each cell at start |
| `Campaign transport cells changed` with the live cells | on every membership change |
| `Phone lane started on this campaign cell`, `Handing phone off…`, `Phone handed off…` (with `drained`, `handoffMs`) | per phone |
| **`Sendable phone has no transport owner; its campaigns are not sending`** (error) | after 20 s without an owner, in auto and static mode. In static mode this is the phone-9 alarm. |
| `Phone not taken: this runtime's reservoir capacity is full` (warn), `Transport shard has failed; phone released…` (error) | R2, R4 |
| Campaign monitoring `routes[].transportOwned` | `true` or `false` for each Active route of a Running campaign (`false` = no cell is sending that number); `null` when not applicable |
| `ownershipDenials`, `phoneCapacityRefusals`, `phoneHandoffs`, `credentialBindFailures` | dispatch metrics |

## 4. What changed, file by file

- `campaign-phone-assignment.ts` (new):
  - the plan, the controller and the unowned-phone tracker.
- `campaign-pacing-coordinator.ts`:
  - membership, owner reads and handoff requests for Redis and in memory;
  - R8: validity on the local clock from before the request;
  - R9: the fence counter is persistent (`PERSIST`).
- `campaign-phone-reservoir.ts`:
  - auto-mode discovery, acquisition and graceful handoff;
  - R2: capacity is checked before the lease, and a lease without a lane is released;
  - R3: bind back-off of 1 to 30 s, and no handoff requests for 10 minutes after a bind failure;
  - R4: phones on a failed shard are released;
  - R6: read deliveries are retried until queued or acknowledged, held exclusively by one consume pass;
  - R7: batched teardown, run detached from the discovery tick behind a per-phone guard, one row per phone;
  - R10: lanes follow TPS changes;
  - R11: static-mode unowned check.
- Independent review fixes (second and third commits):
  - handoff timeout without aborting in-flight sends;
  - `stop()` no longer waits on Redis before settling (leave is bounded to 1 s);
  - a delivery with no durable lease is acknowledged and dropped, rate-limited, never skipping the stale discard;
  - a batch whose publish finishes during `stop()` is settled not-started. One whose lane was dropped is never
    settled: a same-token successor takes it over, and otherwise it is left in the stream. Settling it could race
    a same-token successor that has already adopted it, which would be a duplicate send;
  - lane teardowns (inactive phones, handoff release and settlement, failed shards) run detached from the
    discovery tick;
  - the capacity-refusal metric is counted once per episode.
- `campaign-prepared-broker.ts`:
  - R5: acknowledgement also removes the entry's dedupe field, atomically (Lua), in chunks of 256.
- `campaign-transport-shards.ts`, `campaign-queue.ts`:
  - R4: a refusal before posting is "not started";
  - the failed shard is exposed to the reservoir.
- `campaign-phone-scope.ts`:
  - mode parsing.
- `campaign-runtime.ts`:
  - mode wiring;
  - `transportAssignment()`;
  - `peekPhoneTransportOwners()`.
- `routes/campaign-engine.ts` and `lib/api-spec/openapi.yaml`:
  - `transportOwned` (optional, generated clients regenerated).
- `deploy/systemd/*`:
  - the guard accepts `auto` (and mixed fleets), with refusal tests;
  - unit, manifest and env examples now default to `auto`.
- Gate B:
  - `campaign-phone-assignment.ts` and `campaign-phone-scope.ts` are now measured and required by the scope check.

## 5. Not changed, and known limits

- **Crash ambiguity is unchanged (Decision 8).** When a cell is killed, the work it had consumed may already have
  reached the provider. That work fails as delivery-unknown for manual reconciliation and is never re-sent.
  - Measured in the failover test: about TPS × 3 s per phone the dead cell owned.
  - Shrinking it would mean consuming only within the 500 ms transport admission horizon. That is a separate,
    measured change.
- **Cold start.** A cell that starts alone takes every sendable phone, because no other cell is visible yet. A cell
  that starts later receives its share by handoff, which takes from about 5 s after it joins (minimum hold 15 s per
  lane, one handoff at a time).
- **Two processes with the same `CAMPAIGN_CELL`** behave as one cell. This is safe because the lease decides, but
  they are unbalanced, and a warning is logged.
- **Not done (separate items):**
  - the settlement share is not weighted by TPS;
  - the source-empty back-off is not reset when a new campaign starts on a phone;
  - the broker's consumer-group cache does not recover from a deleted stream key without a restart (the runbook's
    "stop the cells first" covers this);
  - `campaign_routes.current_tps` is never written by the runtime;
  - a broker read whose reply is lost on the network (the read was executed) is resolved only when the lane's token
    changes.
- **No schema change.** The new Redis keys are the membership set and hash (they expire 100 s after the last
  heartbeat), handoff requests (3 s), and the now-persistent fence keys (one per phone).

## 6. Evidence

Local, against a disposable PostgreSQL 16 and Redis 7, mock provider only. The CI results are recorded in the change
report.

- **`test:phone-assignment`** (14 tests, no database):
  - plan balance, determinism and order independence;
  - phone 9 is planned onto a live cell and moves at most two other phones;
  - a leaving cell's phones go to the survivors;
  - weights and capacity;
  - the environment contract;
  - two controllers on a fake clock: plan agreement, cold start then handoff requests, fallback only after the grace
    period, membership expiry, graceful leave;
  - the unowned-phone tracker.
- **`test:auto-assignment`** (two OS processes, real PostgreSQL and Redis, mock provider audit log):
  - **balance**: both cells send, every job is sent once, one attempt each, TPS ≤ 10 + 1 in every rolling second
    per phone;
  - **phone 9**: a phone connected while the cells run is sent within 5 s with no configuration change;
  - **SIGKILL**: the survivor resumes the dead cell's phones (about 5 to 6 s, set by the lease TTL). No recipient
    reaches the provider twice, TPS holds across the takeover, and only the dead cell's consumed work fails, as
    delivery-unknown, at most TPS × 3 s per phone. Three consecutive runs, 4 phones at 10 TPS, the victim owning 2
    phones:
    - takeover in 5,441, 5,498 and 5,442 ms;
    - 41, 39 and 51 delivery-unknown, against a bound of 60;
    - 0 duplicates.
  - **join**: the late cell receives phones by drained handoff. Nothing fails, nothing is re-sent, and every job has
    exactly one attempt.
- **Development note.** The first failover runs found duplicate sends introduced by an early version of the R6 fix
  (two concurrent consume passes re-queued the same retried deliveries). That version was never committed. The
  exclusive hold fixed it, and test O pins it.
- **`test:reservoir-handoff`** (independent review and adversarial verification findings, in-memory fakes):
  - a batch published during `stop()` is settled;
  - one published after a same-token rebuild goes to the successor and is never settled (this fails against the
    second commit's discard rule);
  - one published after a drop with no successor is left alone;
  - a failing acknowledgement of an unusable delivery never skips the stale discard.
  - an expired handoff never revokes transport or releases the lease while sends are in flight; it requeues unsent
    work and releases once the sends and their acknowledgements are done;
  - a drained handoff releases at once, and a stuck one is forced after the grace;
  - `stop()` settles never-sent work although leaving the membership hangs on Redis;
  - a broker delivery with no durable lease is dropped instead of blocking its lane.
- **`test:stale-envelope-discard`**:
  - **O**: two overlapping consume passes queue each delivery exactly once. Without the exclusive hold this test
    fails; it reproduces the duplicate sends the first failover run caught during development.
  - **P**: a batch whose validation threw is retried, queued once and never orphaned.
- **`test:cell-guard`**: automatic cells are accepted, and every mismatch is refused.
- **`test:prepared-broker`**: the dedupe hash is empty after acknowledgement.
- **`test:transport-shards`**: a failed shard's refusal is "not started".

## 7. Production migration plan

Nothing in this plan has been run. Every step needs the owner's explicit approval at the time, in a low-traffic window,
with the release that contains this change already built and verified (CI green, B13 Gate B evidence for its
`measuredFilesSha256`, G-CLOCK passing on both cells and Host S).

The code is backward compatible: deployed with today's static env files it behaves as static scopes do now, plus the
R2 to R11 fixes. The switch to `auto` is a configuration change, so it is a separate step from the deploy.

**Step A: deploy with static scopes unchanged** (`1-4` and `5-9`), using the usual release procedure.
- Verify: the guard line shows `assignment=static`, and `Campaign runtime started` appears on both cells.
- Verify: no `Sendable phone has no transport owner` error after 1 minute.
- Verify: monitoring shows `transportOwned: true` on every Active route of a Running campaign.

**Step B: switch to `auto`**, one cell at a time.
1. On both hosts, edit `/etc/cowabista/cells.manifest` so that both scope columns read `auto`. Running cells are
   unaffected; only the next guard run reads it.
2. **Cell 2 (Host D).**
   - In `/etc/cowabista/cell-cell-2.env`, remove `CAMPAIGN_TRANSPORT_PHONE_IDS` and add
     `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto`.
   - Run `systemctl restart campaign-cell@cell-2`. SIGTERM drains and releases its leases; cell 1, still static,
     cannot take them, so phones 5-9 pause for the restart (seconds).
   - Verify: the guard line shows `assignment=auto`, then `Campaign transport cells changed` with `["cell-2"]`, then
     `Phone lane started on this campaign cell` for 5-9.
3. **Cell 1 (Host C).**
   - Make the same env change, then run `systemctl restart campaign-cell@cell-1`.
   - While it restarts, cell 2 takes phones 1-4 as soon as their leases are released.
   - Verify: cell 1 logs `Campaign transport cells changed` with both cells. About 20 to 40 s later, cell 2 logs
     `Handing phone off… to cell-1` and `Phone handed off… drained: true` for cell 1's share, and cell 1 logs
     `Phone lane started` for each of those phones.
4. **Acceptance:**
   - both cells own phones;
   - no `Sendable phone has no transport owner` error;
   - `transportOwned: true` on every Active route of a Running campaign;
   - no new delivery-unknown failures and no duplicate in the provider-side message records;
   - per-number sends within Meta's approved TPS.

**Step C: prove it.** Connect a new phone (or reconnect one) and confirm it is sent without any configuration edit.
Only with separate sending approval: a real campaign on a test audience.

## 8. Rollback

The rollback restores static scopes. It is safe in any mixed state, because the lease, not the mode, decides
ownership.
1. On both hosts, set the manifest scope columns back to static scopes that cover **every** phone, for example `1-4`
   and `5-9` (current production). A phone left out is reported after 20 s by `Sendable phone has no transport
   owner`.
2. Per cell: remove `CAMPAIGN_TRANSPORT_ASSIGNMENT`, set `CAMPAIGN_TRANSPORT_PHONE_IDS` to its manifest scope, and
   restart that cell. Then do the other cell.
3. **Code rollback (the previous release):**
   - no data or schema to undo;
   - the membership keys expire by themselves (100 s), and handoff requests expire in 3 s;
   - the persistent fence keys are given their old 100 s expiry again by the old code at its next acquisition;
   - the `transportOwned` field is optional, and older clients ignore it.
