# Production environment manifest (release `<REL>` = `2a2afe6a2890da949947112e514236bc823935f1`)

The one canonical list of what goes into `/etc/cowabista/cell-cell-1.env` (Host C) and
`/etc/cowabista/cell-cell-2.env` (Host D). Details, startup behaviour and code references are in `RUNBOOK.md`,
environment section §3 (variables), §4 (fixed by the unit), §6 (must not be set), §7 (identical values) and §9
(templates and the pre-start checklist). This file adds nothing new to those rules; it puts them on one page.

**Never print, paste or record a value.** Checks use names only (`NAME=SET` / `NAME=UNSET`, as
`package/discovery/discover-cell.sh` prints them) and the environment section §9 salted fingerprint to prove the
two files are identical without revealing anything. Files are `root:cowabista`, mode `0640`. No quotes, no inline
comments, no empty `NAME=` lines, no duplicate names.

## 1. Identical on both cells (byte for byte)

| Variable | Value (placeholder) | Source | Notes |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://cowabista:<DB_PASSWORD>@<HOST_S>:5432/cowabista` | existing production role | Percent-encode reserved characters. Never on a command line |
| `CAMPAIGN_REDIS_URL` | `redis://:<REDIS_PASSWORD>@<HOST_S>:6379` | existing production Redis | `rediss://` if TLS. `REDIS_URL` is not set |
| `BETTER_AUTH_SECRET` | `<BETTER_AUTH_SECRET>` | **new**, `openssl rand -base64 32`, generated once into a root-only file | At least 32 characters; `CHANGE_ME` or a placeholder stops startup |
| `BETTER_AUTH_URL` | `https://<APP_DOMAIN>` | the public origin | https required in production |
| `TRUST_PROXY` | `1` | `1`, always. nginx on N appends the client address it sees to `X-Forwarded-For`, and the cells trust exactly that one hop. With an HTTP proxy or CDN in front of N, keep `1` and add `set_real_ip_from <EDGE_RANGES>; real_ip_header X-Forwarded-For;` to N's 443 server, so N sees (and appends) the real client address and N's `allow`/`deny` keeps working. An L4/TCP load balancer is fine only if it keeps the client source address (passthrough without source NAT; not the PROXY protocol: `proxy_protocol` on N's 443 `listen` makes every direct `--resolve <APP_DOMAIN>:443:<N_ADDR>` gate fail); a source-NAT balancer must be changed before the window (runbook P5) | Never `2`: it would let a client forge `X-Forwarded-For` and pick its own sign-in and API rate-limit key unless N's 443 were closed to all but the edge, and then the `--resolve` gates cannot pass. A source-NAT edge without `real_ip` makes every user share one rate-limit bucket |
| `LOG_LEVEL` | `info` | fixed | |
| `META_APP_SECRET` | `<META_APP_SECRET>` | **carried over** from current production | Verifies webhook signatures |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `<WHATSAPP_WEBHOOK_VERIFY_TOKEN>` | **carried over** | Must equal the token set in the Meta App Dashboard |
| `WHATSAPP_APP_ID` | `<META_APP_ID>` | the Meta app's id | An identifier, not a secret; still never written into docs or logs |
| `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` | `<WHATSAPP_CREDENTIAL_ENCRYPTION_KEY>` (32 bytes, 64 hex characters) | **Encryption key rule:** inventory 15 `PRESERVE EXISTING KEY` → the existing key byte-for-byte; `NEW KEY PERMITTED` → `openssl rand -hex 32`, once | Never displayed, never decrypted anything with it |
| `CAMPAIGN_MEDIA_STORAGE` | `s3` | fixed (U4) | |
| `CAMPAIGN_MEDIA_S3_ENDPOINT` | `https://<S3_ENDPOINT_HOST>` | owner's provider | Origin only, no path. Leave the variable out only for AWS S3 itself |
| `CAMPAIGN_MEDIA_S3_REGION` | `<S3_REGION>` | owner's provider | Always set (it silently defaults to `us-east-1`) |
| `CAMPAIGN_MEDIA_S3_BUCKET` | `<S3_BUCKET>` | owner's provider | A dedicated, private, general-purpose bucket |
| `CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID` | `<S3_ACCESS_KEY_ID>` | owner's provider | The least-privilege key (`FINAL-SEQUENCE.md` §5) |
| `CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY` | `<S3_SECRET_ACCESS_KEY>` | owner's provider | |
| `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE` | `true` or `false` | only if the provider requires one | Leave out otherwise (with an endpoint the default is path-style) |
| `NODE_EXTRA_CA_CERTS` | `<PATH_TO_CA_PEM>` | only for a private CA (MinIO alternative) | Leave out for a public provider |
| `CAMPAIGN_CELL_REQUIRED_ENV` | `BETTER_AUTH_SECRET BETTER_AUTH_URL TRUST_PROXY META_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN WHATSAPP_CREDENTIAL_ENCRYPTION_KEY WHATSAPP_APP_ID CAMPAIGN_MEDIA_STORAGE CAMPAIGN_MEDIA_S3_ENDPOINT CAMPAIGN_MEDIA_S3_REGION CAMPAIGN_MEDIA_S3_BUCKET CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY` | fixed | The guard refuses to start when a listed name is empty. Drop `CAMPAIGN_MEDIA_S3_ENDPOINT` only for AWS S3 itself |
| `PORT` | `8080` | fixed | Per host, but use the same value; nginx upstreams point at it |

## 2. Different per cell

| Variable | Cell 1 (Host C) | Cell 2 (Host D) | Rule |
|---|---|---|---|
| `CAMPAIGN_TRANSPORT_PHONE_IDS` | `<CELL1_PHONE_IDS>` | `<CELL2_PHONE_IDS>` | Production `phone_numbers.id` values; must equal the cell's line in `/etc/cowabista/cells.manifest`; **the two lists never overlap** (the `<REL>` guard refuses any overlap, multi-digit ids included). Taken from the existing manifest (`discover-cell.sh` prints it); scopes are never changed ad hoc |

## 3. Unset (leave the name out entirely)

- `AUTH_PUBLIC_SIGN_UP`: public sign-up stays **closed** (U2 = Option 2a). `open` stops the process in production.
- `CORS_ALLOWED_ORIGINS`: one origin, nothing to allow. Only if a second origin is ever needed: full origins
  (`https://host`), comma-separated; a bare host stops startup.
- `CAMPAIGN_PLATFORM_MAX_TPS`, `CAMPAIGN_TRANSPORT_SHARDS`, `API_RATE_LIMIT_MAX_PER_MINUTE`,
  `CAMPAIGN_MEDIA_S3_PREFIX` (default `campaign-media`, never changed after the first upload),
  `CAMPAIGN_CELL_WAIT_SECONDS`, `REDIS_URL`.
- **No Clerk variable is needed** (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_*`): the release has no
  Clerk code. Keep the Clerk secrets only in the secret store for the rollback window (rollback RP2).
- Never: `NODE_ENV`, `CAMPAIGN_CELL`, `CAMPAIGN_COORDINATOR_MODE`, `CAMPAIGN_CELL_MANIFEST`, `CAMPAIGN_CELL_REPO`
  (the unit sets them), any `REPLIT_*`/`REPL_*`, `PRIVATE_OBJECT_DIR`, `PG*`, `CAMPAIGN_TEST_*`, `BETTER_AUTH_SECRETS`,
  `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_TELEMETRY*`, `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
  `DEBUG`, `TEST`. The full list and the one-line check are environment section §6 and §9 item 4.

## 4. Checks (names and fingerprints only)

1. `discover-cell.sh` on C and D, for the `*.env.next` file (and later the live file):
   - every unconditional §1 name and `CAMPAIGN_TRANSPORT_PHONE_IDS` prints `=SET`; `CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE`
     prints `=SET` only if the provider requires it; `CAMPAIGN_MEDIA_S3_ENDPOINT` prints `=UNSET` only for AWS S3;
   - `AUTH_PUBLIC_SIGN_UP`, `CORS_ALLOWED_ORIGINS`, `REDIS_URL`, `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` print
     `=UNSET`, and no Replit variable is flagged;
   - the `name present:` lines are exactly the §1/§2 names in use (`LOG_LEVEL` and `PORT` included;
     `NODE_EXTRA_CA_CERTS` only for a private CA), none is a §3 name, none is marked `(DUPLICATE)`, `(EMPTY VALUE)`
     and no non-standard-name, not-`NAME=value` or `lines from the first quote or backslash on` count, no `NOT SEEN`
     line and no `not UTF-8 text or holds a NUL byte` line is printed;
   - the database and Redis host:port/db and the `BETTER_AUTH_URL` origin are the expected ones, and the scope equals
     the manifest line.
2. Environment section §9 pre-start checklist, items 1-9 (placeholders, forbidden names, quoting, salted
   fingerprint of everything except `CAMPAIGN_TRANSPORT_PHONE_IDS`: identical on C and D).
3. `sha256sum /etc/cowabista/cells.manifest` identical on C and D.
4. The guard line at start: `OK host=… scope=<cell scope> … commit=2a2afe6a2890`.

The synthetic dress rehearsal (`package/README.md`) started both release cells from files of exactly this shape
(with rehearsal values): guard OK, media `s3`, readiness 200, and every secret's count in the logs 0.
