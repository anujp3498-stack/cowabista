// Rendered check of the template draft editor's "Submit to Meta" failure
// handling, with the API mocked at the network layer (no auth server, no API
// server, no Meta). Validates the REAL component: a 409/502 answer that
// carries the updated draft is adopted and explained (never a bare
// "HTTP 409 Conflict" / "HTTP 502 Bad Gateway"), TemplateDraftError answers
// keep their handling, and nothing is ever resubmitted automatically.
//   HARNESS_OUT=/tmp/h pnpm exec vite build --config vite.harness.config.ts
//   HARNESS_OUT=/tmp/h SHOTS=/tmp/shots node test/harness/render-template-editor.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const out = process.env.HARNESS_OUT;
const shots = process.env.SHOTS ?? path.join(out, "shots");
mkdirSync(shots, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const file = path.join(out, (req.url ?? "/").split("?")[0] === "/" ? "index.html" : (req.url ?? "/").split("?")[0]);
  try { const body = await readFile(file); res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const draft = (over = {}) => ({
  id: 12, wabaId: 3, wabaDisplayName: "Acme WABA", name: "promo_v1", language: "en_US", category: "MARKETING",
  content: { header: { kind: "none" }, body: { text: "Hello there", examples: [] }, footer: null, buttons: [] },
  revision: 5, state: "draft", providerTemplateId: null, providerStatus: null, providerStatusCheckedAt: null, templateId: null,
  lastError: null, latestAttempt: null, validation: [], createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:01:00Z",
  ...over,
});
// lastError texts exactly as the server's classifyOutcome writes them.
const META_REASON = "Meta refused the template: Invalid parameter";
const UNREACHABLE = "WhatsApp (Meta) did not confirm whether the template was created. Reconcile before anything else; nothing is retried automatically.";
const scenarios = {
  failed: { submit: { status: 409, json: draft({ state: "failed", lastError: META_REASON }) } },
  reconcile: { submit: { status: 502, json: draft({ state: "reconcile_required", lastError: UNREACHABLE }) } },
  submitting: { submit: { status: 409, json: draft({ state: "submitting" }) } },
  "error-in-progress": { submit: { status: 409, json: { error: "A submission for this draft is already in progress.", code: "attempt_in_progress", attempt: null } } },
  "error-stale": { save: { status: 409, json: { error: "This draft changed since you loaded it. Reload it and try again.", code: "stale_revision" } } },
};

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const results = [];
for (const [name, scenario] of Object.entries(scenarios)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const seen = { saves: [], submits: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    if (p === "/api/organizations/1/template-authoring/wabas") return route.fulfill({ json: [{ id: 3, displayName: "Acme WABA", externalId: "waba-ext-1", authoringSupported: true, reason: null, mediaSupported: true }] });
    if (p === "/api/organizations/1/template-drafts/12" && request.method() === "PATCH") {
      seen.saves.push(JSON.parse(request.postData() ?? "{}"));
      return route.fulfill(scenario.save ?? { json: draft() });
    }
    if (p === "/api/organizations/1/template-drafts/12/submit" && request.method() === "POST") {
      seen.submits.push(JSON.parse(request.postData() ?? "{}"));
      return route.fulfill(scenario.submit);
    }
    return route.fulfill({ status: 404, json: { error: "no mock" } });
  });
  await page.goto(`${base}/?view=template-editor`);
  await page.getByTestId("dialog-template-draft").waitFor();
  await page.getByTestId("button-draft-submit").click();
  await page.getByTestId("alert-draft-editor").waitFor();
  await page.waitForTimeout(600); // nothing may be resubmitted on its own
  const checks = {
    banner: (await page.getByTestId("alert-draft-editor").textContent())?.trim(),
    dialogText: await page.getByTestId("dialog-template-draft").textContent(),
    state: (await page.getByTestId("chip-draft-state").textContent())?.trim(),
    nameDisabled: await page.getByTestId("input-draft-name").isDisabled(),
    submitButtons: await page.getByTestId("button-draft-submit").count(),
    lastError: (await page.getByTestId("text-draft-last-error").count()) ? (await page.getByTestId("text-draft-last-error").textContent())?.trim() : null,
    saves: seen.saves.length,
    submits: seen.submits.length,
    submitBodies: seen.submits,
  };
  const file = path.join(shots, `template-editor-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  results.push({ scenario: name, file, ...checks });
  await page.close();
}
await browser.close();
server.close();
console.log(JSON.stringify(results.map(({ dialogText, ...rest }) => rest), null, 2));

const by = Object.fromEntries(results.map((r) => [r.scenario, r]));
for (const r of results) {
  assert.doesNotMatch(r.dialogText, /HTTP 4\d\d|HTTP 5\d\d|Conflict|Bad Gateway/, `${r.scenario}: no bare HTTP status on screen`);
}
// 409 + draft `failed`: adopted, editable again, Meta's reason shown, one submit only.
assert.match(by.failed.banner, /^The template was not submitted/);
assert.ok(by.failed.banner.includes(META_REASON));
assert.match(by.failed.state, /Refused by Meta/, "the returned draft's state (failed) is adopted");
assert.equal(by.failed.lastError, META_REASON, "the returned draft's lastError is adopted");
assert.equal(by.failed.nameDisabled, false, "a failed draft is editable again");
assert.equal(by.failed.submitButtons, 1, "it can be submitted again by the user");
assert.deepEqual([by.failed.saves, by.failed.submits], [1, 1]);
assert.deepEqual(by.failed.submitBodies, [{ expectedRevision: 5 }]);
// 502 + draft `reconcile_required`: adopted, locked, says reconciliation is needed and no automatic retry.
assert.match(by.reconcile.banner, /^Meta did not confirm the submission/);
assert.match(by.reconcile.banner, /not resubmitted automatically/);
assert.match(by.reconcile.banner, /stays locked until Meta confirms the outcome/);
assert.ok(by.reconcile.banner.includes(UNREACHABLE));
assert.match(by.reconcile.state, /Outcome unknown/, "the returned draft's state (reconcile_required) is adopted");
assert.equal(by.reconcile.lastError, UNREACHABLE);
assert.equal(by.reconcile.nameDisabled, true, "locked");
assert.equal(by.reconcile.submitButtons, 0, "no way to submit again until reconciled");
assert.deepEqual([by.reconcile.saves, by.reconcile.submits], [1, 1]);
// Returned draft still `submitting`: in progress, locked, no second submit.
assert.match(by.submitting.banner, /^Submission already in progress/);
assert.equal(by.submitting.nameDisabled, true);
assert.equal(by.submitting.submitButtons, 0);
assert.equal(by.submitting.submits, 1);
// TemplateDraftError bodies keep their existing handling.
assert.match(by["error-in-progress"].banner, /A submission for this draft is already in progress\./);
assert.equal(by["error-in-progress"].submits, 1);
assert.match(by["error-stale"].banner, /^This draft changed elsewhere/);
assert.equal(by["error-stale"].submits, 0, "a refused save never submits");
console.log("template editor render check: PASS");
