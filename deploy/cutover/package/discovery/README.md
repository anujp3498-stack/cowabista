# Read-only production discovery kit (U1 evidence E1-E6, inventories, Replit access risk)

These four scripts collect the evidence the runbook needs before the window is booked: who serves production
today (U1), the counts-only inventories that decide U3 and the encryption-key rule, and which clients reach the
production database and Redis. Every command is read only. Nothing starts, stops, reloads, writes a file outside
the operator's own `logs/` directory, mutates a database or Redis key, or calls Meta. On the cells, git runs as the
checkout's owner with `--no-optional-locks`, so it never rewrites `.git/index`.

They print variable names as `NAME=SET` / `NAME=UNSET` (plus every upper-case name present in an env file, flagged
`(DUPLICATE)` or `(EMPTY VALUE)`; other names and lines that are not `NAME=value` are only counted, never shown;
an env file is parsed only before the first line holding a quote or a backslash; that line and the rest are counted
and the known names print `NOT SEEN`), host[:port][/db] for connection URLs, counts and status codes. They never print a password, token, secret, session, email, name, Clerk id or query text. A value whose
format is not the expected one prints a placeholder instead of the value.

Before running: copy the package to each host (`git archive <PKG> deploy/cutover/package | tar -x`; `<PKG>` is the final commit of branch `wabista-nexus-v2` that carries this package (record it in the change record); it differs from the release `<REL>` only in documentation and in `deploy/cutover/`: `git diff --stat <REL> <PKG> -- artifacts lib deploy/systemd deploy/nginx` must print nothing),
run `sha256sum -c SHA256SUMS` in the package directory (every line must say `OK`; the scripts here are part of the
package; `discover-s.sh` repeats the check and stops on a mismatch), and keep terminal recording and sudo I/O logging off, as for the operator account command.

| Where | Script | Evidence |
|---|---|---|
| Operator workstation M | `mkdir -p logs && bash discovery/discover-m.sh <APP_DOMAIN> 2>&1 \| tee logs/discover-m-<UTC>.txt` | E1: DNS A/AAAA/CNAME (local and two public resolvers), the TLS certificate subject and issuer, status codes of `/`, `/api/healthz`, `/api/readyz`, `/api/auth-policy` and `/api/__clerk/`, which frontend is served (Clerk = d22a8e43, auth-policy = release), `Server`/`Via`/Replit headers |
| Host C and Host D (root) | `mkdir -p logs && bash discovery/discover-cell.sh 2>&1 \| tee logs/discover-cell-$(hostname)-<UTC>.txt` | E4: `campaign-cell@*` units (enabled, active, since), the guard's last `OK host= scope= commit=` line with its time (compare it with `since=`; `commit=unknown` means git refused the checkout for the service user), HTTP requests logged in 24 h, `/opt/cowabista` owner/HEAD/dirty count, listening ports, `/etc/cowabista` names, each env file's variable names (SET/UNSET for the known names, then every name present with `(DUPLICATE)`/`(EMPTY VALUE)` flags, Replit variables flagged), scope, `BETTER_AUTH_URL` origin, database and Redis host:port/db, the manifest |
| Nginx host N, if one exists (root) | `mkdir -p logs && bash discovery/discover-n.sh <APP_DOMAIN> 2>&1 \| tee logs/discover-n-<UTC>.txt` | E5: `server_name`, `listen`, `root`, each `proxy_pass` target as scheme://host[:port] only (never a path, query or user part), upstream `server`, `allow`/`deny` and `ssl_certificate` lines of the running configuration, certificate subjects and dates, `/var/www/wabista` |
| Host S, from the package directory as the owner role (`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGSSLMODE` exported, password only in `~/.pgpass`) | `mkdir -p logs && bash discovery/discover-s.sh [<REDIS_HOST> [<REDIS_PORT> [<REDIS_DB>]]] 2>&1 \| tee logs/discover-s-<UTC>.txt` (`<REDIS_DB>` = the `/N` of `CAMPAIGN_REDIS_URL` printed by `discover-cell.sh`, default 0; `export REDIS_TLS=1` first for `rediss://`) | Checksums first. E3: PostgreSQL clients of the whole server (every database and replication) grouped by address, database, user, application, backend type and state, inside a READ ONLY transaction, with `sees_all_sessions`; database sizes; Redis clients by address/name/db and their total (password typed at a hidden prompt, passed only through `REDISCLI_AUTH`), keyspace, ownership keys and distinct owning runtimes in `<REDIS_DB>`. Then `01_preflight_readonly`, `11_user_inventory_readonly`, `12_connector_inventory_readonly`, `13_media_link_inventory_readonly` and `15_credential_key_inventory_readonly`, with exit codes |
| Replit (UI, read only) | none | E2: is a deployment published (commit, type, instances); for the deployment and the workspace, only the host:port/database of `DATABASE_URL` and the Redis URL; whether `.replit` still runs `scripts/post-merge.sh` |
| Meta App Dashboard (read only) | none | E6: the Callback URL host only |

`discover-s.sh` prints `01_preflight_readonly` failing (exit 3) on a database that is already migrated: that is
expected only on the rehearsal copy. On production before the window it must print `PREFLIGHT OK`.

## How the answers are read

- **U1 (front A or B).** Front A: the domain's A/AAAA records are not host N, and a `replit-verify=` TXT record, a
  CNAME to `*.replit.app` or a Replit header is present (E6 pointing at the same host). Front B: the A record is
  host N (the certificate `discover-m.sh` reads matches the one `discover-n.sh` prints) and N's `proxy_pass` goes to
  the cells. A Clerk frontend or a non-404 `/api/__clerk/` only shows that `d22a8e43` serves, in either front.
- **E3 client map.** Every PostgreSQL and Redis client address from `discover-s.sh` must map to a host found by
  E2/E4/E5; an unknown client is a no-go. If `sees_all_sessions` is false or any `HIDDEN` row appears, E3 is
  incomplete (also a no-go) until that query is re-run as `postgres` or a `pg_read_all_stats` member (runbook P1).
  The Redis rows (one per client address, `[IPv6]` and `/unixsocket` included) must add up to `clients total`; an
  `(unparsed client line)` row is investigated. A Redis `STOP:` line of any kind, no `AUTH_OK` line, or
  `clients total: 0` means no Redis evidence was recorded (a no-go for E3). The row for the address S uses to reach
  `<REDIS_HOST>` (127.0.0.1 by default) with `name= db=0` includes this listing's own connection: subtract 1 from its
  count and map whatever remains like any other client.
- **Env files.** Any `(DUPLICATE)` or `(EMPTY VALUE)` flag, a non-standard-name count, a not-`NAME=value` count, a
  `lines from the first quote or backslash on` count, a `NOT SEEN` line or a `not UTF-8 text or holds a NUL byte`
  line is a finding to fix before the window (the
  templates allow none of them; `export NAME=` is not a variable for systemd and counts as not `NAME=value`).
- **U3.** From `11_user_inventory_readonly`: Path A when there are no meaningful users or workspaces; otherwise B1
  (the default). B2 is not needed by this release (see `deploy/cutover/FINAL-SEQUENCE.md`, "Clerk users").
- **Encryption key.** From `15_credential_key_inventory_readonly`: `KEY RULE: PRESERVE` means the existing
  `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` is copied byte-for-byte; `NEW KEY PERMITTED` allows a new key.
- **Connector campaigns.** `12_connector_inventory_readonly` exit 3 lists the campaigns their owners must finish or
  cancel before the window (it must exit 0 at window start).
- **Replit database access.** Any client address that belongs to Replit, any Replit deployment or workspace whose
  `DATABASE_URL` or Redis URL points at Host S, and a `.replit` that still runs `scripts/post-merge.sh` are cut in
  sequence step 3 (`deploy/cutover/FINAL-SEQUENCE.md`).

The scripts were exercised against the synthetic rehearsal (a production-shaped disposable database, a local
nginx front, release cells and a password-protected Redis) with secret values planted in the env files; the output
contained none of them.
