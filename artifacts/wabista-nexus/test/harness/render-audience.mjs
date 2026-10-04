// Rendered check of the V2-05A Audience workspace at desktop and 375px with
// the API mocked at the network layer (no Clerk, no API server). This
// validates the real component, its requests and its states; it does NOT
// validate the authenticated page chrome or a real upload end to end.
//   HARNESS_OUT=/tmp/h pnpm exec vite build --config vite.harness.config.ts
//   HARNESS_OUT=/tmp/h SHOTS=/tmp/shots node test/harness/render-audience.mjs
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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

const csvPath = path.join(shots, "audience.csv");
await writeFile(csvPath, "﻿Phone,Name,Name\n7700900123,Zoë,A\n+447700900124,\"Bob, Jr\",B\n");

const now = "2026-10-04T00:00:00Z";
const session = (over) => ({
  id: 11, organizationId: 1, campaignId: 7, idempotencyKey: "k", fileName: "audience.csv", status: "Completed", phoneColumn: "Phone",
  defaultCountryCode: "44", columns: ["Phone", "Name", "Name_2"], bytesProcessed: 80, rowsProcessed: 3, validRows: 2, invalidRows: 0,
  duplicateRows: 1, suppressedRows: 0, error: null, operation: "append", audienceGeneration: 0, activatedAt: null, createdAt: now, updatedAt: now, ...over,
});
const emptyAudience = (over = {}) => ({
  campaignId: 7, status: "Draft", audienceGeneration: 0, editable: true, reopenRequired: false, executionHistory: false,
  importInProgress: false, activeSessionId: null, totals: { rows: 0, valid: 0, invalid: 0, duplicates: 0, suppressed: 0, sessions: 0 }, sessions: [], ...over,
});
const sniff = {
  columns: ["Phone", "Name", "Name_2"], headerWarnings: ['Column 3 repeats the header "Name"; it is available as "Name_2"'],
  sample: [["7700900123", "Zoë", "A"], ["+447700900124", "Bob, Jr", "B"]], sampleRows: 2, truncated: false, bytesInspected: 80,
  phoneColumnSuggestion: "Phone", countryCode: { decision: "required", nationalSampleCount: 1, internationalSampleCount: 1 },
};
const campaign = { id: 7, name: "Spring launch", status: "Draft", audienceSize: 0, sent: 0, delivered: 0, read: 0, failed: 0, schedule: "Unscheduled", routesCount: 0, isSample: false, creationKey: "k", revision: 4, audienceGeneration: 0, createdAt: now, updatedAt: now };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
for (const width of [1280, 375]) {
  for (const scenario of ["flow", "reopen", "frozen"]) {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 740 : 900 } });
    const seen = { sniffBody: null, upload: null, patches: [], actions: [] };
    let uploaded = false;
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const p = url.pathname;
      if (p === "/api/organizations/1/campaigns/7/audience") {
        if (scenario === "reopen") return route.fulfill({ json: emptyAudience({ status: "Ready", editable: false, reopenRequired: true, totals: { rows: 3, valid: 2, invalid: 0, duplicates: 1, suppressed: 0, sessions: 1 }, sessions: [session({})] }) });
        if (scenario === "frozen") return route.fulfill({ json: emptyAudience({ status: "Paused", editable: false, executionHistory: true, totals: { rows: 3, valid: 2, invalid: 0, duplicates: 1, suppressed: 0, sessions: 1 }, sessions: [session({})] }) });
        return route.fulfill({ json: uploaded ? emptyAudience({ totals: { rows: 4, valid: 2, invalid: 1, duplicates: 1, suppressed: 0, sessions: 1 }, sessions: [session({ idempotencyKey: seen.upload?.headers["idempotency-key"], invalidRows: 1 })] }) : emptyAudience() });
      }
      if (p === "/api/organizations/1/campaigns/7/imports/sniff") {
        seen.sniffBody = request.postData();
        return route.fulfill({ json: sniff });
      }
      if (p === "/api/organizations/1/campaigns/7/imports" && request.method() === "POST") {
        seen.upload = { headers: request.headers(), body: request.postData() };
        uploaded = true;
        return route.fulfill({ status: 202, json: session({ idempotencyKey: request.headers()["idempotency-key"], duplicateRows: 0 }) });
      }
      if (p === "/api/campaigns/7" && request.method() === "PATCH") {
        const body = JSON.parse(request.postData() ?? "{}");
        seen.patches.push(body);
        if (seen.patches.length === 1) return route.fulfill({ status: 409, json: { error: "stale", code: "stale_revision", campaign: { ...campaign, revision: 4 } } });
        return route.fulfill({ json: { ...campaign, name: body.name, revision: body.revision + 1 } });
      }
      if (p === "/api/organizations/1/campaigns/7/actions") {
        seen.actions.push(JSON.parse(request.postData() ?? "{}"));
        return route.fulfill({ json: { ...campaign, organizationId: 1, scheduleLabel: "Unscheduled", priority: "Normal", killSwitch: false, routeCount: 0 } });
      }
      return route.fulfill({ status: 404, json: { error: "no mock" } });
    });
    const status = scenario === "reopen" ? "Ready" : scenario === "frozen" ? "Paused" : "Draft";
    await page.goto(`${base}/?view=audience&status=${status}`);
    await page.getByTestId("stat-audience-valid").waitFor();
    const checks = {};
    if (scenario === "flow") {
      checks.emptyCopy = await page.locator("section[aria-label='Audience summary'] p").textContent();
      await page.getByTestId("input-audience-csv").setInputFiles(csvPath);
      await page.getByTestId("table-sniff-sample").waitFor();
      checks.sniffBodyIsRawCsv = typeof seen.sniffBody === "string" && seen.sniffBody.includes("Phone,Name,Name") && !seen.sniffBody.startsWith('"');
      checks.headerWarnings = await page.getByTestId("list-header-warnings").textContent();
      checks.uploadDisabledWithoutCountry = await page.getByTestId("button-start-audience-upload").isDisabled();
      await page.getByTestId("input-audience-country-code").fill("44");
      checks.uploadEnabledWithCountry = await page.getByTestId("button-start-audience-upload").isEnabled();
      await page.getByTestId("button-start-audience-upload").click();
      await page.getByTestId("alert-upload-done").waitFor();
      checks.uploadHeaders = {
        phone: seen.upload.headers["x-phone-column"], country: seen.upload.headers["x-default-country-code"],
        operation: seen.upload.headers["x-import-operation"], hasKey: Boolean(seen.upload.headers["idempotency-key"]),
        rawBody: (seen.upload.body ?? "").includes("7700900123"),
      };
      await page.getByTestId("row-audience-session-11").waitFor();
      checks.sessionRow = await page.getByTestId("row-audience-session-11").textContent();
      checks.rejectedHref = await page.getByTestId("link-download-rejected-11").getAttribute("href");
      checks.duplicatesHref = await page.getByTestId("link-download-duplicates-11").getAttribute("href");
      // Autosave: first PATCH is answered stale, the edit is rebased on the server revision and saved.
      await page.getByTestId("input-campaign-name").fill("Spring launch 2");
      await page.waitForFunction(() => document.querySelector("[data-testid=text-name-save-state]")?.textContent === "Saved", null, { timeout: 5000 });
      checks.patches = seen.patches;
      checks.continueHref = await page.getByTestId("link-continue-to-message").getAttribute("href");
      checks.noLifecycleActions = seen.actions.length === 0;
    } else if (scenario === "reopen") {
      checks.banner = await page.getByTestId("banner-audience-reopen").textContent();
      checks.dropzoneDisabled = await page.getByTestId("dropzone-audience-csv").getAttribute("aria-disabled");
      await page.getByTestId("button-reopen-campaign").click();
      await page.waitForTimeout(300);
      checks.actions = seen.actions;
    } else {
      checks.banner = await page.getByTestId("banner-audience-frozen").textContent();
      checks.reopenOffered = await page.getByTestId("button-reopen-campaign").count();
      checks.dropzoneDisabled = await page.getByTestId("dropzone-audience-csv").getAttribute("aria-disabled");
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    checks.horizontalOverflow = scrollWidth > width;
    const file = path.join(shots, `audience-${scenario}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ scenario, width, file, ...checks });
    await page.close();
  }
}
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
