/*
 * V2-372 send-path fixes found in the review that accompanied automatic phone assignment, each through the real
 * reservoir (or runtime) against PostgreSQL, with the in-memory coordinator and broker. Campaigns here are Running
 * with Active routes on Connected phones (so the phones are sendable) and hold no jobs unless a test needs sends:
 *   R2  a phone that does not fit the reservoir's capacity is never held: before, its lease was taken and renewed
 *       every tick with no lane, so neither this runtime nor any other could send it;
 *   R3  a credential that fails to bind is retried with back-off, not on every 100 ms tick;
 *   R10 a lane follows its phone's provider-approved TPS (Meta sync) instead of the TPS it was built with;
 *   R11 with static scopes, a sendable phone no runtime owns (phone 9 outside 1-4 and 5-8) is reported;
 *   monitoring shows `transportOwned` per Active route of a Running campaign.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  campaignMetricsTable,
  campaignRoutesTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { CampaignWorker, DatabaseJobQueue, RouteTpsLimiter } from "../src/services/campaign-queue";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { InMemoryPacingCoordinator } from "../src/services/campaign-pacing-coordinator";
import { InMemoryPreparedDispatchBroker } from "../src/services/campaign-prepared-broker";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";
import { DelegatingWhatsAppSender } from "../src/services/whatsapp-template-sender";
import { startCampaignRuntime, stopCampaignRuntime } from "../src/services/campaign-runtime";
import campaignEngineRouter from "../src/routes/campaign-engine";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  await pool.end();
});

/** One organization, `tps.length` Connected phones and one Running campaign with an Active route on each. */
async function fixture(label: string, tps: number[], options: { credential?: boolean } = {}) {
  const slug = `v2-372-${label}-${process.pid}-${Date.now()}`;
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  cleanups.push(async () => {
    await db.update(campaignsTable).set({ status: "Cancelled" }).where(eq(campaignsTable.organizationId, organization!.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization!.id));
  });
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  let credentialId: number | null = null;
  if (options.credential) {
    // Not decryptable: binding it fails in the real resolver, as a revoked key or a corrupted row would.
    const [credential] = await db.insert(whatsappCredentialsTable).values({
      organizationId: organization!.id, tokenCiphertext: "not-a-ciphertext", tokenIv: "00", tokenAuthTag: "00",
      tokenFingerprint: `${slug}-fp`,
    }).returning();
    credentialId = credential!.id;
  }
  const phones = [];
  for (const [index, limit] of tps.entries()) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization!.id, wabaId: waba!.id, phone: `+1558${organization!.id.toString().padStart(6, "0")}${index}`,
      displayName: `${slug}-p${index}`, status: "Connected", tpsLimit: limit, providerPhoneId: `test-${slug}-p${index}`,
      sendingCredentialId: credentialId,
    }).returning();
    phones.push(phone!);
  }
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-t`, status: "Approved", language: "en_US",
    body: "Hello", components: [{ type: "BODY", text: "Hello" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: `${slug}-c`, status: "Running" }).returning();
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id });
  const routes = [];
  for (const phone of phones) {
    const [route] = await db.insert(campaignRoutesTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone.id, templateId: template!.id,
      configuredTps: phone.tpsLimit, queueDepth: 0,
    }).returning();
    routes.push(route!);
  }
  return { organization: organization!, phones, campaign: campaign!, routes };
}

/** A real worker and reservoir over the in-memory coordinator and broker; stopped when the test file ends. */
function reservoir(coordinator: InMemoryPacingCoordinator, options: {
  ownerId: string; capacity?: number; scope?: number[]; unownedAlertMs?: number;
}) {
  const worker = new CampaignWorker(new DatabaseJobQueue(), new DelegatingWhatsAppSender(), new RouteTpsLimiter(coordinator), options.ownerId, 30_000);
  const instance = new CampaignPhoneReservoir(
    worker, 64, coordinator, options.ownerId, options.capacity ?? 16_384,
    options.scope ? new Set(options.scope) : undefined, new InMemoryPreparedDispatchBroker(), 5_000,
    undefined, options.unownedAlertMs,
  );
  cleanups.push(async () => {
    await instance.stop();
    await worker.closeDispatchScheduler();
  });
  return { worker, reservoir: instance };
}

const owners = (coordinator: InMemoryPacingCoordinator, organizationId: number, phoneIds: number[]) =>
  coordinator.peekPhoneOwners(phoneIds.map((phoneNumberId) => ({ organizationId, phoneNumberId })));

test("R2: a phone that does not fit the reservoir's capacity is left free, and another runtime takes it", async () => {
  // Lane capacity = TPS x 3 s = 30 each; a capacity of 60 holds two lanes, not three.
  const f = await fixture("capacity", [10, 10, 10]);
  const coordinator = new InMemoryPacingCoordinator();
  // Scoped to this fixture's phones so other suites' rows in the shared database cannot take capacity.
  const ids = f.phones.map((phone) => phone.id);
  const full = reservoir(coordinator, { ownerId: "full-runtime", capacity: 60, scope: ids });
  const refusalsBefore = campaignDispatchMetrics.snapshot().phoneCapacityRefusals;
  for (let tick = 0; tick < 3; tick += 1) await full.reservoir.tick();
  const lanes = full.reservoir.metrics().map((lane) => lane.phoneNumberId).sort((a, b) => a - b);
  assert.deepEqual(lanes, [f.phones[0]!.id, f.phones[1]!.id], "two lanes fit");
  assert.deepEqual(await owners(coordinator, f.organization.id, [f.phones[2]!.id]), [null], "the third phone's lease is not held");
  assert.ok(campaignDispatchMetrics.snapshot().phoneCapacityRefusals > refusalsBefore, "the refusal is counted");

  const other = reservoir(coordinator, { ownerId: "other-runtime", scope: ids });
  await other.reservoir.tick();
  assert.deepEqual(other.reservoir.metrics().map((lane) => lane.phoneNumberId), [f.phones[2]!.id], "another runtime sends it");
});

test("R3: a credential that does not bind is retried with back-off, not every tick, and the phone stays free", async () => {
  const f = await fixture("bind", [10], { credential: true });
  const coordinator = new InMemoryPacingCoordinator();
  const { worker, reservoir: instance } = reservoir(coordinator, { ownerId: "bind-runtime", scope: [f.phones[0]!.id] });
  let attempts = 0;
  const bind = worker.bindTransportCredential.bind(worker);
  worker.bindTransportCredential = async (...args: Parameters<CampaignWorker["bindTransportCredential"]>) => {
    attempts += 1;
    return bind(...args);
  };
  const started = Date.now();
  while (Date.now() - started < 2_500) {
    await instance.tick();
    await sleep(100);
  }
  // Before V2-372: one attempt per tick, about 20 here. Now: at 0 s, ~1 s and ~3 s.
  assert.ok(attempts >= 1 && attempts <= 3, `${attempts} bind attempts in 2.5 s`);
  assert.equal(instance.metrics().length, 0, "no lane without a bound credential");
  assert.deepEqual(await owners(coordinator, f.organization.id, [f.phones[0]!.id]), [null], "ownership is released after each failure");
});

test("R10: a lane follows its phone's provider-approved TPS after a Meta sync raises it", async () => {
  const f = await fixture("resize", [10]);
  const coordinator = new InMemoryPacingCoordinator();
  const { reservoir: instance } = reservoir(coordinator, { ownerId: "resize-runtime", scope: [f.phones[0]!.id] });
  await instance.tick();
  assert.deepEqual(instance.metrics().map((lane) => [lane.phoneNumberId, lane.capacity]), [[f.phones[0]!.id, 30]], "built for 10 TPS");
  await db.update(phoneNumbersTable).set({ tpsLimit: 100 }).where(eq(phoneNumbersTable.id, f.phones[0]!.id));
  await instance.tick();
  const lane = instance.metrics()[0]!;
  assert.equal(lane.capacity, 300, "resized for 100 TPS without rebuilding the lane");
  assert.equal(lane.highWater, 300);
  assert.equal(lane.lowWater, 150);
  assert.equal(lane.fencingToken, 1, "same lane, same ownership");
});

test("R11: with static scopes, a sendable phone in no scope is reported unowned, and cleared once a runtime owns it", async () => {
  // Phone 0 is in this runtime's scope; phone 1 is in none (the production phone 9 under 1-4 and 5-8).
  const f = await fixture("orphan", [10, 10]);
  const coordinator = new InMemoryPacingCoordinator();
  const { reservoir: scoped } = reservoir(coordinator, { ownerId: "scoped-runtime", scope: [f.phones[0]!.id], unownedAlertMs: 400 });
  const started = Date.now();
  while (Date.now() - started < 1_500 && !scoped.unownedPhoneIds().includes(f.phones[1]!.id)) {
    await scoped.tick();
    await sleep(100);
  }
  assert.ok(scoped.unownedPhoneIds().includes(f.phones[1]!.id), "the phone in no scope is reported");
  assert.ok(!scoped.unownedPhoneIds().includes(f.phones[0]!.id), "the owned phone is not");

  const { reservoir: other } = reservoir(coordinator, { ownerId: "second-runtime", scope: [f.phones[1]!.id] });
  await other.tick();
  const until = Date.now() + 2_000;
  while (Date.now() < until && scoped.unownedPhoneIds().includes(f.phones[1]!.id)) {
    await scoped.tick();
    await other.tick();
    await sleep(100);
  }
  assert.deepEqual(scoped.unownedPhoneIds().filter((id) => f.phones.some((phone) => phone.id === id)), [], "cleared once owned");
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, routePath: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${routePath}`);
}

test("monitoring: transportOwned is true on a route whose phone a runtime owns and false on one nobody owns", async () => {
  const f = await fixture("monitoring", [10, 10]);
  const previous = process.env.CAMPAIGN_TRANSPORT_PHONE_IDS;
  // The process runtime owns only phone 0, as a static cell whose scope misses phone 1.
  process.env.CAMPAIGN_TRANSPORT_PHONE_IDS = String(f.phones[0]!.id);
  startCampaignRuntime();
  try {
    const handler = findRouteHandler(campaignEngineRouter, "/organizations/:organizationId/campaigns/:campaignId/monitoring", "get");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (): Promise<any> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = { statusCode: 200 };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: unknown) => { res.body = body; return res; };
      await handler({ params: { organizationId: String(f.organization.id), campaignId: String(f.campaign.id) } }, res, () => {});
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      return res.body;
    };
    let body = await call();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && body.routes.find((route: { routeId: number }) => route.routeId === f.routes[0]!.id)?.transportOwned !== true) {
      await sleep(100);
      body = await call();
    }
    const byRoute = new Map(body.routes.map((route: { routeId: number; transportOwned: boolean | null }) => [route.routeId, route.transportOwned]));
    assert.equal(byRoute.get(f.routes[0]!.id), true, "the owned phone's route");
    assert.equal(byRoute.get(f.routes[1]!.id), false, "the route whose phone no runtime owns");

    await db.update(campaignsTable).set({ status: "Paused" }).where(eq(campaignsTable.id, f.campaign.id));
    body = await call();
    assert.ok(body.routes.every((route: { transportOwned: boolean | null }) => route.transportOwned === null), "not applicable while the campaign is not Running");
  } finally {
    await stopCampaignRuntime();
    if (previous === undefined) delete process.env.CAMPAIGN_TRANSPORT_PHONE_IDS;
    else process.env.CAMPAIGN_TRANSPORT_PHONE_IDS = previous;
  }
});
