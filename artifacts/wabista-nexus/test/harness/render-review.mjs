// Rendered check of the V2-06C Review & Launch step at 1280 and 375 px with
// the API mocked at the network layer (no Clerk, no API server, no
// provider). Validates the real component, its requests and states; NOT
// the authenticated page chrome or a real launch end to end.
//   HARNESS_OUT=/tmp/h pnpm exec vite build --config vite.harness.config.ts
//   HARNESS_OUT=/tmp/h SHOTS=/tmp/shots node test/harness/render-review.mjs
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

const issue = (code, message, action) => ({ code, severity: "blocker", message, action, subject: {}, technicalDetail: null });
const report = (over = {}) => ({
  campaignId: 7, status: "Draft", ready: true, evaluatedAt: "2026-10-05T00:00:00Z",
  recipients: { audienceGeneration: 0, total: 12100, valid: 12000, invalid: 60, duplicate: 30, suppressed: 8, suppressedSinceImport: 2 },
  senders: [
    { phoneNumberId: 1, phone: "+15550000001", displayName: "Support line", status: "Connected", setupState: "active", quality: null, transport: "workspace_credential", usable: true, providerApprovedRate: 80, effectiveCeiling: 80, plannedRate: 48, eligibleTemplateIds: [201, 202] },
    { phoneNumberId: 2, phone: "+15550000002", displayName: "Sales line", status: "Connected", setupState: "active", quality: "Low", transport: "workspace_credential", usable: true, providerApprovedRate: 20, effectiveCeiling: 20, plannedRate: 12, eligibleTemplateIds: [201] },
  ],
  templates: [
    { templateId: 201, name: "spring_offer", language: "en_US", status: "Approved", headerKind: "image", usable: true, eligibleSenderIds: [1, 2], missingVariables: [], missingColumns: [] },
    { templateId: 202, name: "october_news", language: "en_US", status: "Approved", headerKind: "none", usable: true, eligibleSenderIds: [1], missingVariables: [], missingColumns: [] },
  ],
  distribution: { mode: "equal_numbers", allocatorVersion: "v2" },
  delivery: { mode: "balanced", totalMessagesPerSecond: 60, perSender: [] },
  compatibility: { valid: true, problems: [] },
  estimate: { messagesPerSecond: 60, durationSeconds: 200 },
  media: [{ templateId: 201, mediaAssetId: 41, fileName: "banner.png", kind: "image", expectedKind: "image", status: "ready", ok: true, providerPrepared: false }],
  provider: { mode: "real", status: "configured", health: "healthy", ready: true },
  health: { lastWebhookEventAt: null, lastProviderHealthAt: null },
  warnings: [{ code: "sender_quality_low", severity: "warning", message: "Sales line has a low quality rating at WhatsApp.", action: "Consider a slower speed or another number.", subject: {}, technicalDetail: null }],
  blockers: [],
  technicalDetails: { allocatorVersion: "v2", platformMaxMessagesPerSecond: 1000, readinessErrors: [] },
  ...over,
});
const projection = {
  approximate: true, available: true, reason: null, distributionMode: "equal_numbers", recipients: 12000,
  senders: [
    { phoneNumberId: 1, phone: "+15550000001", displayName: "Support line", plannedRate: 48, approxShare: 0.5, approxRecipients: 6000, templates: [{ templateId: 201, name: "spring_offer", approxShare: 0.25, approxRecipients: 3000 }, { templateId: 202, name: "october_news", approxShare: 0.25, approxRecipients: 3000 }] },
    { phoneNumberId: 2, phone: "+15550000002", displayName: "Sales line", plannedRate: 12, approxShare: 0.5, approxRecipients: 6000, templates: [{ templateId: 201, name: "spring_offer", approxShare: 0.5, approxRecipients: 6000 }] },
  ],
  templates: [{ templateId: 201, name: "spring_offer", approxShare: 0.75, approxRecipients: 9000 }, { templateId: 202, name: "october_news", approxShare: 0.25, approxRecipients: 3000 }],
};
const lifecycle = { id: 7, organizationId: 1, name: "Spring launch", status: "Running", audienceSize: 12000, sent: 0, delivered: 0, read: 0, failed: 0, scheduleLabel: "Unscheduled", routeCount: 2, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
for (const width of [1280, 375]) {
  for (const scenario of ["now", "schedule", "blocked", "launched", "race"]) {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 740 : 900 } });
    const seen = { actions: [], previews: [] };
    let state = scenario === "blocked"
      ? report({ ready: false, blockers: [issue("mapping_missing", "spring_offer has a value that is not filled in.", "Fill in every variable in the Message step."), issue("credential_not_ready", "Sales line's WhatsApp connection is not active.", "Reconnect the number's WhatsApp account in Numbers.")] })
      : scenario === "launched" ? report({ status: "Running" }) : report();
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const p = new URL(request.url()).pathname;
      if (p === "/api/organizations/1/campaigns/7/preflight") return route.fulfill({ json: state });
      if (p === "/api/organizations/1/campaigns/7/review") return route.fulfill({ json: scenario === "blocked" ? { ...projection, available: false, reason: "Fix the items that need attention to see how recipients are shared.", senders: [], templates: [] } : projection });
      if (p === "/api/organizations/1/campaigns/7/review/preview") {
        seen.previews.push(JSON.parse(request.postData() ?? "{}"));
        return route.fulfill({ json: { contactId: 501, normalizedPhone: "+447700900001", willSend: true, reason: null,
          decision: { allocatorVersion: "v2", routeId: 11, sender: { phoneNumberId: 2, phone: "+15550000002", displayName: "Sales line" }, template: { templateId: 201, name: "spring_offer", language: "en_US" } },
          message: { resolved: { header: {}, body: { "1": "Ada" }, button: {} }, headerMedia: { mediaAssetId: 41, fileName: "banner.png", kind: "image" }, unresolved: [] } } });
      }
      if (p === "/api/organizations/1/campaigns/7/actions") {
        const body = JSON.parse(request.postData() ?? "{}");
        seen.actions.push(body);
        if (scenario === "race") {
          state = report({ ready: false, blockers: [issue("sender_unusable", "Sales line cannot send right now.", "Reconnect the number in Numbers, or remove it in the Message step.")] });
          return route.fulfill({ status: 409, json: { error: "The campaign is not ready to launch", code: "launch_blocked", blockers: state.blockers, details: ["Sales line cannot send right now."] } });
        }
        state = report({ status: body.scheduledAt ? "Scheduled" : "Running" });
        return route.fulfill({ json: { ...lifecycle, status: body.scheduledAt ? "Scheduled" : "Running", launch: { outcome: body.scheduledAt ? "scheduled" : "launched", planId: 3, queuedNew: body.scheduledAt ? 0 : 12000 } } });
      }
      return route.fulfill({ status: 404, json: { error: "no mock" } });
    });
    await page.goto(`${base}/?view=review`);
    await page.getByTestId("review-summary").waitFor();
    const checks = {};
    checks.steps = await page.getByTestId("campaign-steps").getByRole("link").allTextContents();
    checks.currentStep = await page.getByTestId("step-review").getAttribute("aria-current");
    checks.doNotContact = await page.getByTestId("review-do-not-contact").textContent();
    checks.speed = await page.getByTestId("review-planned-speed").textContent();
    checks.launchEnabled = !(await page.getByTestId("button-launch").isDisabled());
    checks.planButtons = await page.getByRole("button", { name: /^(plan|execute)$/i }).count();
    if (scenario === "now" || scenario === "race") {
      checks.projectionSender = await page.getByTestId("projection-sender-1").textContent();
      await page.getByTestId("button-preview-recipient").click();
      await page.getByTestId("preview-result").waitFor();
      checks.preview = [await page.getByTestId("preview-sender").textContent(), await page.getByTestId("preview-template").textContent(), await page.getByTestId("preview-values").textContent()];
      await page.getByTestId("button-launch").click();
      await page.getByTestId("dialog-launch").waitFor();
      checks.dialog = await page.getByTestId("dialog-launch").textContent();
      await page.getByTestId("button-confirm-launch").click();
      if (scenario === "race") {
        await page.getByTestId("alert-launch-error").waitFor();
        checks.launchError = await page.getByTestId("alert-launch-error").textContent();
        await page.waitForTimeout(300);
        checks.launchEnabledAfterRefusal = !(await page.getByTestId("button-launch").isDisabled());
      } else {
        await page.waitForFunction(() => window.location.pathname === "/campaigns/7");
        checks.navigatedTo = await page.evaluate(() => window.location.pathname);
      }
      checks.actionBodies = seen.actions;
    } else if (scenario === "schedule") {
      await page.getByTestId("choice-schedule").click();
      checks.disabledWithoutTime = await page.getByTestId("button-launch").isDisabled();
      await page.getByTestId("input-schedule-at").fill("2020-01-01T09:00");
      checks.disabledPastTime = await page.getByTestId("button-launch").isDisabled();
      const future = new Date(Date.now() + 3 * 86400000);
      const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T09:30`;
      await page.getByTestId("input-schedule-at").fill(local);
      await page.getByTestId("button-launch").click();
      await page.getByTestId("button-confirm-launch").click();
      await page.waitForFunction(() => window.location.pathname === "/campaigns/7");
      checks.scheduleBody = seen.actions[0];
      checks.scheduleMatchesLocal = new Date(seen.actions[0].scheduledAt).getTime() === new Date(local).getTime();
    } else if (scenario === "blocked") {
      checks.blockers = await page.locator("[data-testid^=blocker-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
      checks.variablesCheck = await page.getByTestId("check-variables").textContent();
      checks.connectionCheck = await page.getByTestId("check-connection").textContent();
      checks.projection = await page.getByTestId("projection-unavailable").textContent();
      checks.state = await page.getByTestId("text-launch-state").textContent();
    } else {
      checks.banner = await page.getByTestId("banner-launched").textContent();
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    checks.horizontalOverflow = scrollWidth > width;
    const file = path.join(shots, `review-${scenario}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ scenario, width, file, ...checks });
    await page.close();
  }
}
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
