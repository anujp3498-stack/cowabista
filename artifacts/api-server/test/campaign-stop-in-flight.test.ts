/*
 * STOP fail-closed (owner-approved decision 1): a STOP that lands while a provider request may be in flight must
 * never let the job be sent again automatically, even after the suppression is deleted; a provider-accepted id is
 * never lost; an ambiguous send is never retried; work proven never to have started stays re-armable.
 *
 * Before the fix a STOP set every pending intent of the recipient to 'rejected', which the next preparation re-arms:
 * deleting the suppression then let a later claim send again a message the provider may already have accepted
 * (independent review, duplicate-send dimension). Now the STOP marks those intents delivery_unknown with
 * OPT_OUT_UNCONFIRMED_REASON; only a not-started proof under the job's lease (-> 'rejected') or a definite provider
 * answer (accepted -> 'sent' with its id, refused -> 'rejected') lifts it.
 *
 * Production path: the real CampaignWorker reservoir entry points (claimPhoneBatch -> prepareReservoirBatch ->
 * dispatchReservoirEnvelope), the production sender (DelegatingWhatsAppSender), its transport shard worker threads
 * and real HTTP to a local fake Graph server that holds every request until the test answers it. Plan-backed jobs
 * from the real Plan -> Execute flow. "Another cell" is a second worker (its own shard threads); a STOP handled on
 * another cell is the webhook's database transaction without this process's in-memory abort. Nothing leaves the
 * host.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { campaignJobsTable, db, pool, providerMessagesTable, settlementPool, suppressionsTable } from "@workspace/db";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../src/services/credential-crypto";
import { executeCampaignPlan, planCampaign } from "../src/services/campaign-planning";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter, type PreparedCampaignEnvelope } from "../src/services/campaign-queue";
import { inFlightRegistry, OPT_OUT_UNCONFIRMED_REASON } from "../src/services/campaign-inflight";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";
import { DelegatingWhatsAppSender } from "../src/services/whatsapp-template-sender";
import { processWhatsAppOptOut } from "../src/services/whatsapp-webhook";
import { createCampaign, deleteOrganization, seedAudience, workspaceWorld } from "./message-studio-fixtures";
import { firstNameMappings, saveSetup } from "./v2-fixtures";
import { assertReapedLikeHousekeeping } from "./reaper-housekeeping";

// ------------------------------------------------------------ fake Graph server that holds every request

type Reply = "ok" | "hang" | { status: number; code: number };
type Held = { to: string; answer: (reply: Reply) => void; id: string };
const held: Held[] = [];
const received: string[] = [];
let server: Server;
let requestCounter = 0;

before(async () => {
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const to = (JSON.parse(body) as { to: string }).to;
      received.push(to);
      requestCounter += 1;
      const id = `wamid.stop-in-flight.${requestCounter}`;
      held.push({
        to,
        id,
        answer: (reply) => {
          if (reply === "hang") return;
          res.setHeader("content-type", "application/json");
          if (reply === "ok") { res.end(JSON.stringify({ messages: [{ id }] })); return; }
          res.writeHead(reply.status);
          res.end(JSON.stringify({ error: { message: `fake ${reply.status}`, type: "OAuthException", code: reply.code } }));
        },
      });
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Worker threads copy process.env at creation: set before any worker (and its shards) exists.
  process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const workers: CampaignWorker[] = [];
after(async () => {
  for (const held of heldAll()) held.answer("ok");
  for (const worker of workers) {
    await worker.waitForIdle(5_000).catch(() => false);
    await worker.closeDispatchScheduler().catch(() => {});
  }
  inFlightRegistry.clear();
  delete process.env.CAMPAIGN_TEST_GRAPH_BASE_URL;
  delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([pool.end(), settlementPool.end()]);
});
const heldAll = () => held.splice(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await sleep(20);
  }
}
/** The next request held at the fake provider for this recipient. */
const heldRequest = (to: string) => waitFor(() => {
  const index = held.findIndex((entry) => entry.to === to);
  return index === -1 ? undefined : held.splice(index, 1)[0];
}, `a request to ${to} at the provider`);
const requestsTo = (to: string) => received.filter((entry) => entry === to).length;

// ------------------------------------------------------------ one plan-backed job, real Plan -> Execute

async function oneJob(label: string) {
  const slug = `stop-${label}-${process.pid}-${Date.now()}-${randomBytes(2).toString("hex")}`;
  const world = await workspaceWorld(slug, { phones: 1, templates: [{ name: "stop_t", body: "Hi {{1}}" }] });
  const org = world.organization.id;
  const campaign = await createCampaign(org, slug);
  const phoneNumber = `+4477331${String(org % 100000).padStart(5, "0")}`;
  await seedAudience(org, campaign.id, ["phone", "first_name"], [{ phone: phoneNumber, first_name: "Ann" }]);
  const saved = await saveSetup(org, campaign.id, { revision: 0, senderPhoneNumberIds: [world.phones[0]!.id], templateIds: [world.templates[0]!.id], mappings: firstNameMappings([world.templates[0]!.id]), distributionMode: "equal_numbers" });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  await planCampaign(org, campaign.id);
  await executeCampaignPlan(org, campaign.id);
  const [job] = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaign.id));
  const [{ to }] = (await db.execute<{ to: string }>(sql`select normalized_phone as "to" from campaign_contacts where campaign_id = ${campaign.id}`)).rows;
  return { org, campaignId: campaign.id, jobId: job!.id, phone: world.phones[0]!, credentialId: world.credential.id, to: to!, slug };
}
type Fixture = Awaited<ReturnType<typeof oneJob>>;

let token = 100;
/** A worker standing in for a cell: its own transport shard threads, owning the fixture's phone. */
async function cell(f: Fixture) {
  const worker = new CampaignWorker(new DatabaseJobQueue(), new DelegatingWhatsAppSender(), new RouteTpsLimiter(), `${f.slug}-cell-${token}`, 30_000);
  workers.push(worker);
  token += 1;
  worker.updateTransportOwnership(f.phone.id, token, Date.now() + 120_000);
  await worker.bindTransportCredential(f.phone.id, f.org, f.credentialId);
  return worker;
}
async function claimAndPrepare(worker: CampaignWorker, f: Fixture): Promise<PreparedCampaignEnvelope[]> {
  for (let round = 0; round < 100; round += 1) {
    const claimed = await worker.claimPhoneBatch(f.phone.id, 1);
    if (claimed.length) return worker.prepareReservoirBatch(claimed);
    await sleep(50);
  }
  assert.fail("the job was never claimable");
}
function dispatch(worker: CampaignWorker, envelope: PreparedCampaignEnvelope) {
  assert.ok(worker.tryReserveSettlementSlot(), "a settlement slot for the dispatch");
  return worker.dispatchReservoirEnvelope(envelope, new Date(), true);
}

const stopEvent = (f: Fixture) => ({
  eventId: `stop-${f.slug}-${Date.now()}`, phoneNumberId: f.phone.providerPhoneId!, from: f.to.slice(1), text: "STOP", occurredAt: new Date(),
});
/** The webhook on this process: the durable transaction and the in-memory abort of this process's work. */
async function stopHere(f: Fixture) {
  assert.equal(await processWhatsAppOptOut(stopEvent(f)), "suppressed");
}
/** The webhook handled by another cell: only the durable transaction reaches this process's work. */
async function stopOnAnotherCell(f: Fixture) {
  const abortRecipient = inFlightRegistry.abortRecipient.bind(inFlightRegistry);
  inFlightRegistry.abortRecipient = () => 0;
  try {
    assert.equal(await processWhatsAppOptOut(stopEvent(f)), "suppressed");
  } finally {
    inFlightRegistry.abortRecipient = abortRecipient;
  }
}
const deleteSuppression = (f: Fixture) => db.delete(suppressionsTable)
  .where(and(eq(suppressionsTable.organizationId, f.org), eq(suppressionsTable.normalizedPhone, f.to)));
const jobRow = async (f: Fixture) => (await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.id, f.jobId)))[0]!;
const intentRow = async (f: Fixture) => (await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, f.jobId)))[0]!;
const settled = (f: Fixture, statuses: string[]) => waitFor(async () => {
  const job = await jobRow(f);
  return statuses.includes(job.status) ? job : undefined;
}, `job ${f.jobId} to settle as ${statuses.join("/")}`, 30_000);

/**
 * After the suppression is deleted, the job is put back in the queue (an operator, or lease recovery) and a cell
 * claims and prepares it again: nothing may reach the provider, and the job must end Failed for manual
 * reconciliation (or stay Sent, for an accepted send).
 */
async function assertNeverResentAfterDeletion(f: Fixture, requestsBefore: number) {
  await deleteSuppression(f);
  const job = await jobRow(f);
  if (job.status === "Sent") {
    // An accepted send is terminal; even forced back into the queue it only replays the recorded id.
    await db.update(campaignJobsTable).set({ status: "Queued", leaseToken: null, availableAt: new Date(Date.now() - 1_000) }).where(eq(campaignJobsTable.id, f.jobId));
  } else if (job.status !== "Queued") {
    await db.update(campaignJobsTable).set({ status: "Queued", leaseToken: null, errorReason: null, availableAt: new Date(Date.now() - 1_000) }).where(eq(campaignJobsTable.id, f.jobId));
  }
  const worker = await cell(f);
  const envelopes = await claimAndPrepare(worker, f);
  for (const envelope of envelopes) await dispatch(worker, envelope);
  await worker.waitForIdle(10_000);
  await sleep(300);
  assert.equal(requestsTo(f.to), requestsBefore, "nothing reached the provider again after the suppression was deleted");
  return jobRow(f);
}

// ------------------------------------------------------------ tests

test("STOP on this cell while the request is at the provider: settled Failed for manual reconciliation, never requeued, never re-sent after the suppression is deleted", async () => {
  const f = await oneJob("here-in-flight");
  try {
    const worker = await cell(f);
    const [envelope] = await claimAndPrepare(worker, f);
    const before = campaignDispatchMetrics.snapshot().optOutInFlightUnknown;
    const done = dispatch(worker, envelope!);
    const request = await heldRequest(f.to);
    await stopHere(f); // aborts this process's in-flight request: its outcome is unknown
    await done;
    request.answer("ok"); // the provider may well have accepted it; the aborted client never learns the id
    const job = await settled(f, ["Failed"]);
    assert.match(job.errorReason ?? "", /opted out while the send was in flight.*manual reconciliation/);
    const intent = await intentRow(f);
    assert.equal(intent.status, "delivery_unknown");
    assert.ok(intent.errorReason?.startsWith(OPT_OUT_UNCONFIRMED_REASON), intent.errorReason ?? "");
    assert.equal(campaignDispatchMetrics.snapshot().optOutInFlightUnknown - before, 1, "counted once");
    assert.equal(requestsTo(f.to), 1);

    const after = await assertNeverResentAfterDeletion(f, 1);
    assert.equal(after.status, "Failed");
    assert.match(after.errorReason ?? "", /unknown; manual reconciliation/);
    assert.equal((await intentRow(f)).status, "delivery_unknown", "the intent history is kept");
  } finally { await deleteOrganization(f.org); }
});

test("STOP on another cell while the request is at the provider, which accepts: the accepted id is recorded and the job is Sent; never sent again", async () => {
  const f = await oneJob("other-accepted");
  try {
    const worker = await cell(f);
    const [envelope] = await claimAndPrepare(worker, f);
    const done = dispatch(worker, envelope!);
    const request = await heldRequest(f.to);
    await stopOnAnotherCell(f);
    assert.equal((await intentRow(f)).status, "delivery_unknown", "the STOP marks the armed intent fail-closed");
    request.answer("ok");
    await done;
    await worker.waitForIdle(10_000);
    const job = await settled(f, ["Sent"]);
    assert.equal(job.status, "Sent");
    const intent = await intentRow(f);
    assert.equal(intent.status, "sent", "a definite acceptance replaces the STOP's mark");
    assert.equal(intent.providerMessageId, request.id, "the accepted provider message id is preserved");

    await assertNeverResentAfterDeletion(f, 1);
    assert.equal((await intentRow(f)).providerMessageId, request.id);
  } finally { await deleteOrganization(f.org); }
});

test("STOP on another cell, the provider refuses the request: a definite refusal is re-armable, so after the suppression is deleted it is sent (it was never accepted)", async () => {
  const f = await oneJob("other-refused");
  try {
    const worker = await cell(f);
    const [envelope] = await claimAndPrepare(worker, f);
    const done = dispatch(worker, envelope!);
    const request = await heldRequest(f.to);
    await stopOnAnotherCell(f);
    request.answer({ status: 400, code: 100 });
    await done;
    await worker.waitForIdle(10_000);
    const job = await settled(f, ["Failed"]);
    assert.equal(job.status, "Failed");
    assert.equal((await intentRow(f)).status, "rejected", "the provider's refusal replaces the STOP's mark");

    await deleteSuppression(f);
    await db.update(campaignJobsTable).set({ status: "Queued", leaseToken: null, errorReason: null, availableAt: new Date(Date.now() - 1_000) }).where(eq(campaignJobsTable.id, f.jobId));
    const retry = await cell(f);
    const [again] = await claimAndPrepare(retry, f);
    assert.ok(again, "a refused (never accepted) request is re-armed");
    const sent = dispatch(retry, again!);
    (await heldRequest(f.to)).answer("ok");
    await sent;
    await retry.waitForIdle(10_000);
    assert.equal((await settled(f, ["Sent"])).status, "Sent");
    assert.equal(requestsTo(f.to), 2, "the refused request and the one accepted request");
  } finally { await deleteOrganization(f.org); }
});

test("STOP on another cell, the request times out: delivery unknown, Failed, never re-sent after the suppression is deleted", async () => {
  const f = await oneJob("other-timeout");
  try {
    const worker = await cell(f);
    const [envelope] = await claimAndPrepare(worker, f);
    const done = dispatch(worker, envelope!);
    const request = await heldRequest(f.to);
    await stopOnAnotherCell(f);
    request.answer("hang"); // the provider never answers: the transport's 8 s deadline fires
    await done;
    await worker.waitForIdle(15_000);
    const job = await settled(f, ["Failed", "Queued"]);
    assert.notEqual(job.status, "Sent");
    assert.equal((await intentRow(f)).status, "delivery_unknown");
    const after = await assertNeverResentAfterDeletion(f, 1);
    assert.equal(after.status, "Failed");
    assert.match(after.errorReason ?? "", /unknown; manual reconciliation/);
  } finally { await deleteOrganization(f.org); }
});

test("STOP on this cell before the request starts (waiting in shard pacing): verified never started, re-armable; sent once after the suppression is deleted", async () => {
  const f = await oneJob("here-before-start");
  try {
    const worker = await cell(f);
    const [envelope] = await claimAndPrepare(worker, f);
    // Its slot is 3 s away, so it waits in the shard's pacing, never started.
    const waiting = { ...envelope!, job: { ...envelope!.job, scheduledSendAt: new Date(Date.now() + 3_000) } };
    const done = dispatch(worker, waiting);
    await sleep(200);
    await stopHere(f);
    await done;
    await worker.waitForIdle(10_000);
    const job = await settled(f, ["Queued"]);
    assert.equal(job.attempts, 0, "a never-started send returns its claim's attempt");
    const intent = await intentRow(f);
    assert.equal(intent.status, "rejected", "proved never started: the STOP's mark is lifted to a re-armable rejection");
    assert.equal(requestsTo(f.to), 0);

    // While suppressed, preparation refuses it without any request.
    const blocked = await cell(f);
    assert.deepEqual(await claimAndPrepare(blocked, f), [], "the suppression is screened at preparation");
    assert.equal(requestsTo(f.to), 0);
    assert.equal((await jobRow(f)).status, "Failed");

    await deleteSuppression(f);
    await db.update(campaignJobsTable).set({ status: "Queued", leaseToken: null, errorReason: null, availableAt: new Date(Date.now() - 1_000) }).where(eq(campaignJobsTable.id, f.jobId));
    const resumed = await cell(f);
    const [again] = await claimAndPrepare(resumed, f);
    const sent = dispatch(resumed, again!);
    (await heldRequest(f.to)).answer("ok");
    await sent;
    await resumed.waitForIdle(10_000);
    assert.equal((await settled(f, ["Sent"])).status, "Sent");
    assert.equal(requestsTo(f.to), 1, "sent exactly once");
  } finally { await deleteOrganization(f.org); }
});

test("crash after the request may have reached the provider, then STOP, recovery and suppression deletion: Failed for manual reconciliation, never re-sent", async () => {
  const f = await oneJob("crash");
  try {
    const dying = await cell(f);
    const [envelope] = await claimAndPrepare(dying, f);
    assert.equal((await intentRow(f)).status, "pending", "armed");
    // The cell dispatches and dies before any outcome is recorded: the request reached the provider (held, never
    // answered to this cell), and nothing durable says so beyond the pending intent.
    void dispatch(dying, envelope!).catch(() => {});
    const request = await heldRequest(f.to);
    await stopOnAnotherCell(f);
    // Lease recovery by the survivors: the dead cell's lease lapses and housekeeping requeues the job.
    await db.update(campaignJobsTable).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(campaignJobsTable.id, f.jobId));
    inFlightRegistry.clear(); // the dead process's registrations died with it
    await assertReapedLikeHousekeeping([f.jobId]);
    assert.equal((await jobRow(f)).status, "Queued");

    const after = await assertNeverResentAfterDeletion(f, 1);
    assert.equal(after.status, "Failed");
    assert.match(after.errorReason ?? "", /unknown; manual reconciliation/);
    assert.equal((await intentRow(f)).status, "delivery_unknown");
    request.answer("ok"); // the dead cell's socket: nobody is listening for the answer
  } finally { await deleteOrganization(f.org); }
});

test("two cells: a successor claims the job after STOP and suppression deletion while the first cell's request is still open; one request ever, the late acceptance is recorded", async () => {
  const f = await oneJob("two-cells");
  try {
    const first = await cell(f);
    const [envelope] = await claimAndPrepare(first, f);
    const firstSend = dispatch(first, envelope!);
    const request = await heldRequest(f.to);
    await stopOnAnotherCell(f);
    // The first cell's lease lapses while its request is still open (a stalled provider); the other cell's reaper
    // requeues it. That reaper runs in another process, so it cannot abort this cell's in-memory registration.
    await db.update(campaignJobsTable).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(campaignJobsTable.id, f.jobId));
    const abortLease = inFlightRegistry.abortLease.bind(inFlightRegistry);
    inFlightRegistry.abortLease = () => false;
    try {
      await assertReapedLikeHousekeeping([f.jobId]);
    } finally {
      inFlightRegistry.abortLease = abortLease;
    }
    await deleteSuppression(f);

    const second = await cell(f);
    const prepared = await claimAndPrepare(second, f);
    assert.deepEqual(prepared, [], "the successor refuses the fail-closed intent: nothing to send");
    assert.equal((await jobRow(f)).status, "Failed");
    assert.match((await jobRow(f)).errorReason ?? "", /unknown; manual reconciliation/);

    // The provider answers the first cell's request late: accepted. Its id is recorded; the job stays terminal.
    request.answer("ok");
    await firstSend;
    await first.waitForIdle(10_000);
    const intent = await waitFor(async () => {
      const row = await intentRow(f);
      return row.status === "sent" ? row : undefined;
    }, "the late acceptance to be recorded");
    assert.equal(intent.providerMessageId, request.id, "the accepted id is preserved for reconciliation");
    assert.equal(requestsTo(f.to), 1, "exactly one request ever reached the provider");
  } finally { await deleteOrganization(f.org); }
});
