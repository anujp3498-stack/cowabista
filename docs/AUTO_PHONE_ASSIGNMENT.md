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
  - The prioritised plan to shrink it before very high sustained TPS is in `docs/DELIVERY_UNKNOWN_REDUCTION_PLAN.md`.
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
- **`test:cell-guard`**: automatic cells are accepted, and every mismatch is refused. The migration sequence (section
  7) is also covered:
  - each cell's environment is accepted in every state, forward and backward, including mixed host copies;
  - the earlier plan's unsafe state is refused;
  - transitional rows still pin the static scope and keep scopes disjoint, and malformed rows are refused.
- **`test:auto-assignment` "migration …" tests** (two OS processes): see section 7.4.
  - **Forward**, with an unexpected restart of the static cell in S2: nothing fails, nothing is re-sent, one
    attempt each, and the phones of the cell not restarting never pause 2 s.
  - **Rollback S3 → S1**: the same, and afterwards each static scope is sent by its own cell.
  - **SIGKILL of each cell in S2**: no duplicate, and delivery-unknown only on the killed cells' phones.
- **`test:prepared-broker`**: the dedupe hash is empty after acknowledgement.
- **`test:transport-shards`**: a failed shard's refusal is "not started".

## 7. Production migration plan (cell by cell)

Nothing in this plan has been run. Every step needs the owner's explicit approval at the time, in a low-traffic window,
with the release that contains this change already built and verified (CI green, B13 Gate B evidence for its
`measuredFilesSha256`, G-CLOCK passing on both cells and Host S). Example ids below are today's production layout
(cell-1 `1-4`, cell-2 `5-9` after the phone-9 fix); use the manifest's real values.

### 7.1 Why the order matters

The guard (`deploy/systemd/campaign-cell-guard.sh`) runs at every start, including the restarts systemd makes after
a crash. It refuses (exit 78) a cell whose environment does not match its manifest row. systemd never restarts after
exit 78 (`RestartPreventExitStatus=78`), so a refused cell stays down until someone fixes its files.

An earlier version of this plan first changed both rows to `auto`, then switched cell-2. Until cell-1 was switched
too, an unexpected cell-1 restart would have been refused.

A cell's row and env file cannot be changed atomically, so the manifest now has a transitional value: **`auto|<scope>`**
means the cell may start automatic, or static with exactly that scope. With it, every intermediate state below
accepts **both** cells' current environments.

The release that introduces `auto|<scope>` must already be running on both hosts before any manifest edit, because
earlier guards refuse that value. For the same reason, a code rollback to an earlier release needs the manifest back in
state S0 first.

### 7.2 States

| State | Manifest assignment column (identical file on both hosts) | cell-1 env | cell-2 env | If cell-1 restarts unexpectedly | If cell-2 restarts unexpectedly |
|---|---|---|---|---|---|
| S0 | `1-4`, `5-9` | static `1-4` | static `5-9` | starts static | starts static |
| S1 | `auto\|1-4`, `auto\|5-9` | static `1-4` | static `5-9` | starts static | starts static |
| S2 | as S1 | static `1-4` | `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto` | starts static; cell-2 sends its phones meanwhile, see 7.4 | starts auto |
| S3 | as S1 | auto | auto | starts auto | starts auto |
| S4 | `auto`, `auto` | auto | auto | starts auto | starts auto |

During a manifest step (S0↔S1, S3↔S4) each host's copy is replaced separately. Every combination of old and new
copy is also accepted.

`test:cell-guard` runs the real guard against each cell's environment in every state, forward and backward, and
against mixed host copies. It also proves that the earlier plan's state (both rows `auto`, cell-1 still static) is
refused. These tests fail against the guard without transitional rows.

### 7.3 Steps

On each host, keep a copy of every file before changing it:

```
cp -a /etc/cowabista/cells.manifest /etc/cowabista/rollback/cells.manifest.S0
cp -a /etc/cowabista/cell-cell-N.env /etc/cowabista/rollback/cell-cell-N.env.static
```

**S0 → S1: transitional manifest. No restart.**
1. On both hosts, write the rows `cell-1 <host-c> auto|1-4` and `cell-2 <host-d> auto|5-9` (root:root, 0644).
2. Verify that the copies match: `sha256sum /etc/cowabista/cells.manifest` prints the same hash on both hosts.
   Running cells are unaffected; the guard only reads the manifest at the next start.

**S1 → S2: cell-2 automatic.**
1. On host D, in `/etc/cowabista/cell-cell-2.env`, remove the `CAMPAIGN_TRANSPORT_PHONE_IDS` line and add
   `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto`.
2. Run `systemctl restart campaign-cell@cell-2`. This is a graceful stop: in-flight sends finish, and unsent work is
   requeued with its attempt returned.
3. Verify with `journalctl -u campaign-cell@cell-2 --since -5min`. Expect, in this order:
   - the guard line with `assignment=auto manifest_assignment=auto|5-9`;
   - `Campaign runtime started` with `assignment: "auto"`;
   - `Campaign transport cells changed` with `["cell-2"]`;
   - `Phone lane started on this campaign cell` for cell-2's phones.
4. Expected pause: cell-2's phones pause for the length of its restart (cell-1 is static and cannot cover them).
   Cell-1's phones keep sending.

**S2 → S3: cell-1 automatic.**
1. On host C, make the same env change in `/etc/cowabista/cell-cell-1.env`.
2. Run `systemctl restart campaign-cell@cell-1`.
3. Expected behaviour:
   - while cell-1 restarts, cell-2 takes its phones as soon as their leases are released, so they pause about a
     second;
   - cell-1 then joins;
   - after 5 s of membership plus 15 s minimum hold, cell-2 hands cell-1 its share one phone at a time, each with
     `Phone handed off… drained: true`.
4. Verify: both cells log `Campaign transport cells changed` with both names.

**S3 → S4: finalize the manifest. No restart.**
1. On both hosts, set both assignment columns to `auto`.

### 7.4 What the mixed state S2 does

These behaviours were measured by `test:auto-assignment` ("migration …" tests, two OS processes, real
PostgreSQL and Redis, mock provider):
- **The automatic cell does not touch the static cell's phones while the static cell holds them.** It reads their
  owner instead of acquiring them. Its handoff requests are ignored by a static cell and simply expire.
- **Unexpected graceful restart of the static cell.** The automatic cell takes its phones within one evaluation.
  When the static cell is back it is denied those phones (`Phone ownership held by another runtime`, logged once
  per phone) and idles until S3. No send is duplicated.
- **Capacity.** The automatic cell still takes no phone it lacks capacity for. A phone it refuses stays free, and
  the static cell takes it if the phone is in its scope.
- **SIGKILL of the automatic cell.** Its phones wait for its restart (systemd restarts it after 2 s, plus the 5 s
  lease), and the static cell's phones keep sending.
- **SIGKILL of the static cell.** The automatic cell takes its phones about 6 s after the kill.
- **In-flight work at a kill.** Work the killed cell was handling ends delivery-unknown (Decision 8, unchanged) and
  is never re-sent: 88 jobs across the two kills, at 10 TPS, 2 phones each.
- **Graceful paths cost nothing.** Every forward and rollback step, including an unexpected restart in S2, ended
  with every job Sent once and one attempt each.
- **Measured pauses:**
  - a phone pauses at most about 2.8 s, and only while its own cell restarts;
  - phones not owned by the restarting cell paused less than 2 s (asserted);
  - after a SIGKILL, the pause is about 5.4–6.2 s, bounded by the 5 s lease.

### 7.5 Acceptance after S4, and the proof

1. **Acceptance checks:**
   - both cells own phones;
   - no `Sendable phone has no transport owner` error;
   - `transportOwned: true` on every Active route of a Running campaign;
   - no new delivery-unknown failures and no duplicate in the provider-side message records;
   - per-number sends within Meta's approved TPS.
2. **Proof.** Connect a new phone, or reconnect one, and confirm it is sent without any configuration edit.

Only with separate sending approval: a real campaign on a test audience.

### 7.6 Stop and roll back if

- any `REFUSING START` appears in a cell's journal;
- a cell does not log `Campaign runtime started` within a minute of its restart;
- `Sendable phone has no transport owner` is logged;
- delivery-unknown failures appear without a crash;
- the provider shows any duplicate.

## 8. Rollback

Walk the states backwards, S4 → S3 → S2 → S1 → S0. Each state accepts both cells' environments, so you can stop
at any state and an unexpected restart is harmless.

1. **S4 → S3: manifest back to transitional.** On both hosts, write `auto|1-4` and `auto|5-9`. No restart.
2. **S3 → S2: cell-1 back to static.**
   - In `cell-cell-1.env`, remove `CAMPAIGN_TRANSPORT_ASSIGNMENT` and set `CAMPAIGN_TRANSPORT_PHONE_IDS=1-4`, or
     restore `cell-cell-1.env.static`.
   - Run `systemctl restart campaign-cell@cell-1`.
   - While it restarts, cell-2 covers every phone. Cell-1 comes back static and is denied whatever cell-2 holds
     (logged once per phone) until the next step.
3. **S2 → S1: cell-2 back to static.**
   - In `cell-cell-2.env`, set `CAMPAIGN_TRANSPORT_PHONE_IDS=5-9` again and remove `CAMPAIGN_TRANSPORT_ASSIGNMENT`.
   - Run `systemctl restart campaign-cell@cell-2`.
   - On stop it releases everything, cell-1 takes `1-4`, and cell-2 takes `5-9` when it starts.
4. **Before S1 → S0: check scope coverage.** The static scopes must together cover **every** sendable phone. A phone
   connected during the automatic period may have an id outside both scopes. Within 20 s such a phone is logged as
   `Sendable phone has no transport owner` and shows `transportOwned: false`. If so, add its id to one cell's scope
   in both its env and the manifest row's `auto|` part, and restart that cell, before continuing.
5. **S1 → S0: plain static manifest.** On both hosts, write `1-4` and `5-9`, or restore `cells.manifest.S0`.
6. **Code rollback, only from S0:**
   - the previous release's guard does not accept `auto` or `auto|<scope>`;
   - there is no data or schema to undo;
   - the membership keys expire by themselves (100 s), and handoff requests expire in 3 s;
   - the persistent fence keys are given their old 100 s expiry again by the old code at its next acquisition;
   - the `transportOwned` field is optional, and older clients ignore it.

`test:auto-assignment` runs this rollback (S3 → S2 → S1) with live traffic. Every job is sent once, with one attempt,
and after the rollback each static scope is sent by its own cell.
