// Rendered check of the V2-04 compatibility UI at desktop and 375px, with
// the API mocked at the network layer. Run after building the harness:
//   HARNESS_OUT=/tmp/h pnpm exec vite build --config vite.harness.config.ts
//   HARNESS_OUT=/tmp/h SHOTS=/tmp/shots node test/harness/render-check.mjs
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

const compatibility = {
  evaluatedAt: new Date().toISOString(),
  numbers: [
    { phoneNumberId: 1, phone: "+15550000001", displayName: "Phone X", wabaId: 10, wabaExternalId: "waba-x", transport: "workspace_credential", eligibleTemplateIds: [101], code: "eligible" },
    { phoneNumberId: 2, phone: "+15550000002", displayName: "Phone Y", wabaId: 11, wabaExternalId: "waba-y", transport: "workspace_credential", eligibleTemplateIds: [], code: "eligible" },
  ],
  templates: [
    { templateId: 101, name: "tx1", language: "en_US", wabaId: 10, wabaExternalId: "waba-x", eligiblePhoneNumberIds: [1], evidence: { source: "workspace_credential", verifiedAt: "2026-10-01T00:00:00Z" }, code: "eligible" },
    { templateId: 103, name: "tz1", language: "en_US", wabaId: 12, wabaExternalId: "waba-z", eligiblePhoneNumberIds: [], evidence: null, code: "waba_mismatch" },
  ],
  incompatiblePairs: [
    { phoneNumberId: 2, templateId: 101, code: "waba_mismatch", message: "m" },
    { phoneNumberId: 1, templateId: 103, code: "waba_mismatch", message: "m" },
    { phoneNumberId: 2, templateId: 103, code: "waba_mismatch", message: "m" },
  ],
  numbersWithoutTemplate: [2],
  templatesWithoutNumber: [103],
};
const mocks = {
  "/api/organizations": [{ id: 1, name: "Acme", slug: "acme", role: "owner", isActive: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
  "/api/campaigns": [{ id: 7, organizationId: 1, name: "Festive push", status: "Draft", isSample: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
  "/api/phone-numbers": [
    { id: 1, organizationId: 1, phone: "+15550000001", displayName: "Phone X", status: "Connected", quality: "High", tpsLimit: 80, wabaId: 10, wabaExternalId: "waba-x", wabaDisplayName: "WABA X", isSample: false, setupState: "active", credentialId: 1, sendingCredentialId: 1 },
    { id: 2, organizationId: 1, phone: "+15550000002", displayName: "Phone Y", status: "Connected", quality: "High", tpsLimit: 80, wabaId: 11, wabaExternalId: "waba-y", wabaDisplayName: "WABA Y", isSample: false, setupState: "active", credentialId: 1, sendingCredentialId: 1 },
  ],
  "/api/templates": [
    { id: 101, organizationId: 1, name: "tx1", status: "Approved", language: "en_US", category: "Marketing", body: "Hello", components: [], isSample: false, wabaId: 10, wabaExternalId: "waba-x", wabaDisplayName: "WABA X", source: "workspace_credential", providerStatus: "APPROVED", providerMissing: false },
    { id: 103, organizationId: 1, name: "tz1", status: "Approved", language: "en_US", category: "Marketing", body: "Hello", components: [], isSample: false, wabaId: 12, wabaExternalId: "waba-z", wabaDisplayName: "WABA Z", source: "workspace_credential", providerStatus: "APPROVED", providerMissing: false },
  ],
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
for (const width of [1280, 375]) {
  for (const view of ["matrix", "rocket", "template"]) {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 740 : 900 } });
    const requests = [];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      requests.push(`${route.request().method()} ${url.pathname}`);
      if (url.pathname.endsWith("/whatsapp/compatibility")) { await route.fulfill({ json: compatibility }); return; }
      const body = mocks[url.pathname];
      if (body) { await route.fulfill({ json: body }); return; }
      await route.fulfill({ status: 404, json: { error: "no mock" } });
    });
    await page.goto(`${base}/?view=${view}`);
    const checks = {};
    if (view === "matrix") {
      checks.summary = await page.getByTestId("compatibility-summary").first().textContent();
      checks.problem = await page.getByTestId("compatibility-template-problem-103").textContent();
      checks.stranded = await page.getByTestId("compatibility-numbers-without-template").textContent();
      checks.ok = await page.getByTestId("matrix-ok").textContent();
      checks.loading = await page.getByTestId("matrix-loading").textContent();
      checks.error = await page.getByTestId("matrix-error").textContent();
      checks.empty = await page.getByTestId("matrix-empty").textContent();
    } else if (view === "rocket") {
      await page.getByTestId("rocket-number-1").getByRole("checkbox").click();
      await page.getByTestId("rocket-number-2").getByRole("checkbox").click();
      await page.getByTestId("rocket-template-101").click();
      await page.getByTestId("rocket-template-103").click();
      await page.getByTestId("rocket-compatibility").waitFor();
      await page.getByTestId("compatibility-summary").waitFor();
      checks.summary = await page.getByTestId("compatibility-summary").textContent();
      checks.saveDisabled = await page.getByTestId("button-save-rocket-setup").isDisabled();
      checks.compatibilityRequests = requests.filter((r) => r.includes("compatibility")).length;
      // Deselect the stranded template: the summary must follow the new selection.
      await page.getByTestId("rocket-template-103").click();
      await page.waitForTimeout(300);
      checks.summaryAfterChange = await page.getByTestId("compatibility-summary").textContent();
    } else {
      await page.getByTestId("template-available-on-101").waitFor();
      await page.waitForTimeout(300);
      checks.availableOn = await page.getByTestId("template-available-on-101").textContent();
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    checks.horizontalOverflow = scrollWidth > width;
    const file = path.join(shots, `${view}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ view, width, file, ...checks });
    await page.close();
  }
}
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
