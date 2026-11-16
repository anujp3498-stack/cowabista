# G78: how systemd treats a refused cell (verified 2026-11-16)

`deploy/cutover/RUNBOOK.md` item G78 said this was not verified under systemd: whether a guard refusal (exit 78
from `ExecStartPre`) is retried, and how the unit recovers. It is now verified on a disposable host.

## Setup (non-production)

**Host and systemd:**
- An ephemeral cloud VM: Linux 6.18, 4 vCPU.
- **systemd 255 (255.4-1ubuntu8.18)**, the same major version as Ubuntu 24.04. It ran as PID 1 of its own PID and
  mount namespace, with a private `/run` and cgroup2 hierarchy.
- It loaded units only from a private directory (`SYSTEMD_UNIT_PATH`), plus empty stub targets.
- Nothing on the host's own service manager, network or files outside the test tree was touched.
- No production host, database or Redis was involved.

**The unit:** the release candidate's `deploy/systemd/campaign-cell@.service` (`c979cd8`), with every directive
unchanged except:
- the paths, moved to `/srv/g78test`, because the unit's `PrivateTmp=true` and `ProtectHome=true` hide `/tmp` and
  `/home`;
- `StandardOutput`/`StandardError` set to a file;
- `ExecStart` replaced by a stand-in whose behaviour is chosen per scenario (keep running, exit 1, exit 78).
  `ExecStart` takes no part in `ExecStartPre` semantics, and no campaign runtime was started.

**What stayed real:**
- `ExecStartPre` was the release candidate's real guard (`campaign-cell-guard.sh`), run as `User=cowabista`.
- `Restart=always`, `RestartSec=2`, `RestartPreventExitStatus=78`, `StartLimitIntervalSec=300` and
  `StartLimitBurst=10` were as shipped.
- The guard checked a real local PostgreSQL and Redis.

## Results

| # | Scenario | What systemd did |
|---|---|---|
| S1 | Guard refuses at once (static env, manifest row `auto`) | Retried every ~2.1 s **despite `RestartPreventExitStatus=78`**: 10 refused runs, then `failed` (Result `exit-code`, NRestarts 10) about 21 s after the first start. The guard logged its refusal 10 times. |
| S3 | Files fixed, plain `systemctl start` without `reset-failed`, within the 300 s window | Refused without running the guard (nothing logged). systemd reported it, misleadingly, as "Job for campaign-cell@cell-1.service failed because the control process exited with error code". |
| S2 | Files fixed, `systemctl reset-failed campaign-cell@cell-1`, then `systemctl start` | Guard OK (`assignment=static scope=1-4 … manifest_assignment=auto\|1-4`), unit `active (running)` within 0.3 s. |
| S4 | Guard refuses slowly: PostgreSQL unreachable, `CAMPAIGN_CELL_WAIT_SECONDS=30` | Each attempt took ~31 s plus the 2 s restart delay, so 10 starts never fit in 300 s. It never reached the start limit: 12 refused runs in 400 s, still `activating`. With the production default wait of 60 s it retries indefinitely, and the cell starts by itself once PostgreSQL answers. |
| S5 | The **main process** exits 78 | Not restarted: `failed` at once. `RestartPreventExitStatus` applies to the main process only. |
| S6 | The main process exits 1 (RUNBOOK R1) | Retried every ~2 s until the start limit; `failed` after ~22 s. |
| S7 | SIGKILL of the running main process (a crash) | Restarted after 2.1 s: the guard passed again and the process ran. |

## What this means for operators

**A configuration refusal** (manifest or env mismatch, a malformed scope):
- It loops for about 21 s, then the unit stays `failed`.
- After fixing the files, `systemctl reset-failed campaign-cell@<cell>` **is required**, followed by
  `systemctl start`. A plain `start` within 5 minutes is refused, and its error message points at the wrong cause.
  `deploy/README.md` section 2 and `docs/AUTO_PHONE_ASSIGNMENT.md` section 7.7 already prescribe this, and their
  "unverified" wording is now settled.

**A dependency refusal** (PostgreSQL or Redis not answering within the guard's wait):
- It keeps retrying with no limit, and the cell starts by itself once the services answer.
- That is the intended behaviour for a cell that boots before Host S.

**Is the loop harmful?** The ~21 s loop of instant refusals is harmless: the guard starts nothing. Removing it would
need a unit change, for example making the guard's refusal non-fatal and having `ExecStart` refuse instead. That is
not proposed here.

## Commands (for re-running on another disposable host)

**On the host:**
1. `unshare --fork --pid --mount --uts --ipc --mount-proc <boot.sh> <unit dir>`. `boot.sh` mounts a tmpfs on
   `/run` and cgroup2 on `/sys/fs/cgroup`, sets `container=` and `SYSTEMD_UNIT_PATH`, and execs
   `/lib/systemd/systemd --system --unit=default.target`.
2. Drive it with `nsenter -t <pid> -m -p systemctl …`.
3. Sample the unit's state every 250 ms with `systemctl show -p ActiveState -p SubState -p Result -p NRestarts
   -p ExecMainStatus`.

**Evidence** was kept in the session scratchpad: the per-scenario timelines and the guard's log.
