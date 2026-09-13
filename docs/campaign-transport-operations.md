# Campaign transport: production cell model and operations

Scope: how the campaign transport runtime is deployed, partitioned, replaced and recovered. Nothing here changes
code paths; it documents what the code at `111e0fe` (last `src/` change) does and what operators must do around it.
Throughput figures are deliberately absent: the only measured number is one isolated cell at about 3,940
provider-start TPS on 4 vCPU, and distributed scaling has not been measured (see
`artifacts/api-server/benchmark/distributed/README.md` for the experiment that will).

## 1. The cell model

- A **cell** is one API server process whose campaign runtime owns a fixed, disjoint set of phone numbers. The
  runtime starts with the server (`startCampaignRuntime()` in `src/index.ts`); there is no separate worker binary.
- Ownership is defined by `CAMPAIGN_TRANSPORT_PHONE_IDS` (phone number ids, e.g. `1-4` or `1,2,3,4,9`). The runtime
  discovers only phones in its scope and takes a fenced Redis lease (fencing token plus 5 s TTL, renewed every tick)
  on each. Every published envelope carries the owner's token; consume, reclaim and settlement all check it.
- Scopes must be **disjoint** across cells. Two cells with overlapping scopes are safe (the lease decides, the loser
  records `ownershipDenials`) but wasteful and non-deterministic; they must be treated as a configuration error.
- **Shared services:** one PostgreSQL (authoritative job state, leases, settlement) and one Redis (ownership, pacing
  timelines, prepared-envelope streams per phone; every key is hash-tagged per phone, so a future Redis Cluster
  needs no code change). Each cell holds 20 claim plus 6 settlement PostgreSQL connections and 2 Redis clients.
- **An unscoped runtime owns every phone it can see.** `CAMPAIGN_TRANSPORT_PHONE_IDS` unset or blank means "all
  phones". There is no runtime-off switch and no scope that owns nothing, so every API replica that is not meant to
  transport must still be prevented from starting unscoped. Until a code change adds an explicit switch (tracked,
  see section 6), the deployment must enforce: every replica sets `CAMPAIGN_TRANSPORT_PHONE_IDS`, the process
  manager refuses to start a replica without it, and no replica is added to the fleet without an assigned scope.
  A replica intended only for HTTP traffic must be given a scope of phone ids that exist and belong to it, or must
  not run this image.

Recommended layout for N cells: cell k owns a contiguous range; a single source of truth (the deployment manifest)
lists `cell -> host -> scope`, and the same manifest is what a replacement reads.

## 2. Starting, restarting and replacing a cell

- **Start:** one process per cell with `DATABASE_URL`, `CAMPAIGN_REDIS_URL` (or `REDIS_URL`),
  `CAMPAIGN_COORDINATOR_MODE=redis`, and `CAMPAIGN_TRANSPORT_PHONE_IDS=<its scope>`. The start log line prints the
  scope; verify it against the manifest.
- **Graceful stop** (SIGTERM): the runtime stops supply, drains in-flight sends, releases its phone leases and
  requeues prepared work that was not sent. A restart of the same cell resumes within one tick of ownership.
- **Hard loss** (crash, OOM, host loss): nothing needs to be done to the data. Start a replacement process with the
  **same scope**. Measured behaviour on the final code: the replacement is denied ownership until the dead lease
  expires (about 5 s), takes over all phones of the scope at about 5.5 s, reclaims the dead consumer's pending
  stream entries in pages and fails them closed as delivery-unknown (they may already have reached the provider),
  requeues the dead process's unread published envelopes (never handed to the provider), and starts sending at
  about 5.5 to 6.5 s after the kill. Jobs the dead process had claimed but not yet published come back after their
  30 s job lease. Zero duplicates and zero lost were observed across 14 kills.
- **Never** start a replacement with a different scope, and never run two live processes with the same scope on
  purpose; the second is denied and logs it, but it adds Redis and PostgreSQL load for nothing.
- **Orchestration:** there is no automatic controller. The process manager (systemd unit per cell, or one pod per
  cell with a restart policy) is the replacement mechanism; its restart must preserve the scope environment.

## 3. Delivery-unknown reconciliation

Every hard loss of a cell converts its in-flight window into `delivery_unknown` outcomes: the message may or may not
have reached the provider, so the job is marked Failed with reason "Provider delivery is unknown after broker
consumer loss" and the `provider_messages` row stays `delivery_unknown`. The at-most-once guard then refuses to
re-send that job automatically (a re-claim fails closed with "manual reconciliation is required"). Observed volume
per kill: 1,035 to 6,301 messages, roughly the acknowledgement debt plus queued work of the four phones.

Procedure after any cell loss:
1. List the affected rows through the campaign engine's delivery-unknown endpoint (organization-scoped) or
   `select ... from provider_messages where status = 'delivery_unknown'` joined to the campaign.
2. For each, check the provider (message status API or webhook history) by recipient and template within the
   outage window. Delivered: record the provider message id as `sent`. Not delivered: the operator may re-send via a
   new campaign job; the original job stays Failed for audit.
3. Do not bulk-requeue delivery-unknown jobs; that is exactly the duplicate path the guard exists to block.

## 4. Redis: persistence, loss and the operator procedure

Redis holds ownership leases (5 s), pacing timelines and the per-phone streams of prepared envelopes. PostgreSQL
is authoritative for every job; Redis loss never loses a job, but it can **stall** phones until the cells restart:
an envelope already published to a stream that Redis then loses is kept alive by its owner's lease renewal (the
owner renews the leases of everything it published until it consumes it, with no age limit), so those jobs stay
Processing and unsent while that process lives. This is a known, tracked gap in the code (section 6); the
deployment controls below make it operationally safe.

Deployment-only controls (no code change):
- Run Redis with `appendonly yes` and `appendfsync everysec` (or RDB every minute at minimum) so a restart replays
  the streams and leases; without persistence every Redis restart is a data loss event.
- Prefer a replica with automatic failover; a promoted replica that lagged is still a partial loss and must be
  handled as loss.
- Alert on: Redis restart or role change, `connected_clients` dropping below 2 × cells, stream length growing on any
  phone while its owner's provider starts are zero, and `ownershipDenials` increasing on any cell.

Operator procedure after ANY Redis data loss (full flush, restart without persistence, failover to a stale
replica): treat it as a full loss.
1. Stop every cell (SIGTERM, wait for exit). Stopping releases in-memory state; leases in PostgreSQL then expire
   within 30 s.
2. `FLUSHALL` on the (new) Redis so no stale stream entries, leases or pacing cursors survive.
3. Start every cell with its scope. The lease reaper requeues the expired leases; published-but-lost envelopes are
   re-claimed and sent once (the provider-reservation guard fails closed any job whose earlier attempt had already
   reached the provider). Expect a burst of claims and, for any job that was mid-send at the loss, a
   delivery-unknown entry to reconcile per section 3.
4. Verify: every cell logs its scope and ownership, `ownershipDenials` stays at 0, no stream keeps a non-zero
   pending count with an idle consumer, and no campaign keeps `processing > 0` with all its jobs terminal.

## 5. PostgreSQL and monitoring

- Sizing measured on one cell: about 0.11 to 0.15 cores per 1K TPS, 2.7 to 3.4 KB WAL per message, 0.03 to
  0.05 commits per message, 2 to 3 tuple updates per message. Connection budget: 26 per cell plus one replacement
  plus tooling; set `max_connections` accordingly or front with a pooler.
- Alert on: lock waiters on `campaigns` rows sustained above a handful (settlement contention), campaigns whose
  jobs are all terminal but whose status is still Running (should no longer occur after `111e0fe`; alert anyway),
  `campaign_metric_deltas` growing without bound (flush stalled), and jobs Processing past their lease expiry for
  more than a minute (reaper stalled).
- Per cell, from `/healthz` and the runtime metrics: provider starts per second per phone against the 1,000/s
  ceiling, `ownershipDenials`, `brokerRecovered` (non-zero only during recovery), `settlementBackpressureEvents`,
  `reservoirStarvationEvents`, lane `brokerDepth`, RSS.

## 6. Tracked, not fixed (status and severity)

| Item | Status | Severity | Note |
|---|---|---|---|
| Redis loss keeps published-but-lost envelopes leased until the owner restarts | inferred from code, not reproduced | P1 | Deployment controls in section 4; code fix (bounded renewal or reconcile `published` against the stream) deferred until after the distributed baseline |
| No runtime-off switch; unscoped replica owns all phones | proven (code) | P1 (deployment safety) | Deployment must enforce scopes (section 1); a small startup guard is the future code fix |
| Consumed-but-unsent envelopes are not lease-renewed; a provider stall beyond about 25 s makes another cell's reaper requeue them, ending in fail-closed, never a duplicate | inferred | P2 | Monitor lane queue age |
| Per-campaign settlement serializes on the campaign row across cells | inferred from single-process timings (13 to 29 ms plus 0.15 to 0.19 ms per job per batch), unmeasured across cells | P1 for a single campaign above ~5K/s, none for aggregate | Experiment B measures it |
| No automatic replacement controller | proven (absent) | P2 | Process manager per cell (section 2) |
| Delivery-unknown needs manual reconciliation | proven, measured 1,035 to 6,301 per kill | P2 | Section 3; provider-side status reconciliation is a future feature |
| `retry_count` counter: recount defines it as attempts − 1, delta path counts provider retries only | proven | P3 | Reporting only |
