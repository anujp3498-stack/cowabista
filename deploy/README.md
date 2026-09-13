# Campaign transport: production deployment and operations runbook

Deployment layer for the frozen transport (production `src/` at `111e0fe`). Everything here is configuration and
procedure; no application, test or benchmark code is changed by it. The concepts (cell model, delivery-unknown,
Redis loss) are explained in `docs/campaign-transport-operations.md`; this file is the operator's step list.
The measurement runbook is separate and unchanged: `docs/campaign-distributed-baseline-runbook.md`.

Deployment model: the repository runs the API server as a bare Node process (`node ./dist/index.mjs`), so cells
are systemd template instances on dedicated hosts. A pod-per-cell layout is equivalent as long as it preserves the
same invariants: one process per cell, an explicit scope that is refused when absent, one cell per node, graceful
SIGTERM with a long stop timeout, and the same manifest as the single source of truth.

## 1. Cells, scopes and hosts

| Cell (systemd instance) | Host | `CAMPAIGN_TRANSPORT_PHONE_IDS` | Resources |
|---|---|---|---|
| `cell-1` | Host C | `1-4` | 4 vCPU / 4 GB, nothing else running |
| `cell-2` | Host D | `5-8` | 4 vCPU / 4 GB, nothing else running |
| shared | Host S | PostgreSQL 16 on 5432, Redis 7 on 6379 | dedicated CPU and disk |

The fleet manifest `/etc/cowabista/cells.manifest` (`deploy/systemd/cells.manifest.example`) lists
`cell host scope` and is installed identically on every transport host. A cell refuses to start unless its
environment scope equals its manifest line, the manifest names this host for it, no other cell shares a phone,
and no other cell is assigned to or running on this host.

## 2. Safety guard (fail closed)

`deploy/systemd/campaign-cell-guard.sh` runs as `ExecStartPre` of every cell and exits 78 (no restart) when:
- `CAMPAIGN_TRANSPORT_PHONE_IDS` is unset, blank or malformed. The application would otherwise own every phone it
  can see; there is no in-code switch, so the guard is the enforcement point (tracked item in the operations doc).
- the scope differs from the manifest, overlaps another cell, or the manifest puts another cell on this host;
- another `campaign-cell@*` unit is active on this host;
- `NODE_ENV` is not `production`, `CAMPAIGN_COORDINATOR_MODE` is not `redis`, `DATABASE_URL`, the Redis URL or
  `PORT` is missing, or a name listed in `CAMPAIGN_CELL_REQUIRED_ENV` is empty;
- PostgreSQL (`pg_isready`) or Redis (`PING`) does not answer within `CAMPAIGN_CELL_WAIT_SECONDS` (default 60).

On success it prints one line to the journal with host, scope, phone count, shard count, port, Node version,
checkout commit and the redacted service URLs, before the process starts. The application then logs
`Campaign runtime started` with `phoneScope`; both lines must show the manifest scope. Verified behaviour of the
guard (pass case and 19 refusal cases) is recorded in the commit that added it.

## 3. Install (transport hosts C and D)

1. OS with systemd, NTP (chrony) synchronised within 50 ms, Node 22, pnpm, `postgresql-client` (for
   `pg_isready`), `redis-tools` (for `redis-cli`), git.
2. `useradd -r -s /usr/sbin/nologin cowabista`; checkout at `/opt/cowabista` at the release commit:
   `git clone <repo> /opt/cowabista && git -C /opt/cowabista checkout <release sha>`; then
   `cd /opt/cowabista && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build`
   (produces `artifacts/api-server/dist/index.mjs` and the shard worker bundle next to it).
3. `install -m 0644 deploy/systemd/campaign-cell@.service /etc/systemd/system/` and `systemctl daemon-reload`.
4. `mkdir -p /etc/cowabista`; install the manifest as `/etc/cowabista/cells.manifest` (root:root 0644) and the
   cell's env file as `/etc/cowabista/cell-<cell>.env` (root:cowabista 0640) from `cell-1.env.example` /
   `cell-2.env.example` with real values. Secrets (database password, Redis password, Clerk keys, Meta app
   secret, webhook verify token) live only in that file.
5. Confirm the host is otherwise idle (`top`: no process above a few percent) and that neither `postgres` nor
   `redis-server` runs locally.

## 4. Configure

Environment variables per cell (all in the env file unless fixed by the unit):

| Variable | Set by | Value |
|---|---|---|
| `CAMPAIGN_TRANSPORT_PHONE_IDS` | env file | the cell's scope, must equal the manifest |
| `CAMPAIGN_CELL` | unit (`%i`) | cell name, used by the guard to find its manifest line |
| `NODE_ENV` | unit | `production` (makes the app require the Redis coordinator and broker) |
| `CAMPAIGN_COORDINATOR_MODE` | unit | `redis` |
| `DATABASE_URL` | env file | `postgresql://cowabista:<pw>@host-s:5432/cowabista` |
| `CAMPAIGN_REDIS_URL` | env file | `redis://:<pw>@host-s:6379` (`REDIS_URL` is the accepted fallback name) |
| `PORT` | env file | HTTP port of this process |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `META_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | env file | HTTP side of the same process |
| `CAMPAIGN_CELL_REQUIRED_ENV` | env file, optional | names the guard must also find non-empty |
| `CAMPAIGN_TRANSPORT_SHARDS` | optional | shard worker threads, default 8 (max 16); the measured configuration used the default. Do not change it for a release without a measurement. |
| `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, `API_RATE_LIMIT_MAX_PER_MINUTE`, `CAMPAIGN_PLATFORM_MAX_TPS` | optional | HTTP and platform settings, unrelated to the cell model |

Resource limits and CPU (from the unit): `CPUAffinity=0-3` (the whole process on the host's four CPUs),
`MemoryHigh=3G`, `MemoryMax=3584M`, `TasksMax=4096`, `LimitNOFILE=65536`. Connection budget per cell: 20
claim/supply plus 6 settlement PostgreSQL connections and 2 Redis clients.

Shard CPU assignment: the runtime runs its transport shards as worker threads inside the one process; the kernel
schedules them across the four CPUs. Production does not pin individual threads. The benchmark kit pins "the
four busiest non-main threads" to one CPU during measurement as a measurement aid, using a load-dependent
heuristic that is not reliable at idle start; it is not part of the production unit. What production requires
is only what the unit provides: a dedicated 4-vCPU host per cell with nothing else competing.

## 5. Start, verify, stop, restart

Start order: Host S services first (PostgreSQL, then Redis; the Redis service must have finished loading its
append-only file before cells start, which the guard's PING wait covers), then `cell-1`, then `cell-2`.

```
# Host C                                   # Host D
systemctl enable --now campaign-cell@cell-1   systemctl enable --now campaign-cell@cell-2
journalctl -u campaign-cell@cell-1 -n 50      journalctl -u campaign-cell@cell-2 -n 50
```

Verify after every start:
1. The guard line `campaign-cell[cell-1] OK host=... scope=1-4 phones=4 ...` and the application line
   `Campaign runtime started` with `phoneScope: "1-4"` (cell 2: `5-8`).
2. `curl -s http://localhost:$PORT/healthz` returns 200 with `campaignRuntime.status` `ok`.
3. Ownership in Redis, from Host S or M, one owner key per phone in scope: `redis-cli -u $REDIS KEYS
   '{campaign-owner:*:1}'` through `:4` exist with a TTL of at most 5 s and refresh continuously; each stream
   `campaign:prepared:{phone:N}` shows exactly one consumer in `XINFO CONSUMERS ... campaign-prepared-v1`, and
   the consumers of phones 1-4 share one runtime id, those of 5-8 another.
4. No ownership denials: the cell's logs show no denial warnings after the first tick (denials are expected only
   while a previous owner's lease is still live, i.e. the first ~5 s of a replacement).

Stop (graceful): `systemctl stop campaign-cell@cell-1`. SIGTERM makes the runtime stop supply, drain in-flight
sends, release its phone leases and requeue unsent prepared work; the unit allows 90 s. Restart:
`systemctl restart campaign-cell@cell-1` is stop then start; the same cell resumes ownership within one tick.

Rolling a new release: stop `cell-1`, update the checkout (`git checkout <sha>`, `pnpm install
--frozen-lockfile`, build), start `cell-1`, verify as above, then the same on Host D. Never run two different
commits on the same scope at once; the guard prints the commit so the journal shows which one each cell runs.

## 6. Replacement of a dead cell (hard loss)

Sequence, with the measured timings from the final code (14 kills, zero duplicates, zero lost):

```
dead cell (crash, OOM, host loss)
  -> its phone leases stop being renewed; the ownership TTL (5 s) expires
  -> replacement starts with the SAME cell name and SAME scope (manifest unchanged, or only its host column changed)
  -> the replacement is denied ownership until the TTL expires (~5 s), then takes over every phone of the scope
  -> it reclaims the dead consumer's pending stream entries in pages and fails them closed as delivery-unknown
  -> it requeues the dead process's unread published envelopes (never handed to the provider)
  -> normal sending resumes on the scope (first provider start ~5.5-6.5 s after the kill)
  -> jobs the dead process had claimed but not yet published return after their 30 s job lease
```

Procedure:
1. Same host still alive: systemd restarts the unit automatically (`Restart=always`, 2 s). Nothing to do but
   verify (section 5) and reconcile delivery-unknown (section 9).
2. Host lost: on the standby machine, install as in section 3, edit ONLY the host column of the dead cell's line
   in the manifest on every host, install the same env file (same scope), and `systemctl start
   campaign-cell@<cell>`. The guard refuses any other scope for that cell name.
3. Never start the replacement with a different scope, never leave two live processes on one scope (the second
   is denied and only adds load), and never split a scope between two cells to "share" the recovery.
4. Verify ownership (section 5 step 3), then run the delivery-unknown reconciliation (section 9).

## 7. Redis (Host S)

Configuration: `deploy/redis/redis.conf`. Mandatory settings and why:
- `appendonly yes`, `appendfsync everysec`, `save 60 1` and `stop-writes-on-bgsave-error yes`: a restart replays
  streams, leases and pacing with at most about a second of loss. Without persistence every restart is a full
  data loss (section 8).
- `maxmemory-policy noeviction`: an evicted stream entry is a published job that its owner keeps leased and never
  sends; eviction is a silent stall.
- `requirepass`, `bind` and `protected-mode`: only the cells and tooling reach it.

Startup order and health: start Redis before the cells; the guard waits for `PING`. Health check:
`redis-cli -u $REDIS PING` is `PONG`, `INFO persistence` shows `aof_enabled:1`, `aof_last_write_status:ok`,
`rdb_last_bgsave_status:ok`, and `INFO replication` shows the expected `role`. Replica with automatic failover is
preferred; a promoted replica that lagged is a partial loss and is handled as loss.

Alert on: restart or role change, `connected_clients` below 2 × cells, `used_memory` approaching `maxmemory`,
`rejected_connections` or `aof_last_write_status` not `ok`, latency events (`LATENCY LATEST`), any stream
`XLEN` growing on a phone whose owner reports no provider starts, and ownership denials on any cell.

## 8. Redis data-loss response

Treat any of these as full loss: flush, restart without persistence, failover to a stale replica, corrupted AOF.
Follow `docs/campaign-transport-operations.md` section 4 exactly:
1. `systemctl stop campaign-cell@cell-1` and `@cell-2` (graceful; wait for exit). Job leases in PostgreSQL then
   expire within 30 s.
2. `FLUSHALL` on the (new) Redis so no stale streams, leases or pacing cursors survive.
3. Start `cell-1`, then `cell-2`. The lease reaper requeues expired leases; published-but-lost envelopes are
   re-claimed and sent once (the provider-reservation guard fails closed any job whose earlier attempt already
   reached the provider). Expect a burst of claims and some delivery-unknown rows.
4. Verify section 5, then reconcile delivery-unknown (section 9).

## 9. Delivery-unknown reconciliation

After every hard loss (cell or Redis), rows in `provider_messages` with status `delivery_unknown` need a manual
decision; the at-most-once guard blocks their automatic re-send. Procedure and rules are in
`docs/campaign-transport-operations.md` section 3. Count to watch:

```
select count(*) from provider_messages where status = 'delivery_unknown';
```

## 10. PostgreSQL (Host S)

Configuration: `deploy/postgres/campaign.conf` and `pg_hba.conf.example`. Required: `max_connections >= 26 ×
(cells + 1) + 20` (two cells: 98; set 120), `pg_stat_statements` preloaded, NTP-synchronised clock. Recommended
and enabled there: `log_lock_waits`, `track_io_timing`, durable `synchronous_commit` as in production.

## 11. Health checks

| Check | Command | Healthy |
|---|---|---|
| process | `systemctl is-active campaign-cell@cell-1` | `active` |
| HTTP and database | `curl -s localhost:$PORT/healthz` | 200, `status: ok`, `campaignRuntime.status: ok` (stale = housekeeping loop wedged) |
| scope | `journalctl -u campaign-cell@cell-1 \| grep -E 'OK host=\|Campaign runtime started'` | manifest scope |
| ownership | `redis-cli -u $REDIS TTL '{campaign-owner:<org>:1}'` | between 0 and 5, refreshing |
| pending stream entries | `redis-cli -u $REDIS XPENDING 'campaign:prepared:{phone:1}' campaign-prepared-v1` | first field 0 when idle; bounded while sending |
| PostgreSQL | `pg_isready -d $DATABASE_URL` | accepting |
| Redis | `redis-cli -u $REDIS PING`, `INFO persistence` | `PONG`, `aof_last_write_status:ok` |

## 12. Monitoring: minimum production signals

What the frozen code exposes: `/healthz` (database health and the runtime heartbeat) and the logs. The runtime's
internal dispatch metrics (transport starts, shard run-queue wait, event-loop delay, settlement slot refusals,
starvation, broker reclaims, ownership denials, settlement and claim timings, supply rate) exist in-process and
are read today only by the benchmark harness; there is no HTTP or log export for them at `111e0fe`. Exposing
them is a code change and is therefore a tracked item (P1 for operability), not something this deployment adds.
Until then the transport signals below are derived from PostgreSQL and Redis, which are authoritative.

Transport (per cell, derive from the shared services):
- provider-start TPS and per-phone TPS: `provider_messages.accepted_at` per second, joined through
  `campaign_jobs.route_id` to `campaign_routes.phone_number_id`; the 1,000/s per-phone ceiling must hold.
- settlement latency and throughput, claim latency, supply rate: `pg_stat_statements` mean and p-times for the
  settlement update, the claim CTE and the delta flush; `campaign_metric_deltas` row count (flush backlog).
- shard run-queue wait and event-loop latency: host-level only until exported: `/proc/<pid>/task/*/schedstat`
  run-queue wait (the benchmark sampler's method) and the node process's CPU share from `top`/`pidstat`.
- slot refusals, starvation, reclaims, ownership denials: not observable in production at this commit except
  denials, which are logged; alert on the log line. Tracked.

PostgreSQL: CPU (dedicated domain; measured 0.11 to 0.15 cores per 1K TPS), `numbackends` and connections against
`max_connections`, active backends, lock waiters (`pg_stat_activity.wait_event_type = 'Lock'`, sustained > a
handful means settlement contention on `campaigns` rows), statement latency from `pg_stat_statements`, WAL rate
(`pg_current_wal_lsn` delta; measured 2.7 to 3.4 KB per message), jobs Processing past `lease_expires_at` for more
than a minute (reaper stalled), campaigns Running with all jobs terminal (should not occur after `111e0fe`).

Redis: CPU (measured about 0.02 cores per 1K TPS), memory versus `maxmemory`, `connected_clients` (2 per cell),
persistence status (`aof_last_write_status`, `rdb_last_bgsave_status`), latency (`LATENCY LATEST`,
`instantaneous_ops_per_sec`), errors (`rejected_connections`, `errorstat_*` in `INFO errorstats`).

Recovery: ownership takeover time (first `{campaign-owner:*}` key held by the replacement's token minus the kill
time; expected about 5 to 6 s), first replacement provider start (first `accepted_at` on the scope after the
kill; expected within about 1 s of takeover), delivery-unknown count (section 9), pending stream entries per
phone (`XPENDING`, must return to 0 after reclaim), cell ownership (`XINFO CONSUMERS` per stream: exactly one
consumer, one runtime id per cell).

## 13. Rollback

A release is one checkout commit per host. To roll back: stop the cell, `git checkout <previous sha>`,
`pnpm install --frozen-lockfile`, build, start, verify (section 5); one host at a time, cell 1 first. The
database schema for the transport has not changed across the frozen commits, so no schema rollback is needed;
if a future release ships a migration, roll back only to a commit that the current schema supports. Never roll
back by starting an older build unscoped or on a different scope; the guard refuses the scope part, the commit
is the operator's responsibility and is printed by the guard.

## 14. Tracked deployment items (not fixed, code changes are frozen)

| Item | Severity | Where it is handled meanwhile |
|---|---|---|
| No runtime-off switch; unscoped process owns every phone | P1 | guard refuses missing scope; manifest; one cell per host |
| Runtime dispatch metrics not exported | P1 (operability) | derived signals in section 12 |
| Redis loss keeps published-but-lost envelopes leased until restart | P1 | persistence + procedure in section 8 |
| No automatic replacement controller | P2 | systemd restart; manual host replacement in section 6 |
| Delivery-unknown needs manual reconciliation | P2 | section 9 |
