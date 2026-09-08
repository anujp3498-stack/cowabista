import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  parseWhatsAppStatuses,
  statusTransition,
  verifyWebhookSignature,
} from "../src/services/whatsapp-webhook";
import { buildMetaTemplatePayload } from "../src/services/whatsapp-template-sender";
import { describeTemplate, expandSharedMediaMapping } from "../src/services/template-mapping";
import { classifyProviderError, isRetryableProviderError, redactProviderText } from "../src/services/whatsapp-provider";
import { describeTemplate } from "../src/services/template-mapping";

test("validates webhook signatures over exact raw bytes", () => {
  const body = Buffer.from('{"entry":[]}');
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(body, signature, "secret"), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"entry":[]} '), signature, "secret"), false);
  assert.equal(verifyWebhookSignature(body, "sha256=bad", "secret"), false);
});

test("parses status events into deterministic dedupe identities", () => {
  const payload = { entry: [{ changes: [{ value: { statuses: [{
    id: "wamid.1", status: "failed", timestamp: "1700000000",
    errors: [{ code: 131026, title: "Undeliverable" }],
  }] } }] }] };
  const [status] = parseWhatsAppStatuses(payload);
  assert.equal(status?.eventId, "wamid.1:failed:1700000000:131026");
  assert.equal(status?.errorReason, "Undeliverable");
});

test("status transitions are monotonic and count funnel stages once", () => {
  assert.deepEqual(statusTransition("sent", "read"), {
    nextStatus: "read", delivered: 1, read: 1, failed: 0, apply: true,
  });
  assert.equal(statusTransition("read", "delivered").apply, false);
  assert.equal(statusTransition("delivered", "failed").apply, false);
  assert.equal(statusTransition("sent", "failed").failed, 1);
});

test("maps resolved values to Meta template components in numeric order", () => {
  const payload = buildMetaTemplatePayload("+15551234567", "approved_name", "en_US", {
    header: { "1": "Header" },
    body: { "2": "Second", "1": "First" },
    button: { "1:1": "code" },
  }, [{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://x/{{1}}" }, { type: "URL", url: "https://x/{{1}}" }] }]);
  assert.deepEqual(payload, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "+15551234567",
    type: "template",
    template: {
      name: "approved_name",
      language: { code: "en_US" },
      components: [
        { type: "header", parameters: [{ type: "text", text: "Header" }] },
        { type: "body", parameters: [{ type: "text", text: "First" }, { type: "text", text: "Second" }] },
        { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "code" }] },
      ],
    },
  });
});

test("maps all supported media header formats and preserves real URL button index", () => {
  for (const format of ["IMAGE", "VIDEO", "DOCUMENT"]) {
    const payload = buildMetaTemplatePayload("+1555", "t", "en_US", {
      header: { media: `https://cdn.example/${format}` }, body: { "1": "A" }, button: { "2:1": "tail" },
    }, [{
      type: "HEADER", format,
    }, {
      type: "BUTTONS", buttons: [
        { type: "URL", url: "https://example/{{1}}" },
        { type: "QUICK_REPLY", text: "no" },
        { type: "URL", url: "https://example/{{1}}" },
      ],
    }]);
    const components = (payload.template as { components: Record<string, unknown>[] }).components;
    assert.deepEqual(components[0], { type: "header", parameters: [{ type: format.toLowerCase(), [format.toLowerCase()]: { link: `https://cdn.example/${format}` } }] });
    assert.equal(components[2]?.index, "2");
  }
  assert.throws(() => buildMetaTemplatePayload("+1555", "t", "en_US", { button: { "1:1": "x" } }, [
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "no" }, { type: "URL", url: "fixed" }] },
  ]));
});

test("keeps one media-header concept compatible across heterogeneous template descriptors and payloads", () => {
  const templates = [
    {
      id: 101,
      body: "Hello {{1}}",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Hello {{1}}" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/{{1}}" }] },
      ],
      resolved: { header: { media: "https://cdn.example/shared.jpg" }, body: { "1": "Ada" }, button: { "0:1": "ada" } },
    },
    {
      id: 202,
      body: "Hello {{1}}, your {{2}} is ready",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Hello {{1}}, your {{2}} is ready" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/static" }, { type: "URL", url: "https://example.test/{{1}}/{{2}}" }] },
      ],
      resolved: {
        header: { media: "https://cdn.example/shared.jpg" },
        body: { "2": "order", "1": "Bea" },
        button: { "1:2": "receipt", "1:1": "bea" },
      },
    },
  ];

  const descriptors = templates.map(describeTemplate);
  assert.deepEqual(descriptors.map((descriptor) => descriptor.headerKind), ["image", "image"]);
  assert.deepEqual(descriptors.map((descriptor) => descriptor.requiredVariables), [
    ["body:1", "header:media", "button:0:1"],
    ["body:1", "body:2", "header:media", "button:1:1", "button:1:2"],
  ]);

  for (const template of templates) {
    const payload = buildMetaTemplatePayload("+1555", `template_${template.id}`, "en_US", template.resolved, template.components);
    const components = (payload.template as { components: Record<string, unknown>[] }).components;
    assert.deepEqual(components[0], {
      type: "header",
      parameters: [{ type: "image", image: { link: "https://cdn.example/shared.jpg" } }],
    });
    assert.equal((components.find((component) => component.type === "body")?.parameters as unknown[]).length, Object.keys(template.resolved.body).length);
    assert.equal(
      components.filter((component) => component.type === "button").length,
      Object.keys(template.resolved.button).length,
    );
  }
});

test("expands one shared media mapping without flattening per-template variables", () => {
  const descriptors = [
    describeTemplate({
      id: 11,
      body: "Hello {{1}}",
      components: [{ type: "HEADER", format: "IMAGE" }],
    }),
    describeTemplate({
      id: 12,
      body: "Hello {{1}} {{2}}",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/{{1}}" }] },
      ],
    }),
  ];
  const expanded = expandSharedMediaMapping(descriptors, [
    { templateId: 11, component: "header", variable: "media", source: "static", sourceValue: "https://cdn.test/shared.jpg" },
    { templateId: 11, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { templateId: 12, component: "body", variable: "1", source: "csv", sourceValue: "first_name" },
    { templateId: 12, component: "body", variable: "2", source: "csv", sourceValue: "order_id" },
    { templateId: 12, component: "button", variable: "0:1", source: "csv", sourceValue: "tracking_code" },
  ]);
  assert.deepEqual(
    expanded.filter((mapping) => mapping.component === "header"),
    [
      { templateId: 11, component: "header", variable: "media", source: "static", sourceValue: "https://cdn.test/shared.jpg" },
      { templateId: 12, component: "header", variable: "media", source: "static", sourceValue: "https://cdn.test/shared.jpg" },
    ],
  );
  assert.equal(expanded.filter((mapping) => mapping.component === "body").length, 3);
  assert.equal(expanded.filter((mapping) => mapping.component === "button").length, 1);
});

test("classifies retryable failures and redacts credentials", () => {
  assert.equal(classifyProviderError(429, { error: { message: "busy", code: 4 } }).retryable, true);
  assert.equal(classifyProviderError(400, { error: { message: "bad template", code: 132001 } }).retryable, false);
  assert.equal(isRetryableProviderError(classifyProviderError(429, {})), true);
  assert.equal(isRetryableProviderError(classifyProviderError(400, {})), false);
  const redacted = redactProviderText("Authorization: Bearer abc.def access_token=topsecret");
  assert.equal(redacted.includes("abc.def"), false);
  assert.equal(redacted.includes("topsecret"), false);
});

// A real Meta Cloud API send that gets throttled returns HTTP 400 with one
// of Meta's own rate-limit codes, not a generic 429 -- so the local TPS cap
// alone (a fixed number we configured) is not the only source of truth for
// "this number is currently rate-limited". Before this, a genuine Meta
// throttling response was classified as a permanent failure and the job
// was never retried, even though the correct behavior is to back off and
// let it succeed once the window clears.
test("classifies Meta's own throttling error codes as retryable, but a quality/spam restriction as permanent", () => {
  // 130429: per-number throughput/rate limit hit.
  assert.equal(classifyProviderError(400, { error: { message: "Rate limit hit", code: 130429 } }).retryable, true);
  // 131056: per-recipient-pair rate limit hit.
  assert.equal(classifyProviderError(400, { error: { message: "Pair rate limit hit", code: 131056 } }).retryable, true);
  // 131048: spam/quality-based sending restriction -- does not clear on a
  // short backoff, so it must stay a permanent failure the campaign
  // manager can see and act on, not something silently retried for an hour.
  assert.equal(classifyProviderError(400, { error: { message: "Spam rate limit hit", code: 131048 } }).retryable, false);
});