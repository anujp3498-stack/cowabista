// The systemd cell guard (deploy/systemd/campaign-cell-guard.sh) refuses to start a cell whose phone scope
// overlaps another cell's in the fleet manifest, including multi-digit phone ids (the overlap check compares
// sorted id lists, which must be in the order `comm` expects). Runs the real script with bash; the database and
// Redis addresses point at closed ports, so a scope the guard accepts stops later, at the PostgreSQL check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const guard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../deploy/systemd/campaign-cell-guard.sh");
const dir = mkdtempSync(path.join(tmpdir(), "cell-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let manifests = 0;
function runGuard(scope: string, otherScope: string, env: Record<string, string> = {}, manifestScope = scope) {
  const manifest = path.join(dir, `manifest-${manifests++}`);
  writeFileSync(manifest, `cell-1 ${hostname()} ${manifestScope}\ncell-2 another-host ${otherScope}\n`);
  const result = spawnSync("bash", [guard], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, CAMPAIGN_CELL: "cell-1", CAMPAIGN_CELL_MANIFEST: manifest, CAMPAIGN_TRANSPORT_PHONE_IDS: scope,
      NODE_ENV: "production", CAMPAIGN_COORDINATOR_MODE: "redis", CAMPAIGN_REDIS_URL: "redis://127.0.0.1:1",
      DATABASE_URL: "postgresql://guard-test@127.0.0.1:1/none", PORT: "1", CAMPAIGN_CELL_WAIT_SECONDS: "1",
      ...env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test("overlapping scopes are refused, whatever the number of digits in the phone ids", () => {
  for (const [scope, other, phone] of [["1-4", "4-6", "4"], ["9-12", "12-14", "12"], ["1-12", "10-20", "10"], ["8,10,100", "99-100", "100"], ["5,25", "25", "25"]]) {
    const { code, output } = runGuard(scope!, other!);
    assert.equal(code, 78, `${scope} vs ${other}: ${output}`);
    assert.match(output, new RegExp(`phone ${phone} is in the scope of cell cell-1 and of cell cell-2`), `${scope} vs ${other}: ${output}`);
    assert.doesNotMatch(output, /not in sorted order/, "the overlap check gets correctly ordered input");
  }
});

test("disjoint scopes pass the overlap check (the guard then stops at the unreachable PostgreSQL)", () => {
  for (const [scope, other] of [["1-12", "13-24"], ["9-11", "12-14"], ["2,20,200", "3,30,300"]]) {
    const { code, output } = runGuard(scope!, other!);
    assert.equal(code, 78, output);
    assert.doesNotMatch(output, /scopes must be disjoint/, `${scope} vs ${other}: ${output}`);
    assert.doesNotMatch(output, /not in sorted order/, output);
    assert.match(output, /PostgreSQL .* did not answer/, `${scope} vs ${other}: ${output}`);
  }
});

// V2-372: automatic assignment. Accepted cells stop later, at the unreachable PostgreSQL, like accepted scopes.
const AUTO = { CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto" };

test("an automatic cell is accepted with no scope and an auto manifest entry, next to static or automatic cells", () => {
  for (const other of ["auto", "1-4", "5-9"]) {
    const { code, output } = runGuard("", other, AUTO, "auto");
    assert.equal(code, 78, output);
    assert.match(output, /PostgreSQL .* did not answer/, `other cell ${other}: ${output}`);
    assert.doesNotMatch(output, /REFUSING START: (?!PostgreSQL)/, output);
  }
});

test("an automatic cell is refused with a scope, or when the manifest gives it a static scope", () => {
  let result = runGuard("5-9", "1-4", AUTO, "auto");
  assert.equal(result.code, 78);
  assert.match(result.output, /automatic cells take no scope, unset it/, result.output);
  result = runGuard("", "1-4", AUTO, "5-9");
  assert.equal(result.code, 78);
  assert.match(result.output, /write auto \(or auto\|5-9 while migrating\) in its assignment column/, result.output);
});

test("a static cell is refused when the manifest makes it automatic, and a static cell next to an automatic one is not checked for overlap", () => {
  let result = runGuard("5-9", "1-4", {}, "auto");
  assert.equal(result.code, 78);
  assert.match(result.output, /makes cell cell-1 automatic only, but this environment gives it the static scope "5-9"; write auto\|5-9/, result.output);
  result = runGuard("1-4", "auto");
  assert.equal(result.code, 78);
  assert.match(result.output, /PostgreSQL .* did not answer/, result.output);
});

test("an unset scope without automatic mode, and an unknown mode, are refused", () => {
  let result = runGuard("", "1-4", {}, "5-9");
  assert.equal(result.code, 78);
  assert.match(result.output, /set CAMPAIGN_TRANSPORT_ASSIGNMENT=auto \(recommended\) or an explicit scope/, result.output);
  result = runGuard("5-9", "1-4", { CAMPAIGN_TRANSPORT_ASSIGNMENT: "round-robin" });
  assert.equal(result.code, 78);
  assert.match(result.output, /must be auto or static/, result.output);
});

// Production migration static -> auto (docs/AUTO_PHONE_ASSIGNMENT.md, section 7), cell by cell. Every intermediate
// state must accept BOTH cells' current environments: an unexpected restart of either cell in any state must pass
// the guard (a refused cell does not run until its files are fixed, whether or not systemd retries it). Each state lists the
// manifest's assignment column per cell and each cell's environment; the guard is run for each cell on its own host.
type Env = { scope: string } | { auto: true };
type MigrationState = { name: string; manifest: { "cell-1": string; "cell-2": string }; env: { "cell-1": Env; "cell-2": Env } };
const STATIC1: Env = { scope: "1-4" };
const STATIC2: Env = { scope: "5-9" };
const AUTO_ENV: Env = { auto: true };
const FORWARD: MigrationState[] = [
  { name: "S0 static (today)", manifest: { "cell-1": "1-4", "cell-2": "5-9" }, env: { "cell-1": STATIC1, "cell-2": STATIC2 } },
  { name: "S1 transitional manifest", manifest: { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, env: { "cell-1": STATIC1, "cell-2": STATIC2 } },
  { name: "S2 cell-2 automatic", manifest: { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, env: { "cell-1": STATIC1, "cell-2": AUTO_ENV } },
  { name: "S3 both automatic", manifest: { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, env: { "cell-1": AUTO_ENV, "cell-2": AUTO_ENV } },
  { name: "S4 manifest finalized", manifest: { "cell-1": "auto", "cell-2": "auto" }, env: { "cell-1": AUTO_ENV, "cell-2": AUTO_ENV } },
];

function guardFor(cell: "cell-1" | "cell-2", manifestRows: { "cell-1": string; "cell-2": string }, env: Env, extra: Record<string, string> = {}) {
  const other = cell === "cell-1" ? "cell-2" : "cell-1";
  const manifest = path.join(dir, `manifest-${manifests++}`);
  writeFileSync(manifest, `${cell} ${hostname()} ${manifestRows[cell]}\n${other} another-host ${manifestRows[other]}\n`);
  const result = spawnSync("bash", [guard], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, CAMPAIGN_CELL: cell, CAMPAIGN_CELL_MANIFEST: manifest,
      CAMPAIGN_TRANSPORT_PHONE_IDS: "scope" in env ? env.scope : "",
      CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto" in env ? "auto" : "",
      NODE_ENV: "production", CAMPAIGN_COORDINATOR_MODE: "redis", CAMPAIGN_REDIS_URL: "redis://127.0.0.1:1",
      DATABASE_URL: "postgresql://guard-test@127.0.0.1:1/none", PORT: "1", CAMPAIGN_CELL_WAIT_SECONDS: "1",
      ...extra,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}
/** Accepted = the guard got past every assignment check and stopped only at the (deliberately) unreachable PostgreSQL. */
function assertAccepted(result: { code: number | null; output: string }, label: string) {
  assert.equal(result.code, 78, `${label}: ${result.output}`);
  assert.match(result.output, /PostgreSQL .* did not answer/, `${label}: refused before the service checks: ${result.output}`);
}

test("migration: every state of the forward migration and of its rollback starts either cell after an unexpected restart", () => {
  const rollback = [...FORWARD].reverse();
  for (const [direction, states] of [["forward", FORWARD], ["rollback", rollback]] as const) {
    for (const state of states) {
      for (const cell of ["cell-1", "cell-2"] as const) {
        assertAccepted(guardFor(cell, state.manifest, state.env[cell]), `${direction} ${state.name}, ${cell} restarts`);
      }
    }
  }
});

test("migration: hosts may hold the old or the new manifest copy while it is being installed, at every manifest step", () => {
  // S0 -> S1 and S3 -> S4 change the manifest; each host's copy is replaced separately. Either copy must accept
  // the cell's current environment on that host.
  const steps: Array<[MigrationState, MigrationState]> = [[FORWARD[0]!, FORWARD[1]!], [FORWARD[3]!, FORWARD[4]!]];
  for (const [before, after] of steps) {
    for (const cell of ["cell-1", "cell-2"] as const) {
      assertAccepted(guardFor(cell, before.manifest, after.env[cell]), `${before.name} copy, ${cell}`);
      assertAccepted(guardFor(cell, after.manifest, before.env[cell]), `${after.name} copy, ${cell}`);
    }
  }
});

test("migration: the unsafe sequence (both rows auto while a cell is still static) is refused, which is why the plan never creates it", () => {
  const result = guardFor("cell-1", { "cell-1": "auto", "cell-2": "auto" }, STATIC1);
  assert.equal(result.code, 78);
  assert.match(result.output, /automatic only, but this environment gives it the static scope "1-4"; write auto\|1-4/, result.output);
  // And a cell switched to automatic before its row allows it.
  const early = guardFor("cell-2", { "cell-1": "1-4", "cell-2": "5-9" }, AUTO_ENV);
  assert.equal(early.code, 78);
  assert.match(early.output, /write auto \(or auto\|5-9 while migrating\)/, early.output);
});

test("migration: a transitional row still pins the static scope, keeps static scopes disjoint, and rejects malformed rows", () => {
  let result = guardFor("cell-1", { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, { scope: "1-5" });
  assert.equal(result.code, 78);
  assert.match(result.output, /differs from the manifest scope "1-4"/, result.output);
  result = guardFor("cell-1", { "cell-1": "auto|1-5", "cell-2": "auto|5-9" }, { scope: "1-5" });
  assert.equal(result.code, 78);
  assert.match(result.output, /phone 5 is in the scope of cell cell-1 and of cell cell-2/, result.output);
  for (const bad of ["auto|", "auto|auto", "5-9|auto", "automatic", "auto|x"]) {
    result = guardFor("cell-1", { "cell-1": bad, "cell-2": "5-9" }, AUTO_ENV);
    assert.equal(result.code, 78, bad);
    assert.match(result.output, /the assignment "/, `${bad}: ${result.output}`);
    assert.doesNotMatch(result.output, /PostgreSQL/, bad);
  }
  // A malformed row for the OTHER cell is refused too: the manifest must be valid as a whole.
  result = guardFor("cell-1", { "cell-1": "1-4", "cell-2": "auto|" }, STATIC1);
  assert.equal(result.code, 78);
  assert.match(result.output, /gives cell cell-2 the assignment "auto\|"/, result.output);
  // The journal line names the manifest assignment the cell started under.
  const ok = guardFor("cell-2", { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, AUTO_ENV);
  assertAccepted(ok, "S2 cell-2");
});

test("rollback after a phone was connected during automatic operation: the scopes are widened while both cells are automatic, so no state refuses either cell", () => {
  // Phone 10 was connected while the fleet was automatic; it is in neither original scope. The rollback first widens
  // the transitional rows (any auto|<scope> accepts an automatic cell), then switches each cell to the static part of
  // its row, then drops the auto| prefix. Every state accepts both cells, and phone 10 always has a cell.
  const W1: Env = { scope: "1-4,10" };
  const rollback: MigrationState[] = [
    { name: "S4", manifest: { "cell-1": "auto", "cell-2": "auto" }, env: { "cell-1": AUTO_ENV, "cell-2": AUTO_ENV } },
    { name: "S3 widened", manifest: { "cell-1": "auto|1-4,10", "cell-2": "auto|5-9" }, env: { "cell-1": AUTO_ENV, "cell-2": AUTO_ENV } },
    { name: "S2 cell-1 static (widened)", manifest: { "cell-1": "auto|1-4,10", "cell-2": "auto|5-9" }, env: { "cell-1": W1, "cell-2": AUTO_ENV } },
    { name: "S1 both static", manifest: { "cell-1": "auto|1-4,10", "cell-2": "auto|5-9" }, env: { "cell-1": W1, "cell-2": STATIC2 } },
    { name: "S0 prefix dropped", manifest: { "cell-1": "1-4,10", "cell-2": "5-9" }, env: { "cell-1": W1, "cell-2": STATIC2 } },
  ];
  for (const state of rollback) {
    for (const cell of ["cell-1", "cell-2"] as const) {
      assertAccepted(guardFor(cell, state.manifest, state.env[cell]), `${state.name}, ${cell} restarts`);
    }
  }
  // Why the order matters: widening a scope while the cell is already static has no safe order, and restoring the
  // pre-migration manifest after widening refuses the cell.
  let result = guardFor("cell-1", { "cell-1": "auto|1-4,10", "cell-2": "auto|5-9" }, STATIC1);
  assert.match(result.output, /differs from the manifest scope "1-4,10"/, result.output);
  result = guardFor("cell-1", { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, W1);
  assert.match(result.output, /differs from the manifest scope "1-4"/, result.output);
  result = guardFor("cell-1", { "cell-1": "1-4", "cell-2": "5-9" }, W1);
  assert.match(result.output, /differs from the manifest scope "1-4"/, result.output);
});

test("rollback from S2 after a phone was connected: only the automatic cell's row is widened, while that cell is still automatic", () => {
  // The runbook's rollback widens a row only while its cell is automatic. Rolling back from S2 (cell-1 static, cell-2
  // automatic), phone 10 is held by cell-2, so cell-2's row is widened before cell-2 turns static.
  const W2: Env = { scope: "5-9,10" };
  const rollback: MigrationState[] = [
    { name: "S2", manifest: { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, env: { "cell-1": STATIC1, "cell-2": AUTO_ENV } },
    { name: "S2 cell-2 row widened", manifest: { "cell-1": "auto|1-4", "cell-2": "auto|5-9,10" }, env: { "cell-1": STATIC1, "cell-2": AUTO_ENV } },
    { name: "S1 cell-2 static (widened)", manifest: { "cell-1": "auto|1-4", "cell-2": "auto|5-9,10" }, env: { "cell-1": STATIC1, "cell-2": W2 } },
    { name: "S0 prefix dropped", manifest: { "cell-1": "1-4", "cell-2": "5-9,10" }, env: { "cell-1": STATIC1, "cell-2": W2 } },
  ];
  for (const state of rollback) {
    for (const cell of ["cell-1", "cell-2"] as const) {
      assertAccepted(guardFor(cell, state.manifest, state.env[cell]), `${state.name}, ${cell} restarts`);
    }
  }
  for (let i = 1; i < rollback.length; i += 1) {
    if (JSON.stringify(rollback[i - 1]!.manifest) === JSON.stringify(rollback[i]!.manifest)) continue;
    for (const cell of ["cell-1", "cell-2"] as const) {
      assertAccepted(guardFor(cell, rollback[i - 1]!.manifest, rollback[i]!.env[cell]), `${rollback[i - 1]!.name} copy, ${cell}`);
      assertAccepted(guardFor(cell, rollback[i]!.manifest, rollback[i - 1]!.env[cell]), `${rollback[i]!.name} copy, ${cell}`);
    }
  }
  // Widening the static cell's row instead refuses it on its next restart.
  const result = guardFor("cell-1", { "cell-1": "auto|1-4,10", "cell-2": "auto|5-9" }, STATIC1);
  assert.match(result.output, /differs from the manifest scope "1-4,10"/, result.output);
});

test("dry run with a candidate env file: read like systemd's EnvironmentFile=, never executed, and only in a dry run", () => {
  const dry = { CAMPAIGN_CELL_GUARD_DRY_RUN: "1" };
  const rows = { "cell-1": "auto|1-4", "cell-2": "auto|5-9" };
  const marker = path.join(dir, "executed");
  const envFile = (name: string, body: string) => { const file = path.join(dir, name); writeFileSync(file, body); return file; };
  // Both variables set, with lines a shell would choke on or execute: refused (as systemd would pass both), and the
  // file is not run. The process environment's own assignment is ignored in favour of the file.
  const both = envFile("both.env", [
    "CAMPAIGN_TRANSPORT_PHONE_IDS=1-4",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN=tok(en)1",
    `X=$(touch ${marker})`,
    "CAMPAIGN_CELL_REQUIRED_ENV=BETTER_AUTH_SECRET BETTER_AUTH_URL",
    "CAMPAIGN_TRANSPORT_ASSIGNMENT=auto",
    "",
  ].join("\n"));
  let result = guardFor("cell-1", rows, STATIC1, { ...dry, CAMPAIGN_CELL_GUARD_ENV_FILE: both });
  assert.equal(result.code, 78, result.output);
  assert.match(result.output, /automatic cells take no scope/, result.output);
  assert.equal(existsSync(marker), false, "the env file was executed");
  // Comment lines, whitespace around key and value, quotes and the last assignment winning, as systemd reads them.
  const quoted = envFile("quoted.env", [
    "# CAMPAIGN_TRANSPORT_ASSIGNMENT=auto",
    "; CAMPAIGN_TRANSPORT_ASSIGNMENT=auto",
    "  CAMPAIGN_TRANSPORT_PHONE_IDS = \"9\"",
    "CAMPAIGN_TRANSPORT_PHONE_IDS='1-4'\r",
    "",
  ].join("\n"));
  result = guardFor("cell-1", rows, AUTO_ENV, { ...dry, CAMPAIGN_CELL_GUARD_ENV_FILE: quoted });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DRY-RUN OK .* assignment=static scope=1-4 phones=4 manifest_assignment=auto\|1-4 .* env=\S+quoted\.env/, result.output);
  const automatic = envFile("auto.env", "PORT=8080\nCAMPAIGN_TRANSPORT_ASSIGNMENT=auto\n");
  result = guardFor("cell-1", rows, STATIC1, { ...dry, CAMPAIGN_CELL_GUARD_ENV_FILE: automatic });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DRY-RUN OK .* assignment=auto manifest_assignment=auto\|1-4/, result.output);
  // Neither variable in the file: refused like a start with neither, whatever this process's environment holds.
  const neither = envFile("neither.env", "PORT=8080\n");
  result = guardFor("cell-1", rows, AUTO_ENV, { ...dry, CAMPAIGN_CELL_GUARD_ENV_FILE: neither });
  assert.equal(result.code, 78, result.output);
  assert.match(result.output, /CAMPAIGN_TRANSPORT_PHONE_IDS is unset or blank/, result.output);
  // A missing file, and an env file outside a dry run, are refused.
  result = guardFor("cell-1", rows, STATIC1, { ...dry, CAMPAIGN_CELL_GUARD_ENV_FILE: path.join(dir, "missing.env") });
  assert.equal(result.code, 78, result.output);
  assert.match(result.output, /environment file .* is missing or unreadable/, result.output);
  result = guardFor("cell-1", rows, STATIC1, { CAMPAIGN_CELL_GUARD_ENV_FILE: quoted });
  assert.equal(result.code, 78, result.output);
  assert.match(result.output, /CAMPAIGN_CELL_GUARD_ENV_FILE is for dry runs only/, result.output);
});

test("dry run: checks a candidate manifest and environment without starting anything, and refuses exactly as a start would", () => {
  const dry = { CAMPAIGN_CELL_GUARD_DRY_RUN: "1" };
  let result = guardFor("cell-2", { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, AUTO_ENV, dry);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DRY-RUN OK host=\S+ assignment=auto manifest_assignment=auto\|5-9/, result.output);
  assert.doesNotMatch(result.output, /PostgreSQL|Redis/, "no service is contacted");
  result = guardFor("cell-1", { "cell-1": "auto|1-4", "cell-2": "auto|5-9" }, STATIC1, dry);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DRY-RUN OK .* assignment=static scope=1-4 phones=4 manifest_assignment=auto\|1-4/, result.output);
  result = guardFor("cell-1", { "cell-1": "auto", "cell-2": "auto" }, STATIC1, dry);
  assert.equal(result.code, 78, "a candidate that would refuse the cell is refused in the dry run");
  assert.match(result.output, /REFUSING START: .*automatic only/, result.output);
});
