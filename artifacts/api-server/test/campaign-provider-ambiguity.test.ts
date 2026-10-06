// Provider delivery ambiguity / duplicate-send safety.
//
// Meta documents no idempotency key for POST /{phone-number-id}/messages
// (the official v23.0 spec documents only a 200 for sendMessage), so a
// resend after an outcome that MAY have been accepted can deliver the same
// WhatsApp message twice. Classification under test:
//   definitely not sent (DNS / connect / TLS-certificate failure) -> retryable
//   definitely refused by Meta (4xx)  -> permanent, except documented
//                                        throttling (429 / rate-limit codes)
//   outcome unknown (5xx, 2xx without a message id, connection lost after
//   the request may have been written, timeout, abort)
//                                     -> ProviderOutcomeUnknownError / a
//                                        non-provider error: settled as
//                                        delivery_unknown, never re-sent.
// Everything talks to local fake Graph servers; nothing leaves the process.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { campaignJobsTable, campaignsTable, db, pool, providerMessagesTable, settlementPool } from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";
import { CampaignTransportShards } from "../src/services/campaign-transport-shards";
import { sendDirectWhatsAppMessage } from "../src/services/whatsapp-direct-sender";
import { classifyProviderError, isPreConnectFailure, isRetryableProviderError, ProviderOutcomeUnknownError, ProviderRequestError, RealWhatsAppProviderClient } from "../src/services/whatsapp-provider";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { createCampaign, deleteOrganization, seedAudience, TOKEN, workspaceWorld } from "./message-studio-fixtures";
import { firstNameMappings, saveSetup } from "./v2-fixtures";

// ------------------------------------------------------------ fake Graph

type Behaviour = "ok" | "no-id" | "bad-json" | "reset" | "hang" | { status: number; code: number };
const plan: Behaviour[] = [];
const received: Array<{ url: string; body: string }> = [];
let server: Server;
let baseUrl: string;

before(async () => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
  server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ url: req.url ?? "", body });
      const behaviour = plan.shift() ?? "ok";
      if (behaviour === "reset") { req.socket.destroy(); return; } // the full request was received, no response
      if (behaviour === "hang") return;
      res.setHeader("content-type", "application/json");
      if (behaviour === "no-id") { res.end(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: "1" }], messages: [] })); return; }
      if (behaviour === "bad-json") { res.end("{\"messages\":[{\"id\":"); return; }
      if (behaviour === "ok") { res.end(JSON.stringify({ messages: [{ id: `wamid.ambiguity.${received.length}` }] })); return; }
      res.writeHead(behaviour.status);
      res.end(JSON.stringify({ error: { message: `fake ${behaviour.status} (${TOKEN})`, type: "OAuthException", code: behaviour.code, fbtrace_id: "AXtrace", is_transient: behaviour.status >= 500 } }));
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Worker threads copy process.env at creation: set before any shard exists.
  process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = baseUrl;
});
after(async () => {
  delete process.env.CAMPAIGN_TEST_GRAPH_BASE_URL;
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([pool.end(), settlementPool.end()]);
});

const PAYLOAD = { messaging_product: "whatsapp", recipient_type: "individual", to: "+15550001111", type: "template", template: { name: "t", language: { code: "en_US" } } };
const send = (options: { fetchImpl?: Parameters<typeof sendDirectWhatsAppMessage>[0]["fetchImpl"]; url?: string; signal?: AbortSignal } = {}) =>
  sendDirectWhatsAppMessage({ accessToken: TOKEN, providerPhoneId: "555000", payload: PAYLOAD, signal: options.signal ?? AbortSignal.timeout(5_000), fetchImpl: options.fetchImpl, baseUrl: options.url ?? baseUrl });
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try { return { value: await promise }; } catch (error) { return error; }
}
const unknownOutcome = (error: unknown, label: string) => {
  assert.ok(error instanceof ProviderOutcomeUnknownError, `${label}: unknown outcome, got ${String(error)}`);
  assert.ok(!(error instanceof ProviderRequestError) && !isRetryableProviderError(error), `${label}: never a (retryable) provider rejection`);
  assert.ok(!error.message.includes(TOKEN), `${label}: token scrubbed`);
};
const networkCause = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });

// ------------------------------------------------- classification (unit)

test("direct sender: 2xx + id -> the id; 4xx -> permanent; 401/190 -> permanent; 429 / rate-limit -> retryable (Meta refused it)", async () => {
  plan.push("ok", { status: 400, code: 100 }, { status: 401, code: 190 }, { status: 403, code: 10 }, { status: 429, code: 130429 }, { status: 400, code: 131056 });
  const ok = await send();
  assert.match(ok, /^wamid\.ambiguity\./);
  for (const [label, retryable] of [["400/100", false], ["401/190", false], ["403/10", false], ["429/130429", true], ["400/131056", true]] as const) {
    const error = await outcome(send());
    assert.ok(error instanceof ProviderRequestError, `${label}: a definite provider answer`);
    assert.equal(error.retryable, retryable, label);
    assert.ok(!error.message.includes(TOKEN));
  }
});

test("direct sender: HTTP 500/502/503/504 -> outcome unknown, even when Meta marks it is_transient (no idempotency on /messages)", async () => {
  for (const status of [500, 502, 503, 504]) {
    plan.push({ status, code: 2 });
    const error = await outcome(send());
    unknownOutcome(error, `HTTP ${status}`);
    assert.equal((error as ProviderOutcomeUnknownError).status, status);
  }
});

test("direct sender: HTTP 408 on /messages -> outcome unknown, one dispatch; control-plane 408 classification stays retryable", async () => {
  const before = received.length;
  plan.push({ status: 408, code: 1 });
  const error = await outcome(send());
  unknownOutcome(error, "HTTP 408");
  assert.equal((error as ProviderOutcomeUnknownError).status, 408);
  assert.equal(received.length, before + 1, "exactly one request");
  // The shared classifier (template sync, uploads, management calls) is unchanged.
  assert.equal(classifyProviderError(408, {}).retryable, true);
});

test("direct sender: 2xx without a message id, or with an unreadable body -> outcome unknown", async () => {
  plan.push("no-id", "bad-json");
  unknownOutcome(await outcome(send()), "2xx without id");
  unknownOutcome(await outcome(send()), "2xx with truncated JSON");
  const nonString = await outcome(send({ fetchImpl: async () => new Response(JSON.stringify({ messages: [{ id: 42 }] }), { status: 200 }) }));
  unknownOutcome(nonString, "2xx with a non-string id");
});

test("direct sender: connection reset AFTER the request reached the server -> outcome unknown, not a retryable network error", async () => {
  const before = received.length;
  plan.push("reset");
  const error = await outcome(send());
  assert.equal(received.length, before + 1, "the fake provider received the whole request");
  unknownOutcome(error, "reset after dispatch");
  // A raw socket server that accepts the bytes and closes without answering.
  const raw = createNetServer((socket) => { socket.once("data", () => socket.destroy()); });
  await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
  try {
    unknownOutcome(await outcome(send({ url: `http://127.0.0.1:${(raw.address() as AddressInfo).port}` })), "socket closed after request bytes");
  } finally { await new Promise<void>((resolve) => raw.close(() => resolve())); }
});

test("direct sender: failures before a connection exists (refused, DNS, connect timeout, TLS certificate) -> retryable network error", async () => {
  const closed = createNetServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const refused = await outcome(send({ url: `http://127.0.0.1:${port}` }));
  assert.ok(refused instanceof ProviderRequestError && refused.retryable && refused.code === "network", `real ECONNREFUSED: ${String(refused)}`);
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    const error = await outcome(send({ fetchImpl: async () => { throw networkCause(code); } }));
    assert.ok(error instanceof ProviderRequestError && error.retryable, code);
  }
  // Happy-eyeballs: every address refused -> pre-connect; one ambiguous -> unknown.
  const allRefused = Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), Object.assign(new Error("b"), { code: "ENETUNREACH" })]) });
  assert.equal(isPreConnectFailure(allRefused), true);
  const mixed = Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), Object.assign(new Error("b"), { code: "ECONNRESET" })]) });
  assert.equal(isPreConnectFailure(mixed), false);
  for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]) {
    unknownOutcome(await outcome(send({ fetchImpl: async () => { throw networkCause(code); } })), code);
  }
  unknownOutcome(await outcome(send({ fetchImpl: async () => { throw new TypeError("fetch failed"); } })), "cause-less failure");
});

test("direct sender: a timeout or ownership abort after dispatch stays a non-provider error (delivery_unknown path)", async () => {
  plan.push("hang");
  const controller = new AbortController();
  const pending = outcome(send({ signal: controller.signal }));
  while (!received.length || received.at(-1)!.body === "") await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort(new Error("Phone ownership revoked"));
  const error = await pending;
  assert.ok(error instanceof Error && !(error instanceof ProviderRequestError), String(error));
  server.closeAllConnections();
});

test("legacy connector send: 5xx and 2xx without id -> outcome unknown; 4xx -> provider rejection; transport failure -> non-provider error", async () => {
  const reply = (status: number, body: unknown) => new RealWhatsAppProviderClient({ transport: async () => new Response(JSON.stringify(body), { status }) });
  unknownOutcome(await outcome(reply(503, { error: { message: "down", code: 2 } }).send("p", PAYLOAD)), "legacy 503");
  unknownOutcome(await outcome(reply(200, { messages: [] }).send("p", PAYLOAD)), "legacy 2xx without id");
  let calls = 0;
  const timedOut = new RealWhatsAppProviderClient({ transport: async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "Request timeout", code: 1 } }), { status: 408 }); } });
  unknownOutcome(await outcome(timedOut.send("p", PAYLOAD)), "legacy 408");
  assert.equal(calls, 1, "legacy 408: one dispatch");
  const refused = await outcome(reply(400, { error: { message: "bad", code: 100 } }).send("p", PAYLOAD));
  assert.ok(refused instanceof ProviderRequestError && !refused.retryable);
  assert.equal(await reply(200, { messages: [{ id: "wamid.legacy" }] }).send("p", PAYLOAD), "wamid.legacy");
  const lost = await outcome(new RealWhatsAppProviderClient({ transport: async () => { throw new Error("socket hang up"); } }).send("p", PAYLOAD));
  assert.ok(lost instanceof Error && !(lost instanceof ProviderRequestError), "already settled as delivery_unknown");
});

test("transport shard boundary: an unknown outcome crosses the worker thread as a NON-provider error", async () => {
  const shards = new CampaignTransportShards(1);
  const auth = { kind: "workspace_credential" as const, organizationId: 7, credentialId: 11, credentialRevision: 1 };
  try {
    shards.updatePhoneOwnership(4242, { fencingToken: 1, validUntilMs: Date.now() + 60_000 });
    await shards.bindPhoneCredential(4242, { ...auth, accessToken: TOKEN });
    for (const behaviour of [{ status: 503, code: 2 }, "no-id", "reset"] as const) {
      plan.push(behaviour);
      const result = await shards.dispatch(4242, 1, Date.now(), { kind: "whatsapp", mode: "real", providerPhoneId: "555000", payload: PAYLOAD, timeoutMs: 5_000, auth }, new AbortController().signal);
      result.acknowledge();
      assert.ok(result.error, JSON.stringify(behaviour));
      assert.ok(!(result.error instanceof ProviderRequestError), `${JSON.stringify(behaviour)}: settles as delivery_unknown, not 'rejected'`);
    }
    plan.push({ status: 429, code: 130429 });
    const throttled = await shards.dispatch(4242, 1, Date.now(), { kind: "whatsapp", mode: "real", providerPhoneId: "555000", payload: PAYLOAD, timeoutMs: 5_000, auth }, new AbortController().signal);
    throttled.acknowledge();
    assert.ok(throttled.error instanceof ProviderRequestError && throttled.error.retryable, "429 stays a retryable provider rejection");
  } finally { await shards.close(); }
});

// ------------------------------------- end to end: real worker settlement

async function oneJobCampaign(label: string) {
  const slug = `ambiguity-${label}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "amb_t", body: "Hi {{1}}" }] });
  const org = world.organization.id;
  const campaign = await createCampaign(org, slug);
  await seedAudience(org, campaign.id, ["phone", "first_name"], [{ phone: `+4477330${String(org % 100000).padStart(5, "0")}`, first_name: "Ann" }]);
  const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id], mappings: firstNameMappings([world.templates[0]!.id]), distributionMode: "equal_numbers" });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  await planCampaign(org, campaign.id);
  await executeCampaignPlan(org, campaign.id);
  const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
  return { org, campaignId: campaign.id, jobId: job!.id, slug };
}

async function runUntilSettled(jobId: number, label: string, options: { stopOnRetry?: boolean } = {}, deadlineMs = 30_000) {
  const worker = new CampaignWorker(new DatabaseJobQueue(), new WhatsAppTemplateSender(), new RouteTpsLimiter(), `${label}-worker`);
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, jobId));
    if (job!.status !== "Processing" && job!.status !== "Queued") return job!;
    if (options.stopOnRetry !== false && job!.status === "Queued" && job!.attempts > 0) return job!; // scheduled retry: caller decides
    if (Date.now() > deadline) assert.fail(`${label}: job still ${job!.status}`);
    const result = await worker.processOne();
    if (result === "idle") await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
const intent = async (jobId: number) => (await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, jobId)))[0];
const requestsFor = (to: string) => received.filter((r) => r.url.endsWith("/messages") && r.body.includes(to)).length;

/** Even if the job is put back in the queue (operator / recovery), the durable intent blocks a second HTTP request. */
async function assertNeverResent(fixture: Awaited<ReturnType<typeof oneJobCampaign>>, to: string) {
  await db.update(campaignsTable).set({ status: "Running" }).where(eq(campaignsTable.id, fixture.campaignId));
  await db.update(campaignJobsTable).set({ status: "Queued", availableAt: new Date(Date.now() - 1000) }).where(eq(campaignJobsTable.id, fixture.jobId));
  const job = await runUntilSettled(fixture.jobId, `${fixture.slug}-requeued`, { stopOnRetry: false });
  assert.equal(requestsFor(to), 1, "still exactly one provider dispatch");
  assert.equal(job.status, "Failed");
  assert.match(job.errorReason ?? "", /unknown/i);
}

for (const scenario of [
  { label: "http500", behaviour: { status: 500, code: 2 } as Behaviour },
  { label: "http503", behaviour: { status: 503, code: 2 } as Behaviour },
  { label: "http408", behaviour: { status: 408, code: 1 } as Behaviour },
  { label: "no-id", behaviour: "no-id" as Behaviour },
  { label: "reset", behaviour: "reset" as Behaviour },
]) {
  test(`end to end: ${scenario.label} -> provider intent delivery_unknown, job Failed, exactly ONE dispatch, never re-sent`, async () => {
    const fixture = await oneJobCampaign(scenario.label);
    try {
      const [contact] = await db.execute<{ to: string }>(sql`select normalized_phone as "to" from campaign_contacts where campaign_id = ${fixture.campaignId}`).then((r) => r.rows);
      plan.push(scenario.behaviour);
      const job = await runUntilSettled(fixture.jobId, fixture.slug);
      assert.equal(requestsFor(contact!.to), 1, "one dispatch");
      assert.equal(job.status, "Failed", "an unknown outcome is not re-queued");
      assert.equal((await intent(fixture.jobId))!.status, "delivery_unknown");
      assert.ok(!(job.errorReason ?? "").includes(TOKEN));
      await assertNeverResent(fixture, contact!.to);
    } finally { await deleteOrganization(fixture.org); }
  });
}

test("end to end: success -> Sent; permanent 400 -> Failed (rejected), one dispatch each", async () => {
  for (const [label, behaviour, status, intentStatus] of [["ok", "ok", "Sent", "sent"], ["http400", { status: 400, code: 100 }, "Failed", "rejected"]] as const) {
    const fixture = await oneJobCampaign(label);
    try {
      const [contact] = await db.execute<{ to: string }>(sql`select normalized_phone as "to" from campaign_contacts where campaign_id = ${fixture.campaignId}`).then((r) => r.rows);
      plan.push(behaviour as Behaviour);
      const job = await runUntilSettled(fixture.jobId, fixture.slug);
      assert.equal(job.status, status, label);
      assert.equal((await intent(fixture.jobId))!.status, intentStatus, label);
      assert.equal(requestsFor(contact!.to), 1, label);
    } finally { await deleteOrganization(fixture.org); }
  }
});

test("end to end: 429 throttling and a pre-connect failure follow the normal retry policy and then send once", async () => {
  // 429: Meta refused the request (rate limit) -> retry -> Sent; two requests, one delivered message.
  const throttled = await oneJobCampaign("http429");
  try {
    const [contact] = await db.execute<{ to: string }>(sql`select normalized_phone as "to" from campaign_contacts where campaign_id = ${throttled.campaignId}`).then((r) => r.rows);
    plan.push({ status: 429, code: 130429 }, "ok");
    let job = await runUntilSettled(throttled.jobId, throttled.slug);
    assert.equal(job.status, "Queued", "scheduled for a retry");
    assert.equal((await intent(throttled.jobId))!.status, "rejected");
    await db.update(campaignJobsTable).set({ availableAt: new Date(Date.now() - 1000) }).where(eq(campaignJobsTable.id, throttled.jobId));
    job = await runUntilSettled(throttled.jobId, `${throttled.slug}-retry`, { stopOnRetry: false });
    assert.equal(job.status, "Sent");
    assert.equal(requestsFor(contact!.to), 2, "the refused request and the one accepted request");
  } finally { await deleteOrganization(throttled.org); }

  // Connection refused: the request never left this host -> retry -> Sent; the provider saw exactly one request.
  const refused = await oneJobCampaign("refused");
  const closed = createNetServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  try {
    const [contact] = await db.execute<{ to: string }>(sql`select normalized_phone as "to" from campaign_contacts where campaign_id = ${refused.campaignId}`).then((r) => r.rows);
    process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = `http://127.0.0.1:${port}`;
    let job = await runUntilSettled(refused.jobId, refused.slug);
    process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = baseUrl;
    assert.equal(job.status, "Queued", "pre-connect failure is retried");
    await db.update(campaignJobsTable).set({ availableAt: new Date(Date.now() - 1000) }).where(eq(campaignJobsTable.id, refused.jobId));
    job = await runUntilSettled(refused.jobId, `${refused.slug}-retry`, { stopOnRetry: false });
    assert.equal(job.status, "Sent");
    assert.equal(requestsFor(contact!.to), 1, "exactly one request ever reached the provider");
  } finally {
    process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = baseUrl;
    await deleteOrganization(refused.org);
  }
});
