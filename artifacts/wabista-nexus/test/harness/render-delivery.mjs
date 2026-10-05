// Rendered check of the V2-06B Delivery step at 1280 and 375 px with the API
// mocked at the network layer (no Clerk, no API server, no provider). It
// validates the real component, its requests and states; it does NOT
// validate the authenticated page chrome or a real save end to end.
//   HARNESS_OUT=/tmp/h pnpm exec vite build --config vite.harness.config.ts
//   HARNESS_OUT=/tmp/h SHOTS=/tmp/shots node test/harness/render-delivery.mjs
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

// Server values (as the API computes them): ceilings 80 and 20, platform 1000.
const sender = (id, name, phone, ceiling, advancedRate = null) => ({
  phoneNumberId: id, phone, displayName: name, usable: true, providerApprovedRate: ceiling, platformRate: 1000, effectiveCeiling: ceiling, plannedRate: null, advancedRate,
  presetRates: { fastest_safe: ceiling, balanced: Math.max(1, Math.floor(ceiling * 0.6)), conservative: Math.min(ceiling, Math.max(5, Math.floor(ceiling * 0.25))) },
});
const setup = (over = {}) => ({
  campaignId: 7, revision: 5, status: "Draft", editable: true, editBlockedReason: null,
  distributionMode: "equal_numbers", deliveryMode: "balanced", deliverySettings: { perNumberRates: [] },
  senders: [sender(1, "Support line", "+15550000001", 80), sender(2, "Sales line", "+15550000002", 20)],
  templateCount: 3, totalMessagesPerSecond: 60, recipients: 12000, estimatedDurationSeconds: 200, platformMaxMessagesPerSecond: 1000,
  modeSummaries: [
    { deliveryMode: "fastest_safe", totalMessagesPerSecond: 100, estimatedDurationSeconds: 120 },
    { deliveryMode: "balanced", totalMessagesPerSecond: 60, estimatedDurationSeconds: 200 },
    { deliveryMode: "conservative", totalMessagesPerSecond: 25, estimatedDurationSeconds: 480 },
  ],
  problems: [],
  ...over,
});
const preflight = (blockers = []) => ({
  campaignId: 7, status: "Draft", ready: blockers.length === 0, evaluatedAt: "2026-10-05T00:00:00Z",
  recipients: { audienceGeneration: 0, total: 12100, valid: 12000, invalid: 100, duplicate: 0, suppressed: 0, suppressedSinceImport: 0 },
  senders: [], templates: [], distribution: { mode: "equal_numbers", allocatorVersion: "v2" }, delivery: { mode: "balanced", totalMessagesPerSecond: 60, perSender: [] },
  compatibility: { valid: true, problems: [] }, estimate: { messagesPerSecond: 60, durationSeconds: 200 }, media: [], provider: { mode: "mock", status: "configured", health: null, ready: true },
  health: { lastWebhookEventAt: null, lastProviderHealthAt: null },
  warnings: [{ code: "invalid_rows_skipped", severity: "warning", message: "100 rows of the audience are invalid and will be skipped.", action: "Review them in the Audience step if needed.", subject: {}, technicalDetail: null }],
  blockers, technicalDetails: { allocatorVersion: "v2", platformMaxMessagesPerSecond: 1000, readinessErrors: [] },
});

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
for (const width of [1280, 375]) {
  for (const scenario of ["flow", "locked", "blocked"]) {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 740 : 900 } });
    const seen = { puts: [] };
    let state = scenario === "locked"
      ? setup({ status: "Running", editable: false, editBlockedReason: "Messages have already been queued or sent for this campaign, so its message setup can no longer change." })
      : scenario === "blocked" ? setup({ distributionMode: null, deliveryMode: null, totalMessagesPerSecond: null, estimatedDurationSeconds: null }) : setup();
    const blockers = scenario === "blocked"
      ? [{ code: "distribution_required", severity: "blocker", message: "Choose how recipients are shared between your numbers and templates.", action: "Choose a distribution in the Delivery step.", subject: {}, technicalDetail: null },
        { code: "delivery_required", severity: "blocker", message: "Choose a sending speed.", action: "Choose a speed in the Delivery step.", subject: {}, technicalDetail: null }]
      : [];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const p = new URL(request.url()).pathname;
      if (p === "/api/organizations/1/campaigns/7/delivery-setup" && request.method() === "GET") return route.fulfill({ json: state });
      if (p === "/api/organizations/1/campaigns/7/delivery-setup" && request.method() === "PUT") {
        const body = JSON.parse(request.postData() ?? "{}");
        seen.puts.push(body);
        if (seen.puts.length === 1) {
          return route.fulfill({ status: 400, json: { error: "Some speeds are not valid", code: "delivery_invalid", details: ["Support line can send at most 80 messages/sec. Set its speed to 80 messages/sec or less."] } });
        }
        if (seen.puts.length === 3) {
          return route.fulfill({ status: 409, json: { error: "This save was based on revision 6 but the campaign setup is at revision 7. Reload to see the latest changes.", code: "stale_revision" } });
        }
        state = { ...state, revision: state.revision + 1, distributionMode: body.distributionMode, deliveryMode: body.deliveryMode,
          deliverySettings: body.deliverySettings ?? state.deliverySettings,
          senders: state.senders.map((s) => ({ ...s, advancedRate: body.deliverySettings?.perNumberRates?.find((r) => r.phoneNumberId === s.phoneNumberId)?.messagesPerSecond ?? s.advancedRate,
            plannedRate: body.deliverySettings?.perNumberRates?.find((r) => r.phoneNumberId === s.phoneNumberId)?.messagesPerSecond ?? s.plannedRate })),
          totalMessagesPerSecond: body.deliveryMode === "advanced" ? body.deliverySettings.perNumberRates.reduce((a, r) => a + r.messagesPerSecond, 0) : state.totalMessagesPerSecond };
        return route.fulfill({ json: state });
      }
      if (p === "/api/organizations/1/campaigns/7/preflight") return route.fulfill({ json: preflight(blockers) });
      return route.fulfill({ status: 404, json: { error: "no mock" } });
    });
    await page.goto(`${base}/?view=delivery&status=${scenario === "locked" ? "Running" : "Draft"}`);
    await page.getByTestId("delivery-summary").waitFor();
    const checks = {};
    checks.steps = await page.getByTestId("campaign-steps").getByRole("link").allTextContents();
    checks.currentStep = await page.getByTestId("step-delivery").getAttribute("aria-current");
    if (scenario === "flow") {
      // Hydrated from the server.
      checks.hydratedDistribution = await page.getByTestId("choice-equal_numbers").getByRole("radio").getAttribute("aria-checked");
      checks.hydratedSpeed = await page.getByTestId("choice-balanced").getByRole("radio").getAttribute("aria-checked");
      checks.savedTotal = await page.getByTestId("summary-total-speed").textContent();
      checks.saveDisabledWhenClean = await page.getByTestId("button-save-delivery").isDisabled();
      // Change distribution and choose Advanced.
      await page.getByTestId("choice-equal_templates").click();
      await page.getByTestId("choice-advanced").click();
      checks.advancedRows = await page.locator("[data-testid^=advanced-row-]").count();
      checks.advancedPrefill = [await page.getByTestId("input-rate-1").inputValue(), await page.getByTestId("input-rate-2").inputValue()];
      // A fractional rate shows an inline hint and blocks saving.
      await page.getByTestId("input-rate-2").fill("2.5");
      checks.fractionHint = await page.getByTestId("rate-hint-2").textContent();
      checks.saveDisabledWithHint = await page.getByTestId("button-save-delivery").isDisabled();
      await page.getByTestId("input-rate-2").fill("10");
      checks.dirtyTotal = await page.getByTestId("summary-total-speed").textContent();
      // The server's validation error is displayed with its details.
      await page.getByTestId("button-save-delivery").click();
      await page.getByTestId("alert-delivery-save-error").waitFor();
      checks.serverError = await page.getByTestId("alert-delivery-save-error").textContent();
      // A valid save sends the revision it was based on and the typed rates.
      await page.getByTestId("input-rate-1").fill("40");
      await page.getByTestId("button-save-delivery").click();
      await page.waitForFunction(() => document.querySelector("[data-testid=text-delivery-save-state]")?.textContent?.startsWith("All changes are saved"));
      checks.savedPayload = seen.puts.at(-1);
      checks.savedState = await page.getByTestId("text-delivery-save-state").textContent();
      // A stale revision is reported with a reload action; nothing is overwritten.
      await page.getByTestId("choice-fastest_safe").click();
      await page.getByTestId("button-save-delivery").click();
      await page.getByTestId("button-reload-delivery").waitFor();
      checks.staleError = await page.getByTestId("alert-delivery-save-error").textContent();
      checks.stalePayloadRevision = seen.puts.at(-1).revision;
      await page.getByTestId("button-reload-delivery").click();
      await page.waitForFunction(() => document.querySelector("[data-testid=text-delivery-save-state]")?.textContent?.startsWith("All changes are saved"));
      checks.afterReloadSpeed = await page.getByTestId("choice-advanced").getByRole("radio").getAttribute("aria-checked");
      checks.check = await page.getByTestId("delivery-check").textContent();
    } else if (scenario === "locked") {
      checks.banner = await page.getByTestId("banner-delivery-locked").textContent();
      checks.saveDisabled = await page.getByTestId("button-save-delivery").isDisabled();
      checks.radiosDisabled = await page.getByTestId("choice-fastest_safe").getByRole("radio").isDisabled();
    } else {
      checks.check = await page.getByTestId("delivery-check").textContent();
      checks.blockerCodes = await page.locator("[data-testid^=check-blocker-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
      checks.totalUnknown = await page.getByTestId("summary-total-speed").textContent();
    }
    checks.launchButtons = await page.getByRole("button", { name: /launch/i }).count();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    checks.horizontalOverflow = scrollWidth > width;
    checks.saveButtonVisible = await page.getByTestId("button-save-delivery").isVisible();
    const file = path.join(shots, `delivery-${scenario}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ scenario, width, file, ...checks });
    await page.close();
  }
}
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
