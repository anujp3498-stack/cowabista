# Read-only production discovery kit (U1 evidence E1-E6, inventories, Replit access risk)

These four scripts collect the evidence the runbook needs before the window is booked: who serves production
today (U1), the counts-only inventories that decide U3 and the encryption-key rule, and which clients reach the
production database and Redis. Every command is read only. Nothing starts, stops, reloads, writes a file outside
the operator's own `logs/` directory, mutates a database or Redis key, or calls Meta.

They print variable names as `NAME=SET` / `NAME=UNSET`, host:port/database for connection URLs, counts and status
codes. They never print a password, token, secret, session, email, name, Clerk id or query text. A value whose
format is not the expected one prints a placeholder instead of the value.

Before running: copy the package of the release commit to each host (`git archive <REL> deploy/cutover/package`),
run `sha256sum -c SHA256SUMS` in the package directory (every line must say `OK`; the scripts here are part of the
package), and keep terminal recording and sudo I/O logging off, as for the operator account command.

| Where | Script | Evidence |
|---|---|---|
| Operator workstation M | `bash discovery/discover-m.sh <APP_DOMAIN> 2>&1 \| tee discover-m-<UTC>.txt` | E1: DNS A/AAAA/CNAME (local and two public resolvers), the TLS certificate subject and issuer, status codes of `/`, `/api/healthz`, `/api/readyz`, `/api/auth-policy` and `/api/__clerk/`, which frontend is served (Clerk = d22a8e43, auth-policy = release), `Server`/`Via`/Replit headers |
| Host C and Host D (root) | `bash discovery/discover-cell.sh 2>&1 \| tee discover-cell-$(hostname)-<UTC>.txt` | E4: `campaign-cell@*` units (enabled, active, since), the guard's last `OK host= scope= commit=` line, HTTP requests logged in 24 h, `/opt/cowabista` owner/HEAD/dirty count, listening ports, `/etc/cowabista` names, each env file's variable names (SET/UNSET, Replit variables flagged), scope, `BETTER_AUTH_URL` origin, database and Redis host:port/db, the manifest |
| Nginx host N, if one exists (root) | `bash discovery/discover-n.sh <APP_DOMAIN> 2>&1 \| tee discover-n-<UTC>.txt` | E5: `server_name`, `listen`, `root`, `proxy_pass`, upstream `server`, `allow`/`deny` and `ssl_certificate` lines of the running configuration, certificate subjects and dates, `/var/www/wabista` |
| Host S, from the package directory as the owner role (`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGSSLMODE` exported, password only in `~/.pgpass`) | `bash discovery/discover-s.sh [<REDIS_HOST> [<REDIS_PORT>]] 2>&1 \| tee logs/discover-s-<UTC>.txt` | E3: PostgreSQL clients of the database grouped by address, user, application, backend type and state (inside a READ ONLY transaction); database sizes; Redis clients by address/name/db (password typed at a hidden prompt, passed only through `REDISCLI_AUTH`), keyspace, ownership keys and distinct owning runtimes. Then `01_preflight_readonly`, `11_user_inventory_readonly`, `12_connector_inventory_readonly`, `13_media_link_inventory_readonly` and `15_credential_key_inventory_readonly`, with exit codes |
| Replit (UI, read only) | none | E2: is a deployment published (commit, type, instances); for the deployment and the workspace, only the host:port/database of `DATABASE_URL` and the Redis URL; whether `.replit` still runs `scripts/post-merge.sh` |
| Meta App Dashboard (read only) | none | E6: the Callback URL host only |

`discover-s.sh` prints `01_preflight_readonly` failing (exit 3) on a database that is already migrated: that is
expected only on the rehearsal copy. On production before the window it must print `PREFLIGHT OK`.

## How the answers are read

- **U1 (front A or B).** E1 and E6 at Replit (CNAME or certificate issuer of Replit, a `replit` header, `/api/__clerk/`
  not 404 and a Clerk frontend) mean front A; E1 and E6 at host N with `proxy_pass` to the cells mean front B.
  Every PostgreSQL and Redis client address from `discover-s.sh` must map to a host found by E2/E4/E5; an unknown
  client is a no-go.
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
