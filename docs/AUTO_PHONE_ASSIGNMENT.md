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

The runtime refuses `auto` together with a scope. The guard additionally checks the manifest's third column: `auto`,
the static scope, or `auto|<scope>` while migrating (section 7).

### 3.2 How the cells agree (`src/services/campaign-phone-assignment.ts`)

- **Membership.** Every second each cell refreshes its name in the Redis sorted set
  `campaign:cells:{campaign-cells}:members`. The score is an expiry computed on Redis `TIME`, and the TTL is 5 s, so
  a killed cell drops out by itself. A graceful stop removes the cell once its transport has drained (up to 10 s),
  then releases its phones.
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
  - the transitional manifest value `auto|<scope>` and a dry-run mode for candidate files (section 7);
  - unit, manifest and env examples now default to `auto`.
- `campaign-runtime.ts`, `campaign-phone-reservoir.ts` (`quiesce`):
  - a graceful stop first stops claiming and admitting, then waits up to 10 s for sends already in transport to
    finish, and only then aborts what is left. Before, the stop aborted HTTP calls in flight, and each ended
    delivery-unknown.
- `whatsapp-provider.ts`:
  - mock-only test seam `CAMPAIGN_TEST_PROVIDER_DELAY_MS` (a provider latency that honours the abort signal).
- Gate B:
  - `campaign-phone-assignment.ts` and `campaign-phone-scope.ts` are now measured and required by the scope check.

## 5. Not changed, and known limits

- **Crash ambiguity is unchanged (Decision 8).** When a cell is killed, the work it had consumed may already have
  reached the provider. That work fails as delivery-unknown for manual reconciliation and is never re-sent.
  - Bounded by TPS × 3 s per phone the dead cell owned; measured in the failover test at about 1.8–2.6 s of those
    phones' traffic.
  - A graceful stop no longer adds to it: it waits up to 10 s for sends already in transport (section 4).
  - The prioritised plan to shrink it before very high sustained TPS is in `docs/DELIVERY_UNKNOWN_REDUCTION_PLAN.md`.
- **Mixed code versions keep an old duplicate window (feature/rocket-crash-ambiguity).** At c979cd8 (and on
  `wabista-nexus-v2`) re-preparation treats only a `sent` intent as already accepted. A job whose cell died after the
  provider accepted it, and whose intent a status webhook then moved to `delivered`, `read` or `failed`, is sent a
  second time when a cell on that code re-prepares it. The fix replays any intent with a provider message id, but
  only cells running it apply it: while any cell runs the old code, a phone that cell takes over keeps the window.
  Upgrade every cell before relying on the fix.
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
- **`test:cell-guard`** (14 tests, the real guard script): automatic cells are accepted, and every mismatch is
  refused. The migration sequence (section 7) is also covered:
  - each cell's environment is accepted in every state, forward and backward, including mixed host copies;
  - the earlier plan's unsafe state is refused;
  - transitional rows still pin the static scope and keep scopes disjoint, and malformed rows are refused;
  - the widened rollbacks of section 8 are accepted at every step, including mixed host copies:
    - phone 10 added at S4 → S3;
    - phone 10 added during S2, widened on cell-2's row only.
  - Widening a static cell's row is refused.
  - **Dry run:**
    - it accepts a valid candidate without contacting any service, and refuses an invalid one with exit 78;
    - with an env file, it reads single-line assignments as systemd does, and never executes the file. Comment
      lines, the last assignment winning, whitespace around key and value, and single and double quotes each decide
      a test verdict;
    - it refuses a file that sets both variables, and a line systemd would join with the next one.
  - **Mutation check:**
    - against the guard without transitional rows (`0202bc2`), tests 4, 5 and 7–14 fail: tests 4 and 5 on the
      changed refusal wording, and tests 13 and 14 because that guard has no dry run;
    - against the first dry-run guard (`93c6252`), and the one before the joined-line refusal (`46877f4`), test 13
      fails;
    - so do guards that stop trimming the key, removing double quotes or refusing joined lines.
- **`test:auto-assignment` "migration …" and graceful tests** (two OS processes, test timings in section 7.5):
  - **Forward**, with an unexpected restart of the static cell in S2: nothing fails, nothing is re-sent, one
    attempt each, and the phones of the cell not restarting never pause 2 s.
  - **Rollback S3 → S1**, with a phone connected while the fleet was automatic and added to cell-1's widened scope:
    the same, every phone pauses under 5 s, and afterwards each static scope is sent by its own cell.
  - **SIGKILL of each cell in S2**: no duplicate. Every delivery-unknown job is one the killed cell still held at
    its kill (claimed by that process and not settled, read from the database right after the kill). Each kill is
    counted and bounded separately, and the held jobs are on that cell's own phones.
  - **Graceful restart with 400 ms provider latency**: every send in flight at SIGTERM finishes, so every job is
    Sent once with one attempt. Before the drain was added, this test failed with "Provider delivery is unknown;
    manual reconciliation is required".
- **`test:prepared-broker`**: the dedupe hash is empty after acknowledgement.
- **`test:transport-shards`**: a failed shard's refusal is "not started".

## 7. Production migration plan (cell by cell)

Nothing in this plan has been run. Every step needs the owner's explicit approval at the time, in a low-traffic window.
Example ids are today's production layout (cell-1 `1-4`, cell-2 `5-9` after the phone-9 fix); use the manifest's real
values. Hosts are `<host-c>` (cell-1) and `<host-d>` (cell-2).

### 7.1 Why the order matters

The guard (`deploy/systemd/campaign-cell-guard.sh`) runs at every start, including restarts after a crash. It refuses
(exit 78) a cell whose environment does not match its manifest row. A refused cell does not run until its files are
fixed. systemd retries a refused `ExecStartPre` every 2 s, and leaves the unit `failed` after 10 attempts (about
21 s). This was verified on systemd 255 (`docs/G78_SYSTEMD_VERIFICATION.md`). After fixing the files, run
`systemctl reset-failed campaign-cell@cell-N` and start it again: a plain start within 5 minutes is refused.

An earlier version of this plan first changed both rows to `auto`, then switched cell-2. Until cell-1 was switched
too, an unexpected cell-1 restart was refused.

A row and an env file cannot be changed atomically together, so the manifest has a transitional value,
**`auto|<scope>`**: the cell may start automatic, or static with exactly that scope. With it, every state below
accepts **both** cells' current environments.

The guard can check a candidate before it is installed (7.3): `CAMPAIGN_CELL_GUARD_DRY_RUN=1` runs only the assignment
and manifest checks, against any env and manifest you point it at. It prints `DRY-RUN OK …` or the refusal a real
start would give. It starts nothing and contacts no service.

### 7.2 States

| State | Manifest assignment column (identical file on both hosts) | cell-1 env | cell-2 env |
|---|---|---|---|
| S0 | `1-4`, `5-9` | static `1-4` | static `5-9` |
| S1 | `auto\|1-4`, `auto\|5-9` | static `1-4` | static `5-9` |
| S2 | as S1 | static `1-4` | `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto` |
| S3 | as S1 | auto | auto |
| S4 | `auto`, `auto` | auto | auto |

In every state, an unexpected restart of either cell starts it again: static where its env is static, automatic
where it is automatic. During a manifest step (S0↔S1, S3↔S4) each host's copy is replaced separately, and every
combination of old and new copy is accepted too.

`test:cell-guard` runs the real guard against each cell's environment in every state, forward and backward,
including mixed host copies and the widened rollback of section 8. It also proves that the earlier plan's state is
refused, and that the tests fail against the guard without transitional rows.

### 7.3 How every change is made (both directions)

1. **Backups, once, on each host:**
   ```
   install -d -m 0700 -o root -g root /etc/cowabista/rollback
   cp -a /etc/cowabista/cells.manifest /etc/cowabista/rollback/cells.manifest.S0
   cp -a /etc/cowabista/cell-cell-N.env /etc/cowabista/rollback/cell-cell-N.env.S0
   ```
   These are the record of the starting point. **Never restore them wholesale later:** a scope widened, or a secret
   or host changed, during the automatic period would be reverted with them. Every later edit changes only the
   assignment column, or the two assignment variables of the current files.
2. **Prepare each new file as a candidate next to the live one.** Copy the live file with its owner and mode,
   then edit only the copy:
   - manifest (root:root 0644):
     `cp -p /etc/cowabista/cells.manifest /etc/cowabista/.cells.manifest.next`, then change the assignment column;
   - env file (root:cowabista 0640):
     `cp -p /etc/cowabista/cell-cell-N.env /etc/cowabista/.cell-cell-N.env.next`.
   
   An env change always swaps both variables in the one file:
   - to automatic:
     ```
     sed -i -E '/^[[:space:]]*CAMPAIGN_TRANSPORT_PHONE_IDS[[:space:]]*=/d' /etc/cowabista/.cell-cell-N.env.next
     printf '\nCAMPAIGN_TRANSPORT_ASSIGNMENT=auto\n' >> /etc/cowabista/.cell-cell-N.env.next
     ```
   - to static, with the static part of the cell's row (for example `1-4`):
     ```
     sed -i -E '/^[[:space:]]*CAMPAIGN_TRANSPORT_ASSIGNMENT[[:space:]]*=/d' /etc/cowabista/.cell-cell-N.env.next
     printf '\nCAMPAIGN_TRANSPORT_PHONE_IDS=1-4\n' >> /etc/cowabista/.cell-cell-N.env.next
     ```
   - Then check that
     `grep -E '^[[:space:]]*CAMPAIGN_TRANSPORT_(ASSIGNMENT|PHONE_IDS)[[:space:]]*=' /etc/cowabista/.cell-cell-N.env.next`
     prints exactly the one new line.
   - A file with neither variable, or with both, is refused.
3. **Dry-run the guard on each host for its cell, as the service user,** against the candidates (or the live file
   where nothing changes).
   ```
   runuser -u cowabista -- env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin CAMPAIGN_CELL=cell-N \
     CAMPAIGN_CELL_MANIFEST=/etc/cowabista/.cells.manifest.next \
     CAMPAIGN_CELL_GUARD_ENV_FILE=/etc/cowabista/.cell-cell-N.env.next \
     CAMPAIGN_CELL_GUARD_DRY_RUN=1 /opt/cowabista/deploy/systemd/campaign-cell-guard.sh
   ```
   - **What the guard does with the files:**
     - it reads the two assignment variables from the env file as systemd's `EnvironmentFile=` reads single-line
       assignments, and never executes the file;
     - it refuses a line systemd would join with the next one (trailing backslash, open quote), which the env-file
       format of `deploy/cutover/RUNBOOK.md` section 9 forbids anyway;
     - running as `cowabista`, as the unit does, it refuses a manifest the cell could not read;
     - it starts nothing and contacts no service.
   - **Expect** `DRY-RUN OK host=<this host> assignment=… manifest_assignment=… env=…`.
   - **For a manifest step,** run it on **both** hosts with each cell's live env file.
   - **For an env step,** run it with the new env file and with the live one, so that both are accepted.
4. **Install by atomic rename on the same filesystem:**
   `mv -f /etc/cowabista/.cells.manifest.next /etc/cowabista/cells.manifest`, and the same for an env file.
   Never edit a live file in place: two `sed -i` runs, or an editor save in between, leave a half-changed file for
   a restart to meet.
5. **After every install, check:**
   - `stat -c '%U:%G %a %n' /etc/cowabista/cells.manifest /etc/cowabista/cell-cell-N.env` prints
     `root:root 644` and `root:cowabista 640`;
   - after a manifest install, `sha256sum /etc/cowabista/cells.manifest` prints the same hash on both hosts.

### 7.4 Forward steps

**Step A: the release, with static scopes unchanged.**
1. Deploy the release that contains this change on both hosts, with static env files (`deploy/README.md` section
   5). Earlier guards refuse `auto|<scope>`, so no manifest step may start while either host runs an earlier
   checkout.
2. Verify, as root on each host: `git -C /opt/cowabista rev-parse HEAD` prints the release sha. The guard runs as
   `cowabista` and may print `commit=unknown` for a root-owned checkout.
3. Verify the cell's journal shows the guard line with `assignment=static scope=… manifest_assignment=…` (only this
   release's guard prints `manifest_assignment`) and `Campaign runtime started`.
4. Verify there is no `Sendable phone has no transport owner` error after a minute.

**S0 → S1: transitional manifest. No restart.**
1. Candidate rows: `cell-1 <host-c> auto|1-4` and `cell-2 <host-d> auto|5-9`.
2. Follow 7.3: dry-run on both hosts with the current static envs, install on both hosts, and compare hashes.

**S1 → S2: cell-2 automatic.**
1. On host D, candidate env = current env with `CAMPAIGN_TRANSPORT_PHONE_IDS` removed and
   `CAMPAIGN_TRANSPORT_ASSIGNMENT=auto` added.
2. Dry-run it, then install it (7.3).
3. Run `systemctl restart campaign-cell@cell-2`.
   - **Graceful stop:** the cell stops claiming and admitting work and lets sends already in transport finish.
     That takes at most 10 s. A send still in transport then is aborted and logged (`Campaign runtime stopping
     with sends still in transport`, section 7.7).
   - **Unsent work:** work never handed to transport is requeued with its attempt returned.
   - **Expected pause:** cell-2's phones pause for the stop plus start. Cell-1 is static and cannot cover them.
     Cell-1's phones keep sending.
4. Verify with `journalctl -u campaign-cell@cell-2 --since -5min`, in order:
   - the guard line with `assignment=auto manifest_assignment=auto|5-9`;
   - `Campaign runtime started` with `assignment: "auto"`;
   - `Campaign transport cells changed` with `["cell-2"]`;
   - `Phone lane started on this campaign cell` for cell-2's phones.

**S2 → S3: cell-1 automatic.**
1. Make the same env change on host C, with dry-run and install.
2. Run `systemctl restart campaign-cell@cell-1`.
3. Expected behaviour:
   - while cell-1 stops, cell-2 takes cell-1's phones as their leases are released (within one 500 ms
     evaluation, plus refill);
   - cell-1 then joins;
   - cell-2 hands cell-1 its share by graceful handoff, one phone at a time, each logged
     `Phone handed off… drained: true`.
   - A phone can move once cell-1 has been a member for 5 s **and** cell-2 has held that lane for 15 s, whichever
     comes later, then at most one handoff start every 2 s.
4. Verify: both cells log `Campaign transport cells changed` with both names.

**S3 → S4: finalize the manifest. No restart.**
1. Candidate rows: both `auto`.
2. Follow 7.3 (dry-run on both hosts with the automatic envs, install, compare hashes).

### 7.5 What the mixed state S2 does, and what the tests show

These behaviours come from the code and are exercised by `test:auto-assignment` ("migration …" tests).

**Test conditions:**
- two OS processes, real PostgreSQL and Redis, mock provider, 10 TPS per phone;
- shortened assignment timings: membership TTL 1.5 s, evaluation 200 ms, join 1 s, minimum hold 1.5 s, fallback
  0.5 s. Production uses 5 s, 500 ms, 5 s, 15 s and 2 s.

Each item below gives what the tests assert and what was observed in individual runs.

- **The automatic cell does not take the static cell's phones while the static cell holds them.** It reads their
  owner instead of acquiring them. Its handoff requests are ignored by a static cell and simply expire.
- **Unexpected graceful restart of the static cell:**
  - the automatic cell takes its phones within one evaluation;
  - when the static cell is back it is denied them and idles until S3 (`Phone ownership held by another runtime`,
    info level, once per phone; expected here);
  - no send is duplicated;
  - asserted: those phones pause under 5 s, and the automatic cell's own phones under 2 s.
- **Capacity:** the automatic cell takes no phone it lacks capacity for. A phone it refuses stays free and is
  taken by the static cell if it is in that cell's scope. This comes from the code (`test:assignment-runtime` R2
  covers the refusal); no migration test exercises it.
- **SIGKILL of the automatic cell:** its phones wait for its restart and the end of its 5 s leases, which overlap.
  The static cell's phones keep sending (asserted under 2 s).
- **SIGKILL of the static cell:** the automatic cell takes its phones once their leases expire.
  - asserted: under 12 s;
  - observed: 5.3–8.1 s.
- **In-flight work at a kill:** work the killed cell still held (claimed and not settled) ends delivery-unknown
  (Decisions 2 and 8, unchanged) and is never re-sent.
  - Asserted: every delivery-unknown job is one the killed cell held at its kill, and each kill stays within that
    cell's phones × TPS × 3 s.
  - Observed: 88–108 for the two kills over nine runs, and 44–58 per kill. In the last four runs, which count both,
    401 of the 402 jobs the killed cells held ended delivery-unknown.
- **Graceful paths cost nothing, including with latency.** Every forward and rollback step, including the
  unexpected restart in S2, ends with every job Sent once and one attempt each (asserted).
  - With a 400 ms provider latency, sends in flight at SIGTERM finish during the stop (asserted: zero
    delivery-unknown). Observed stop time: 1.2–2.6 s (three runs).
  - Before this change the stop aborted those HTTP calls, and every such send ended delivery-unknown.
- **Pauses:**
  - phones of a restarting static cell: observed up to 2.8 s in tests, plus the production start time
    (asserted under 5 s);
  - phones not owned by the restarting cell: asserted under 2 s;
  - after a SIGKILL: observed 5.3–8.1 s, set by the 5 s lease.

### 7.6 Acceptance after S4, and the proof

1. **Acceptance checks:**
   - both cells own phones;
   - no `Sendable phone has no transport owner` error;
   - `transportOwned: true` on every Active route of a Running campaign;
   - no new delivery-unknown failures without a crash, and no duplicate in the provider-side message records;
   - per-number sends within Meta's approved TPS.
2. **Proof.** Connect a new phone, or reconnect one, and confirm it is sent without any configuration edit.

Only with separate sending approval: a real campaign on a test audience.

### 7.7 Stop, recover and roll back if

**Signals:**
- any `REFUSING START` or `DRY-RUN` refusal;
- a cell that does not log `Campaign runtime started` within a minute of its restart;
- `Sendable phone has no transport owner`;
- delivery-unknown failures without a crash;
- any duplicate at the provider;
- `Campaign runtime stopping with sends still in transport` (a stop that hit its 10 s bound).

**Recovering a refused cell:** restore the last accepted file through 7.3, then run
`systemctl reset-failed campaign-cell@cell-N` and `systemctl start campaign-cell@cell-N`.

## 8. Rollback

Walk the states backwards. Each state accepts both cells' environments. Every change goes through 7.3 (candidate,
dry run, atomic install, hash check).

**Rule: widen a row only while its cell is automatic.** A widened `auto|<scope>` row accepts an automatic cell, but
the static cell whose row it is would be refused at its next restart. Widening a static cell's row has no safe order:
the guard refuses either the env or the row in between, and `test:cell-guard` proves it.

1. **S4 → S3: decide the static scopes first, while both cells are still automatic.**
   - A phone connected during the automatic period may be in neither original scope.
   - List every Connected phone id, read-only, as the operator: `select id from phone_numbers where status =
     'Connected' order by id;`.
   - Split them into two disjoint scopes that together cover every id. Usually the original scopes, plus each new id
     added to one of them, for example `1-4,10` and `5-9`.
   - Candidate rows: `auto|1-4,10` and `auto|5-9`.
   - An automatic cell accepts any `auto|<scope>` row, so widening here is safe.
   - **Rolling back from S2 instead** (cell-1 still static): a phone connected since S1 is held by cell-2. Widen only
     cell-2's row (for example `auto|5-9,10`) before step 3, while cell-2 is still automatic. `test:cell-guard`
     covers this order.
2. **S3 → S2: cell-1 static.**
   - Candidate env = current env with `CAMPAIGN_TRANSPORT_ASSIGNMENT` removed and
     `CAMPAIGN_TRANSPORT_PHONE_IDS=<the static part of cell-1's row>` added. Dry run, install,
     `systemctl restart campaign-cell@cell-1`.
   - While cell-1 restarts, cell-2 (automatic) covers every phone. Cell-1 comes back static and is denied whatever
     cell-2 holds until the next step (expected).
3. **S2 → S1: cell-2 static.** Make the same change with the static part of cell-2's row, then
   `systemctl restart campaign-cell@cell-2`. On stop, cell-2 releases everything, and cell-1 takes its own scope at
   once. Cell-2's scope pauses for cell-2's stop plus start, as in the forward S1 → S2 step: cell-1 is static and
   cannot cover it.
4. **S1 → S0: drop the prefix.**
   - Candidate = current manifest with `auto|` removed:
     `cp -p /etc/cowabista/cells.manifest /etc/cowabista/.cells.manifest.next` and then
     `sed -i -E 's/[[:space:]]auto\|/ /' /etc/cowabista/.cells.manifest.next`.
   - The widened scopes carry over. Dry run on both hosts, install, compare hashes. Do not restore
     `cells.manifest.S0` if any scope changed.
5. **Code rollback, only from S0:**
   - the earlier release's guard refuses `auto` and `auto|<scope>` (`deploy/README.md` section 13);
   - there is no data or schema to undo;
   - the membership keys expire by themselves (100 s), and handoff requests expire in 3 s;
   - the persistent fence keys are given their old 100 s expiry again by the old code at its next acquisition;
   - the `transportOwned` field is optional, and older clients ignore it.

`test:auto-assignment` runs this rollback (S3 → S2 → S1) with live traffic and a phone connected while the fleet
was automatic:
- the phone is covered by the widened scope;
- every job is sent once, with one attempt;
- every phone pauses under 5 s (with the test timings; in production add the cell's start time);
- afterwards each static scope, the widened one included, is sent by its own cell.
