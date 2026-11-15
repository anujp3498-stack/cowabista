// The systemd cell guard (deploy/systemd/campaign-cell-guard.sh) refuses to start a cell whose phone scope
// overlaps another cell's in the fleet manifest, including multi-digit phone ids (the overlap check compares
// sorted id lists, which must be in the order `comm` expects). Runs the real script with bash; the database and
// Redis addresses point at closed ports, so a scope the guard accepts stops later, at the PostgreSQL check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(result.output, /write auto in its scope column/, result.output);
});

test("a static cell is refused when the manifest makes it automatic, and a static cell next to an automatic one is not checked for overlap", () => {
  let result = runGuard("5-9", "1-4", {}, "auto");
  assert.equal(result.code, 78);
  assert.match(result.output, /makes cell cell-1 automatic but this environment gives it the static scope/, result.output);
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
