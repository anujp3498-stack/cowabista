// Rendered check of the V2-05B Message Studio at desktop and 375px with the
// API mocked at the network layer (no Clerk, no API server, no provider).
// It validates the real component, its requests and states; it does NOT
// validate the authenticated page chrome or a real save/send end to end.
//   HARNESS_OUT=/tmp/h pnpm exec vite build --config vite.harness.config.ts
//   HARNESS_OUT=/tmp/h SHOTS=/tmp/shots node test/harness/render-message.mjs
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
const pngPath = path.join(shots, "banner.png");
await writeFile(pngPath, Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"));

const now = "2026-10-04T00:00:00Z";
const IMG = { templateId: 201, name: "spring_offer", language: "en_US", category: "Marketing", status: "Approved", wabaId: 10, wabaLabel: "Main account", body: "Hi {{1}}, your code is {{2}}",
  components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}, your code is {{2}}" }, { type: "FOOTER", text: "Reply STOP to opt out" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop", url: "https://shop.test/{{1}}" }, { type: "PHONE_NUMBER", text: "Call us", phone_number: "+15550001111" }] }],
  headerKind: "image", selected: true, usable: true, code: "eligible", message: "Approved at Meta",
  requirements: [
    { key: "body:1", component: "body", variable: "1", label: "Body {{1}}", mediaKind: null },
    { key: "body:2", component: "body", variable: "2", label: "Body {{2}}", mediaKind: null },
    { key: "header:media", component: "header", variable: "media", label: "Header image", mediaKind: "image" },
    { key: "button:0:1", component: "button", variable: "0:1", label: "Button 1 link {{1}}", mediaKind: null },
  ] };
const NEWS = { templateId: 202, name: "october_news", language: "en_GB", category: "Utility", status: "Approved", wabaId: 10, wabaLabel: "Main account", body: "Dear {{1}}",
  components: [{ type: "HEADER", format: "TEXT", text: "News for {{1}}" }, { type: "BODY", text: "Dear {{1}}" }], headerKind: "text", selected: true, usable: true, code: "eligible", message: "Approved at Meta",
  requirements: [{ key: "body:1", component: "body", variable: "1", label: "Body {{1}}", mediaKind: null }, { key: "header:1", component: "header", variable: "1", label: "Header {{1}}", mediaKind: null }] };
const OTHER = { ...NEWS, templateId: 203, name: "other_account_promo", wabaId: 11, wabaLabel: "Other account", selected: false, requirements: [] };
const setup = (over = {}) => ({
  campaignId: 7, revision: 3, status: "Draft", editable: true, editBlockedReason: null, reopenRequired: false, executionHistory: false, importInProgress: false,
  senders: [
    { phoneNumberId: 1, phone: "+15550000001", displayName: "Support line", status: "Connected", wabaId: 10, wabaLabel: "Main account", tpsLimit: 80, transport: "workspace_credential", usable: true, code: "eligible", message: "Ready to send", selected: true, compatibleTemplateIds: [201, 202] },
    { phoneNumberId: 2, phone: "+15550000002", displayName: "Sales line", status: "Connected", wabaId: 10, wabaLabel: "Main account", tpsLimit: 80, transport: "workspace_credential", usable: true, code: "eligible", message: "Ready to send", selected: true, compatibleTemplateIds: [201, 202] },
    { phoneNumberId: 3, phone: "+15550000003", displayName: "Old number", status: "Disconnected", wabaId: 10, wabaLabel: "Main account", tpsLimit: 80, transport: null, usable: false, code: "phone_not_connected", message: "The number is not connected for sending", selected: false, compatibleTemplateIds: [] },
  ],
  sendersTruncated: false,
  templates: [IMG, NEWS, { ...OTHER, compatibleSenderIds: [] }].map((t) => ({ compatibleSenderIds: t.templateId === 203 ? [] : [1, 2], ...t })),
  templatesTruncated: false,
  selection: { senderPhoneNumberIds: [1, 2], templateIds: [201, 202] },
  mappings: [
    { templateId: 201, component: "body", variable: "1", source: "csv", sourceValue: "first_name", mediaAssetId: null, optional: false, fallbackValue: null },
    { templateId: 202, component: "header", variable: "1", source: "static", sourceValue: "October", mediaAssetId: null, optional: false, fallbackValue: null },
  ],
  execution: { executable: true, code: "ok", message: "Each selected number sends one selected template.", assignments: [{ phoneNumberId: 1, templateId: 201 }, { phoneNumberId: 2, templateId: 202 }] },
  audienceGeneration: 0,
  audienceColumns: [{ name: "phone", availability: "all" }, { name: "first_name", availability: "all" }, { name: "customer_id", availability: "all" }, { name: "city", availability: "some" }],
  mediaAssets: [],
  ...over,
});

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
for (const width of [1280, 375]) {
  for (const scenario of ["flow", "locked", "multi"]) {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 740 : 900 } });
    const seen = { puts: [], previews: [], uploads: [], testSends: [] };
    let state = scenario === "locked"
      ? setup({ status: "Paused", editable: false, editBlockedReason: "Messages have already been queued or sent for this campaign, so its message setup can no longer change.", executionHistory: true })
      : scenario === "multi"
        ? setup({ selection: { senderPhoneNumberIds: [1], templateIds: [201, 202] }, execution: { executable: false, code: "needs_multi_template", message: "Every template has a compatible number, but some number would have to send more than one template. Sending several templates from one number arrives with the next milestone (V2-06).", assignments: [] } })
        : setup();
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const p = new URL(request.url()).pathname;
      if (p === "/api/organizations/1/campaigns/7/message-setup" && request.method() === "GET") return route.fulfill({ json: state });
      if (p === "/api/organizations/1/campaigns/7/message-setup" && request.method() === "PUT") {
        const body = JSON.parse(request.postData() ?? "{}");
        seen.puts.push(body);
        if (seen.puts.length === 1 && body.mappings.some((m) => m.variable === "2" && m.sourceValue === "BAD")) {
          return route.fulfill({ status: 400, json: { error: "Some mappings are invalid", code: "invalid_mappings", details: ["Enter a value for template 201 body:2"] } });
        }
        state = { ...state, revision: state.revision + 1, mappings: body.mappings, selection: { senderPhoneNumberIds: body.senderPhoneNumberIds, templateIds: body.templateIds } };
        return route.fulfill({ json: state });
      }
      if (p === "/api/organizations/1/campaigns/7/message-setup/preview") {
        const body = JSON.parse(request.postData() ?? "{}");
        seen.previews.push(body);
        const m = (variable, component = "body") => body.mappings?.find((x) => x.variable === variable && x.component === component && x.templateId === body.templateId);
        const valueOf = (mapping) => mapping ? (mapping.source === "csv" ? { first_name: "Ada", customer_id: "C-77" }[mapping.sourceValue] : mapping.sourceValue) : undefined;
        const resolved = { header: {}, body: {}, button: {} };
        const unresolved = [];
        const reqs = body.templateId === 201 ? IMG.requirements : NEWS.requirements;
        let headerMedia = null;
        for (const r of reqs) {
          const mapping = m(r.variable, r.component);
          if (r.key === "header:media") {
            if (mapping) headerMedia = { mediaAssetId: Number(mapping.sourceValue), fileName: "banner.png", kind: "image" }; else unresolved.push({ key: r.key, reason: "unmapped" });
            continue;
          }
          const value = valueOf(mapping);
          if (value === undefined || value === "") unresolved.push({ key: r.key, reason: mapping ? "empty_value" : "unmapped" }); else resolved[r.component][r.variable] = value;
        }
        return route.fulfill({ json: { templateId: body.templateId, contact: { id: 501, normalizedPhone: "+447700900001", rowNumber: 2 }, resolved, headerMedia, unresolved } });
      }
      if (p === "/api/organizations/1/campaigns/7/contacts/search") return route.fulfill({ json: { items: [{ id: 501, organizationId: 1, campaignId: 7, rowNumber: 2, rawPhone: "+447700900001", normalizedPhone: "+447700900001", data: {}, status: "Valid", idempotencyKey: "k", audienceGeneration: 0, createdAt: now, updatedAt: now }], nextCursor: null } });
      if (p === "/api/organizations/1/mapping-presets") return route.fulfill({ json: [{ id: 9, organizationId: 1, name: "Standard", entries: [], createdAt: now, updatedAt: now }] });
      if (p === "/api/organizations/1/campaigns/7/media" && request.method() === "POST") {
        seen.uploads.push({ headers: request.headers(), bytes: (request.postDataBuffer() ?? Buffer.alloc(0)).length });
        const asset = { id: 41, campaignId: 7, fileName: "banner.png", contentType: "image/png", byteLength: 29, kind: "image", status: "ready", createdAt: now };
        state = { ...state, mediaAssets: [asset] };
        return route.fulfill({ status: 201, json: asset });
      }
      if (p.startsWith("/api/organizations/1/campaigns/7/media/41/content")) return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") });
      if (p === "/api/organizations/1/campaigns/7/message-setup/test-send") {
        seen.testSends.push(JSON.parse(request.postData() ?? "{}"));
        return route.fulfill({ json: { result: "sent", code: null, message: "Test message accepted by WhatsApp for +447700900001.", providerMessageId: "wamid.x" } });
      }
      return route.fulfill({ status: 404, json: { error: "no mock" } });
    });
    await page.goto(`${base}/?view=message&status=${scenario === "locked" ? "Paused" : "Draft"}`);
    await page.getByTestId("execution-summary").waitFor();
    const checks = {};
    if (scenario === "flow") {
      checks.disabledSenderReason = await page.getByTestId("sender-reason-3").textContent();
      checks.disabledSenderCheckbox = await page.getByTestId("sender-3").getByRole("checkbox").isDisabled();
      checks.incompatibleTemplate = await page.getByTestId("template-compat-203").textContent();
      checks.unmappedBefore = await page.getByTestId("unmapped-201").textContent();
      // Upload one image and assign it to the image header.
      await page.getByTestId("input-upload-media").setInputFiles(pngPath);
      await page.getByTestId("media-asset-41").waitFor();
      checks.upload = { contentType: seen.uploads[0]?.headers["content-type"], fileName: seen.uploads[0]?.headers["x-file-name"], rawBytes: seen.uploads[0]?.bytes };
      await page.getByTestId("slot-201-header:media").getByRole("combobox").click();
      await page.getByRole("option", { name: "banner.png" }).click();
      // Fill body {{2}} with fixed text and the URL button from a column.
      await page.getByTestId("source-201-body:2").click();
      await page.getByRole("option", { name: "Fixed text" }).click();
      await page.getByTestId("static-201-body:2").fill("BAD");
      await page.getByTestId("column-201-button:0:1").click();
      await page.getByRole("option", { name: "customer_id" }).click();
      await page.waitForTimeout(600);
      checks.previewBody = await page.getByTestId("preview-body").textContent();
      checks.previewButton = await page.getByTestId("preview-button-0").textContent();
      checks.previewUnresolved = await page.getByTestId("preview-unresolved-count").textContent();
      checks.previewMediaTag = await page.getByTestId("preview-media-header").evaluate((el) => el.tagName);
      checks.testSendDisabledWhileDirty = await page.getByTestId("button-open-test-send").isDisabled();
      // V2-06B: with unsaved changes the only way forward saves first.
      checks.saveAndContinueWhileDirty = await page.getByTestId("button-save-continue-delivery").isVisible();
      checks.plainContinueWhileDirty = await page.getByTestId("button-continue-delivery").count();
      // A server validation error is shown with its details; then a valid save.
      await page.getByTestId("button-save-message-setup").click();
      await page.getByTestId("alert-save-error").waitFor();
      checks.saveError = await page.getByTestId("alert-save-error").textContent();
      await page.getByTestId("static-201-body:2").fill("VIP");
      await page.getByTestId("button-save-message-setup").click();
      await page.waitForFunction(() => document.querySelector("[data-testid=text-save-state]")?.textContent?.startsWith("All changes are saved"));
      checks.savedRevisionSent = seen.puts.at(-1).revision;
      checks.continueHrefWhenSaved = await page.getByTestId("button-continue-delivery").getAttribute("href");
      checks.savedMappings = seen.puts.at(-1).mappings.filter((m) => m.templateId === 201).map((m) => `${m.component}:${m.variable}=${m.source}:${m.sourceValue}`).sort();
      // Shared default: copy body {{1}} of the image template to the news template (its body {{1}} is empty).
      await page.getByTestId("share-201-body:1").click();
      await page.waitForTimeout(200);
      checks.sharedCopy = await page.getByTestId("column-202-body:1").textContent();
      await page.getByTestId("button-save-message-setup").click();
      await page.waitForFunction(() => document.querySelector("[data-testid=text-save-state]")?.textContent?.startsWith("All changes are saved"));
      // Test send dialog.
      await page.getByTestId("button-open-test-send").click();
      await page.getByTestId("dialog-test-send").waitFor();
      await page.getByTestId("button-confirm-test-send").click();
      await page.getByTestId("test-send-outcome").waitFor();
      checks.testSendOutcome = await page.getByTestId("test-send-outcome").textContent();
      checks.testSendBody = seen.testSends[0];
      checks.dialogOverflow = await page.getByTestId("dialog-test-send").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      await page.screenshot({ path: path.join(shots, `message-test-send-${width}.png`) });
      await page.keyboard.press("Escape");
    } else if (scenario === "locked") {
      checks.banner = await page.getByTestId("banner-message-locked").textContent();
      checks.saveDisabled = await page.getByTestId("button-save-message-setup").isDisabled();
      checks.senderDisabled = await page.getByTestId("sender-1").getByRole("checkbox").isDisabled();
    } else {
      checks.execution = await page.getByTestId("execution-summary").textContent();
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    checks.horizontalOverflow = scrollWidth > width;
    const file = path.join(shots, `message-${scenario}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ scenario, width, file, ...checks });
    await page.close();
  }
}
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
