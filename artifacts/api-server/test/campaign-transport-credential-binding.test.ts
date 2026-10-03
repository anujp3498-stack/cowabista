import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { CampaignTransportShards, type SerializableTransportPayload } from "../src/services/campaign-transport-shards";
import { ProviderRequestError } from "../src/services/whatsapp-provider";

// V2-02C: workspace credentials reach a transport shard only through the
// credential-bind control message. The shard sends directly to Meta with
// the bound token in the Authorization header and fails closed before any
// HTTP when the binding is missing or does not match the prepared send.
// Everything here talks to a local fake Graph server; nothing leaves the
// process.

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = `EAAG-shard-${randomBytes(20).toString("hex")}`;
const PHONE_ID = 4242;
const PROVIDER_PHONE_ID = "555000111222";

type Recorded = { method: string; url: string; authorization?: string; body: string };
const recorded: Recorded[] = [];
let server: Server;
let failNext: { status: number; code: number } | undefined;
let holdNext: (() => void) | undefined;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      recorded.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      const reply = () => {
        if (failNext) {
          const { status, code } = failNext;
          failNext = undefined;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid OAuth access token", code } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messages: [{ id: `wamid.test.${recorded.length}` }] }));
      };
      if (holdNext) {
        const release = holdNext;
        holdNext = undefined;
        release();
        setTimeout(reply, 400);
      } else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Worker threads copy process.env at creation, so set this before any shards exist.
  process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  delete process.env.CAMPAIGN_TEST_GRAPH_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ownership = { fencingToken: 1, validUntilMs: Date.now() + 60_000 };
const auth = { kind: "workspace_credential" as const, organizationId: 7, credentialId: 11, credentialRevision: 1 };
const binding = { ...auth, accessToken: TOKEN };
function payload(overrides: Partial<typeof auth> = {}): SerializableTransportPayload {
  return {
    kind: "whatsapp",
    mode: "real",
    providerPhoneId: PROVIDER_PHONE_ID,
    payload: { messaging_product: "whatsapp", to: "+15550009999", type: "template", template: { name: "t", language: { code: "en_US" } } },
    timeoutMs: 5_000,
    auth: { ...auth, ...overrides },
  };
}
function dispatch(shards: CampaignTransportShards, body = payload(), signal = new AbortController().signal) {
  return shards.dispatch(PHONE_ID, 1, Date.now(), body, signal);
}

test("the transport payload and broker envelope never carry the token", () => {
  const body = payload();
  const envelope = { job: { id: 1, leaseToken: "lease" }, preparedContext: { transportAuth: auth, providerPhoneId: PROVIDER_PHONE_ID, payload: body.payload } };
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.ok(!JSON.stringify(envelope).includes(TOKEN));
  // Only the explicit binding object holds it, and that object is only ever posted to a worker thread.
  assert.ok(JSON.stringify(binding).includes(TOKEN));
});

test("bind is acknowledged, the shard sends directly to Meta with the token only in the Authorization header", async () => {
  const shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    assert.equal(shards.boundCredential(PHONE_ID), undefined);
    await shards.bindPhoneCredential(PHONE_ID, binding);
    assert.deepEqual(shards.boundCredential(PHONE_ID), { organizationId: 7, credentialId: 11, credentialRevision: 1 });
    recorded.length = 0;
    const outcome = await dispatch(shards);
    outcome.acknowledge();
    assert.equal(outcome.error, undefined);
    assert.match(outcome.providerMessageId ?? "", /^wamid\.test\./);
    assert.equal(recorded.length, 1);
    const request = recorded[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url, `/v23.0/${PROVIDER_PHONE_ID}/messages`);
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.ok(!request.url.includes(TOKEN), "token never in the URL");
    assert.ok(!request.body.includes(TOKEN), "token never in the body");
    assert.deepEqual(JSON.parse(request.body), payload().payload);
  } finally {
    await shards.close();
  }
});

test("dispatch fails closed before any HTTP without a binding, or with a wrong credential, organization or revision", async () => {
  const shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    recorded.length = 0;
    const unbound = await dispatch(shards);
    unbound.acknowledge();
    assert.ok(unbound.error instanceof ProviderRequestError);
    assert.equal(unbound.error.code, "credential_unbound");
    assert.equal(unbound.error.retryable, true, "a re-bind can fix a missing binding");
    assert.equal(unbound.providerMessageId, undefined, "no fake provider id");

    await shards.bindPhoneCredential(PHONE_ID, binding);
    for (const wrong of [{ credentialId: 12 }, { organizationId: 8 }, { credentialRevision: 2 }]) {
      const outcome = await dispatch(shards, payload(wrong));
      outcome.acknowledge();
      assert.ok(outcome.error instanceof ProviderRequestError, JSON.stringify(wrong));
      assert.equal(outcome.error.code, "credential_mismatch");
      assert.equal(outcome.error.retryable, false);
      assert.ok(!outcome.error.message.includes(TOKEN));
    }
    assert.equal(recorded.length, 0, "nothing reached the provider");
  } finally {
    await shards.close();
  }
});

test("the worker itself refuses to send when its own binding is gone, even if the parent view is stale", async () => {
  const shards = new CampaignTransportShards(1);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    await shards.bindPhoneCredential(PHONE_ID, binding);
    recorded.length = 0;
    shards.unbindPhoneCredential(PHONE_ID);
    // Simulate a stale parent-side view so only the worker's check stands.
    (shards as unknown as { credentialByPhone: Map<number, unknown> }).credentialByPhone.set(PHONE_ID, auth);
    const outcome = await dispatch(shards);
    outcome.acknowledge();
    assert.ok(outcome.error instanceof ProviderRequestError);
    assert.equal(outcome.error.code, "credential_unbound");
    assert.equal(recorded.length, 0);
  } finally {
    await shards.close();
  }
});

test("ownership revoke clears the binding; re-bind works; a new worker pool requires a fresh bind", async () => {
  let shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    await shards.bindPhoneCredential(PHONE_ID, binding);
    shards.revokePhoneOwnership(PHONE_ID, ownership.fencingToken);
    assert.equal(shards.boundCredential(PHONE_ID), undefined);
    shards.updatePhoneOwnership(PHONE_ID, { fencingToken: 2, validUntilMs: Date.now() + 60_000 });
    recorded.length = 0;
    const afterRevoke = await dispatch(shards);
    afterRevoke.acknowledge();
    assert.equal((afterRevoke.error as ProviderRequestError).code, "credential_unbound");
    assert.equal(recorded.length, 0);

    await shards.bindPhoneCredential(PHONE_ID, { ...binding, credentialRevision: 2 });
    const rebound = await dispatch(shards, payload({ credentialRevision: 2 }));
    rebound.acknowledge();
    assert.equal(rebound.error, undefined);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.authorization, `Bearer ${TOKEN}`);
  } finally {
    await shards.close();
  }
  // Worker memory is gone with the pool: nothing survives a restart.
  shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    recorded.length = 0;
    const fresh = await dispatch(shards);
    fresh.acknowledge();
    assert.equal((fresh.error as ProviderRequestError).code, "credential_unbound");
    assert.equal(recorded.length, 0);
  } finally {
    await shards.close();
  }
});

test("a legacy connector payload still goes through providerClient(mode) and needs no binding", async () => {
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "credential-binding-")), "provider.log");
  process.env.CAMPAIGN_TEST_PROVIDER_LOG = log;
  const shards = new CampaignTransportShards(2);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    recorded.length = 0;
    const legacy: SerializableTransportPayload = {
      kind: "whatsapp", mode: "mock", providerPhoneId: "legacy-phone", payload: { messaging_product: "whatsapp" }, timeoutMs: 5_000,
    };
    const outcome = await dispatch(shards, legacy);
    outcome.acknowledge();
    assert.equal(outcome.error, undefined);
    assert.match(outcome.providerMessageId ?? "", /^wamid\.mock_/);
    const rows = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phoneId, "legacy-phone");
    assert.equal(recorded.length, 0, "the direct sender is never used for legacy auth");
    assert.equal(shards.boundCredential(PHONE_ID), undefined);
  } finally {
    delete process.env.CAMPAIGN_TEST_PROVIDER_LOG;
    await shards.close();
  }
});

test("Meta code 190 on a direct send is a permanent provider failure, never a fallback to the shared connector", async () => {
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "credential-binding-190-")), "provider.log");
  process.env.CAMPAIGN_TEST_PROVIDER_LOG = log;
  const shards = new CampaignTransportShards(1);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    await shards.bindPhoneCredential(PHONE_ID, binding);
    failNext = { status: 401, code: 190 };
    recorded.length = 0;
    const outcome = await dispatch(shards);
    outcome.acknowledge();
    assert.ok(outcome.error instanceof ProviderRequestError);
    assert.equal(outcome.error.code, "190");
    assert.equal(outcome.error.retryable, false);
    assert.equal(outcome.error.status, 401);
    assert.ok(!outcome.error.message.includes(TOKEN));
    assert.equal(recorded.length, 1, "exactly one direct attempt");
    await assert.rejects(readFile(log, "utf8"), "the mock/connector client was never invoked");
  } finally {
    delete process.env.CAMPAIGN_TEST_PROVIDER_LOG;
    await shards.close();
  }
});

test("an abort during an in-flight direct send surfaces as a non-provider error (delivery unknown), not a retryable rejection", async () => {
  const shards = new CampaignTransportShards(1);
  try {
    shards.updatePhoneOwnership(PHONE_ID, ownership);
    await shards.bindPhoneCredential(PHONE_ID, binding);
    const controller = new AbortController();
    const reached = new Promise<void>((resolve) => { holdNext = resolve; });
    const pending = dispatch(shards, payload(), controller.signal);
    await reached; // the request has reached the fake provider
    controller.abort(new Error("Phone ownership revoked"));
    const outcome = await pending;
    outcome.acknowledge();
    assert.ok(outcome.error);
    assert.ok(!(outcome.error instanceof ProviderRequestError), "an abort after HTTP started must not look like a provider rejection");
    assert.notEqual(outcome.cancelledBeforeStart, true);
    assert.equal(outcome.providerMessageId, undefined);
  } finally {
    await shards.close();
  }
});

test("the transport shard worker and direct sender contain no database, Redis or credential-store imports", async () => {
  const worker = await readFile(path.join(artifactDir, "src/services/campaign-transport-shard-worker.ts"), "utf8");
  const direct = await readFile(path.join(artifactDir, "src/services/whatsapp-direct-sender.ts"), "utf8");
  for (const source of [worker, direct]) {
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line)).join("\n");
    assert.doesNotMatch(imports, /@workspace\/db|drizzle|"pg"|"redis"|credential-crypto|whatsapp-transport-credentials|whatsapp-manual-connection|logger/);
  }
  // The built worker bundle (what production actually loads) agrees.
  const bundle = await readFile(path.join(artifactDir, ".test-dist", "campaign-transport-shard-worker.mjs"), "utf8");
  assert.ok(!bundle.includes("drizzle-orm"), "no ORM in the worker bundle");
  assert.ok(!bundle.includes("whatsapp_credentials"), "no credential table in the worker bundle");
  assert.ok(!bundle.includes("XREADGROUP"), "no Redis broker in the worker bundle");
});
