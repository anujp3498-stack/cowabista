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

function runGuard(scope: string, otherScope: string) {
  const manifest = path.join(dir, `manifest-${scope}-${otherScope}`);
  writeFileSync(manifest, `cell-1 ${hostname()} ${scope}\ncell-2 another-host ${otherScope}\n`);
  const result = spawnSync("bash", [guard], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, CAMPAIGN_CELL: "cell-1", CAMPAIGN_CELL_MANIFEST: manifest, CAMPAIGN_TRANSPORT_PHONE_IDS: scope,
      NODE_ENV: "production", CAMPAIGN_COORDINATOR_MODE: "redis", CAMPAIGN_REDIS_URL: "redis://127.0.0.1:1",
      DATABASE_URL: "postgresql://guard-test@127.0.0.1:1/none", PORT: "1", CAMPAIGN_CELL_WAIT_SECONDS: "1",
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
