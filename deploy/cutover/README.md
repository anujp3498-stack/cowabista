# P6 production cutover package (preparation only)

Reviewed runbook and database package for the cutover of production (`d22a8e43`, Clerk) to the release
`<REL>` (Better Auth, V2 schema, closed public sign-up). **Nothing here has been run against production.** Every
step that touches the production database, Host S, the cell hosts, nginx, `/opt/cowabista`, `/etc/cowabista`,
Replit or Meta is run by the human operator after the user's explicit go-ahead for that step; agents never run
them (`CLAUDE.md` hard rules).

| Path | What it is |
|---|---|
| `RUNBOOK.md` | The runbook: decisions U1-U8, blockers, cutover order, Clerk users, connector, sign-up, media, environment contract, rollback, acceptance, non-blockers |
| `package/README.md` | How to connect, file order, gates, lab validation summary, rehearsal rules |
| `package/sql/` | Read-only preflight and postcheck, the additive migration (`02_migrate.psql` runs 10/20/30), the in-window finalize (`03`/`50`), and the unfinalize pair (`60`/`61`) |
| `package/inventory/` | Read-only, counts-only inventories: Clerk users (11), shared connector (12), media links (13), zero-send check (14), credential keys (15) |
| `package/path-b/` | Path B1 owner re-invite (`21_owner_reinvite.psql`), used only if U3 = B1 |
| `package/rollback/` | `70_freeze_rc_down.psql` (fail-closed: a dry run unless `-v commit=yes`) |

Not committed on purpose: the generated lab outputs and logs, the lab databases' connection files and
password, and the scratch generators used to build the catalog checks. None of these files holds a secret, a
production URL or a real WABA, phone, app or message id.
