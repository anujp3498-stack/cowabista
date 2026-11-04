# Restored-production-backup rehearsal (gate B8): operator checklist

**Who and where.**
- **Run by the operator only,** with the owner's explicit approval for this exact action. An agent never runs it.
- **On an isolated non-production host,** with no route to Meta, never with production secrets. The release
  starts there mock-only, or not at all.
- **The restored copy holds real personal data.** Restrict access to it and destroy it afterwards
  (`package/README.md`, "Required before the window").

**What is rehearsed.**
- The release `<REL>` named at the top of `FINAL-SEQUENCE.md`, with the §6 artifact hashes of that commit.
- The package `<PKG>` that carries this file.

A step that fails is a STOP: record it, and do not continue until it is explained.

## 1. Before starting

| # | Gate | How | Pass |
|---|---|---|---|
| R0 | Approval | The owner's written go for this rehearsal, naming the host and the backup | Recorded in the change record |
| R1 | Package integrity | In the package directory: `sha256sum -c SHA256SUMS` | Every line `OK` |
| R2 | Release identity | `git rev-parse HEAD` in the rehearsal checkout; `git diff --stat <REL> <PKG> -- artifacts lib deploy/systemd deploy/nginx` | `<REL>`; the diff prints nothing |
| R3 | Reproducible build | Node 22 and pnpm 10.33.0: `pnpm install --frozen-lockfile`, both builds, then `bash .github/scripts/release-hashes.sh .` | Every row equals `FINAL-SEQUENCE.md` §6. The script exits non-zero if an artifact is missing |
| R4 | Clock gate (G-CLOCK) | `bash package/discovery/check-clock.sh` on the rehearsal host. If the rehearsal uses separate cell and database/Redis hosts, run it on each cell with `<REDIS_HOST> [<REDIS_PORT>]` too | `CLOCK GATE: PASS` on every host |
| R5 | Isolation | No route to `graph.facebook.com` (for example `curl -sS -m 5 https://graph.facebook.com` fails); every workspace mock-only; no production secret in any env file | Confirmed and recorded |

## 2. The sequence (unchanged)

01 → 02 → 40 → start the release → 03 → 40 → 60 → 61 → 40, exactly as `package/README.md` and `RUNBOOK.md`
describe it.

**Record:**
- the index-build and scan times at production volume (*D*, *Mg*, *B*, finalize, unfinalize);
- every gate's output.

`FINAL-SEQUENCE.md` §10 takes its production values from these numbers.

## 3. Release checks on the restored data (mock-only)

Run these only if the release was started. Use one mock workspace created for the rehearsal; never a restored
workspace's live credential.

| # | Check | Pass |
|---|---|---|
| R6 | Readiness: `/api/readyz` on each started cell | 200 |
| R7 | **Pause, then resume, served by the other cell.** A mock campaign is running on cell C; pause it from cell D, then resume it | Every message sent exactly once. **None** Failed with "Send aborted before provider start" (D1). Each job ends with `attempts` = 1 |
| R8 | Emergency kill from the other cell | Remaining jobs Cancelled ("Emergency kill"); no duplicate send |
| R9 | **Manual-reconciliation view.** Open the campaign's monitoring panel; search the messages list for "reconciliation" and "delivery is unknown" | The "Delivery unknown · Needs manual review" count equals the number of matching messages; the export lists them with `job_error_reason` and `provider_status` |
| R10 | **No resend of an ambiguous delivery.** Stop a cell with `kill -9` during a mock send, then let the other cell recover | No recipient sent twice. Work that may have been sent ends "delivery is unknown" or "manual reconciliation", never re-sent |

## 4. Afterwards

- Stop the release.
- Destroy the restored copy and every derived dump. Record how and when.
- Attach the logs (`logs/`), the hash comparison, the clock-gate output and the timings to the change record.

## 5. Infrastructure gates still open

From `FINAL-SEQUENCE.md` §1, as of this commit. None of them can be closed from the preparation environment.

| Gate | What is missing | Owner |
|---|---|---|
| B1/B2 | Read-only discovery on M, C, D, N and S (E1–E6, inventories 01/11/12/13/15) has not been run | Owner, with read-only production access |
| B6 | S3 bucket and least-privilege key not provisioned; media smoke from C and D not run | Owner |
| B7 | Cell scopes `<CELL1_PHONE_IDS>` / `<CELL2_PHONE_IDS>` not confirmed against inventory 12 | From B1 |
| B8 | This rehearsal | Operator |
| B9 | Builds not staged on C and D (P4), SPA on N, env (P5), nginx and TLS (P7) | Operator |
| B10 | Rollback readiness RP1–RP10 and owner sign-off for `70_freeze_rc_down.psql` | Owner |
| B11 | Window time, notice and reopen choice | Owner |
| **B12 (new)** | **Clock gate G-CLOCK on C, D and S**: NTP synchronized, offset < 0.5 s on each host, cell-to-Redis skew < 1 s | Operator (read-only) |
| **B13 (new)** | **Gate B throughput evidence** for this release's `measuredFilesSha256` (the campaign runtime changed; the frozen evidence predates it) | Owner (benchmark flow) |
