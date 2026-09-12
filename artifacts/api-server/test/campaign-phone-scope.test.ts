import assert from "node:assert/strict";
import { after, test } from "node:test";
import { inArray } from "drizzle-orm";
import {
  campaignMetricsTable, campaignRoutesTable, campaignTemplateMappingsTable, campaignTemplateSelectionsTable, campaignsTable,
  db, organizationsTable, phoneNumbersTable, pool, templatesTable, wabasTable,
} from "@workspace/db";
import { CampaignPhoneReservoir } from "../src/services/campaign-phone-reservoir";
import { InMemoryPacingCoordinator, type AtomicPacingCoordinator } from "../src/services/campaign-pacing-coordinator";
import {
  CAMPAIGN_TRANSPORT_PHONE_IDS_ENV, describePhoneScope, parsePhoneScope, phoneScopeFromEnv,
} from "../src/services/campaign-phone-scope";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { campaignDispatchMetrics } from "../src/services/campaign-dispatch-metrics";

// Deterministic phone partitioning across transport runtime processes.
// Each "runtime" below is a CampaignPhoneReservoir with its own ownerId and
// scope, sharing one in-memory coordinator (the fenced lease authority) and
// discovering phones from the real database, exactly as production does.

const createdOrganizationIds: number[] = [];
after(async () => {
  if (createdOrganizationIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrganizationIds));
  await pool.end();
});

async function seedPhones(slug: string, count: number): Promise<number[]> {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  createdOrganizationIds.push(organization!.id);
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization!.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization!.id, wabaId: waba!.id, name: `${slug}-template`, status: "Approved", body: "Hello", components: [{ type: "BODY", text: "Hello" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization!.id, name: slug, status: "Running" }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization!.id, campaignId: campaign!.id, templateId: template!.id, component: "body", variable: "1", source: "static", sourceValue: "x",
  });
  await db.insert(campaignMetricsTable).values({ organizationId: organization!.id, campaignId: campaign!.id, total: 0, valid: 0, queued: 0 });
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization!.id, wabaId: waba!.id, phone: `+1777${organization!.id.toString().padStart(4, "0")}${index.toString().padStart(3, "0")}`,
      displayName: `${slug}-${index}`, status: "Connected", tpsLimit: 10,
    }).returning();
    await db.insert(campaignRoutesTable).values({
      organizationId: organization!.id, campaignId: campaign!.id, phoneNumberId: phone!.id, templateId: template!.id, configuredTps: 10, queueDepth: 0,
    });
    ids.push(phone!.id);
  }
  return ids;
}

type Log = { claims: number[]; consumed: number[]; ownership: Array<[number, number]>; revoked: number[] };
function fakeWorker(log: Log) {
  return {
    brokerLeaseRenewalIntervalMs: 10_000,
    transportShardForPhone: (phoneId: number) => phoneId % 8,
    updateTransportOwnership(phoneId: number, fencingToken: number) { log.ownership.push([phoneId, fencingToken]); },
    revokeTransportOwnership(phoneId: number) { log.revoked.push(phoneId); },
    tryReserveSettlementSlot() { return true; },
    releaseSettlementSlot() {},
    settlementSlotCapacity() { return 4096; },
    async claimPhoneBatch(phoneId: number) { log.claims.push(phoneId); return []; },
    async nextPhoneSupplyDueInMs() { return undefined; },
    async prepareReservoirBatch() { return []; },
    async discardReservoirEnvelope() {},
    async dispatchReservoirEnvelope() {},
    async abandonBrokerEnvelope() {},
    async adoptPreparedEnvelope() { return undefined; },
    async handoffPreparedEnvelope() {},
    async renewBrokerLeases() {},
    async validatePreparedBrokerEnvelopes(envelopes: unknown[]) { return envelopes; },
  };
}
function fakeBroker(log: Log) {
  return {
    async publish() {},
    async consume(phoneId: number) { log.consumed.push(phoneId); return []; },
    async acknowledge() {},
    async metrics() { return { depth: 0, pending: 0, consumerLag: 0 }; },
    async reclaimAbandoned() { return { deliveries: [], cursor: "0-0" }; },
    async close() {},
  };
}
/** Records which phones each owner asks the coordinator for, then delegates to the shared lease authority. */
function recordingCoordinator(inner: AtomicPacingCoordinator, asked: Map<string, Set<number>>): AtomicPacingCoordinator {
  return {
    ...inner,
    reserveBatch: (input) => inner.reserveBatch(input),
    close: () => inner.close(),
    async ensurePhoneOwnership(input) {
      let set = asked.get(input.ownerId);
      if (!set) { set = new Set(); asked.set(input.ownerId, set); }
      set.add(input.phoneNumberId);
      return inner.ensurePhoneOwnership(input);
    },
    releasePhoneOwnership: (input) => inner.releasePhoneOwnership(input),
  } as AtomicPacingCoordinator;
}
function runtimeCell(ownerId: string, scope: ReadonlySet<number> | undefined, coordinator: AtomicPacingCoordinator) {
  const log: Log = { claims: [], consumed: [], ownership: [], revoked: [] };
  const reservoir = new CampaignPhoneReservoir(fakeWorker(log) as any, 4, coordinator, ownerId, 65_536, scope, fakeBroker(log) as any, 5_000);
  return { ownerId, reservoir, log, owned: () => reservoir.metrics().map((lane) => lane.phoneNumberId).sort((a, b) => a - b) };
}
async function settle(cells: Array<{ reservoir: CampaignPhoneReservoir }>) {
  for (const cell of cells) await cell.reservoir.waitForIdle(1_000);
}
const only = (ids: number[], from: number, to: number) => new Set(ids.slice(from - 1, to));

test("scope parsing: ids, inclusive ranges, blanks, and rejection of malformed values", () => {
  assert.deepEqual([...parsePhoneScope("1,2,3,4")!], [1, 2, 3, 4]);
  assert.deepEqual([...parsePhoneScope(" 1-4 , 9 ")!].sort((a, b) => a - b), [1, 2, 3, 4, 9]);
  assert.equal(parsePhoneScope(""), undefined);
  assert.equal(parsePhoneScope("   "), undefined);
  assert.equal(parsePhoneScope(undefined), undefined);
  assert.equal(parsePhoneScope(","), undefined);
  for (const bad of ["a", "4-1", "0", "1-", "-3", "1.5", "1;2"]) assert.throws(() => parsePhoneScope(bad), RangeError, bad);
  assert.equal(describePhoneScope(new Set([9, 1, 2, 3, 4])), "1-4,9");
  assert.equal(describePhoneScope(undefined), "all");
  assert.equal(phoneScopeFromEnv({}), undefined);
  assert.deepEqual([...phoneScopeFromEnv({ [CAMPAIGN_TRANSPORT_PHONE_IDS_ENV]: "5-8" })!], [5, 6, 7, 8]);
});

test("A · an unscoped runtime discovers and owns every Running phone (single-runtime behaviour unchanged)", async () => {
  const ids = await seedPhones(`scope-a-${Date.now()}`, 8);
  const asked = new Map<string, Set<number>>();
  const coordinator = recordingCoordinator(new InMemoryPacingCoordinator(), asked);
  const solo = runtimeCell("solo", undefined, coordinator);
  await solo.reservoir.tick(); await settle([solo]);
  // The shared test database may hold other Running campaigns; the unscoped runtime must own at least this fixture's phones.
  assert.deepEqual(solo.owned().filter((id) => ids.includes(id)), ids);
  assert.ok(ids.every((id) => asked.get("solo")!.has(id)));
  await solo.reservoir.stop();
});

test("B/C/D/L/M/N · two scoped runtimes own disjoint sets, never ask for each other's phones, and only claim and consume inside their scope", async () => {
  const ids = await seedPhones(`scope-bcd-${Date.now()}`, 8);
  const asked = new Map<string, Set<number>>();
  const coordinator = recordingCoordinator(new InMemoryPacingCoordinator(), asked);
  const a = runtimeCell("runtime-a", only(ids, 1, 4), coordinator);
  const b = runtimeCell("runtime-b", only(ids, 5, 8), coordinator);
  const before = campaignDispatchMetrics.snapshot().ownershipDenials;
  for (let round = 0; round < 3; round += 1) { await a.reservoir.tick(); await b.reservoir.tick(); }
  await settle([a, b]);
  assert.deepEqual(a.owned(), ids.slice(0, 4), "B · runtime A owns phones 1-4");
  assert.deepEqual(b.owned(), ids.slice(4, 8), "C · runtime B owns phones 5-8");
  assert.deepEqual([...asked.get("runtime-a")!].sort((x, y) => x - y), ids.slice(0, 4), "A never attempts to fence B's phones");
  assert.deepEqual([...asked.get("runtime-b")!].sort((x, y) => x - y), ids.slice(4, 8), "B never attempts to fence A's phones");
  assert.equal(campaignDispatchMetrics.snapshot().ownershipDenials - before, 0, "disjoint scopes produce no fencing contention");
  const owners = new Set([...a.owned(), ...b.owned()]);
  assert.equal(owners.size, 8, "L · every phone is owned by the union of the scopes");
  assert.ok(a.log.claims.length > 0 && b.log.claims.length > 0, "both runtimes claimed for their lanes");
  assert.ok(a.log.claims.every((id) => id <= ids[3]!) && b.log.claims.every((id) => id >= ids[4]!), "M · no cross-partition claims");
  assert.ok(a.log.consumed.every((id) => id <= ids[3]!) && b.log.consumed.every((id) => id >= ids[4]!), "N · no cross-partition reservoir consumption");
  assert.ok(a.log.ownership.every(([id]) => id <= ids[3]!) && b.log.ownership.every(([id]) => id >= ids[4]!), "transport ownership tokens only reach the owning runtime's shards");
  await a.reservoir.stop(); await b.reservoir.stop();
});

test("E · overlapping scopes are safely fenced: the second runtime is denied, no phone has two owners, and it acquires after release", async () => {
  const ids = await seedPhones(`scope-e-${Date.now()}`, 6);
  const coordinator = new InMemoryPacingCoordinator();
  const a = runtimeCell("runtime-a", only(ids, 1, 4), coordinator);
  const b = runtimeCell("runtime-b", only(ids, 3, 6), coordinator);
  const before = campaignDispatchMetrics.snapshot().ownershipDenials;
  await a.reservoir.tick(); await b.reservoir.tick(); await settle([a, b]);
  assert.deepEqual(a.owned(), ids.slice(0, 4));
  assert.deepEqual(b.owned(), ids.slice(4, 6), "B is denied the two contested phones while A holds them");
  assert.equal(campaignDispatchMetrics.snapshot().ownershipDenials - before, 2);
  const all = [...a.owned(), ...b.owned()];
  assert.equal(new Set(all).size, all.length, "duplicate ownership is impossible");
  // B keeps being denied on every tick, never takes the phones by force.
  await b.reservoir.tick(); await settle([b]);
  assert.deepEqual(b.owned(), ids.slice(4, 6));
  // A stops: its lanes are released; B's next discovery takes over the contested phones with new fencing tokens.
  const tokensBefore = new Map(a.reservoir.metrics().map((lane) => [lane.phoneNumberId, lane.fencingToken]));
  await a.reservoir.stop();
  await b.reservoir.tick(); await settle([b]);
  assert.deepEqual(b.owned(), ids.slice(2, 6), "B owns its full scope once A released");
  for (const lane of b.reservoir.metrics()) {
    const previous = tokensBefore.get(lane.phoneNumberId);
    if (previous !== undefined) assert.ok(lane.fencingToken > previous, "a migrated phone carries a strictly newer fencing token");
  }
  await b.reservoir.stop();
});

test("F · a restarted runtime reacquires exactly its own scope; the other runtime is untouched", async () => {
  const ids = await seedPhones(`scope-f-${Date.now()}`, 8);
  const coordinator = new InMemoryPacingCoordinator();
  const a = runtimeCell("runtime-a-1", only(ids, 1, 4), coordinator);
  const b = runtimeCell("runtime-b", only(ids, 5, 8), coordinator);
  await a.reservoir.tick(); await b.reservoir.tick(); await settle([a, b]);
  const bTokens = b.reservoir.metrics().map((lane) => lane.fencingToken);
  await a.reservoir.stop();
  assert.deepEqual(a.reservoir.metrics(), [], "I · stop releases the runtime's own lanes");
  const a2 = runtimeCell("runtime-a-2", only(ids, 1, 4), coordinator);
  await a2.reservoir.tick(); await b.reservoir.tick(); await settle([a2, b]);
  assert.deepEqual(a2.owned(), ids.slice(0, 4), "the restarted runtime owns exactly its scope again");
  assert.deepEqual(b.owned(), ids.slice(4, 8));
  assert.deepEqual(b.reservoir.metrics().map((lane) => lane.fencingToken), bTokens, "B's leases are unaffected by A's restart");
  await a2.reservoir.stop(); await b.reservoir.stop();
});

test("G · a phone migrates from runtime A to runtime B through scope changes with exactly one owner at every step", async () => {
  const ids = await seedPhones(`scope-g-${Date.now()}`, 8);
  const asked = new Map<string, Set<number>>();
  const coordinator = recordingCoordinator(new InMemoryPacingCoordinator(), asked);
  const migrating = ids[3]!;
  const a = runtimeCell("runtime-a", only(ids, 1, 4), coordinator);
  const b = runtimeCell("runtime-b", new Set(ids.slice(3, 8)), coordinator); // B's new scope already includes the phone
  await a.reservoir.tick(); await b.reservoir.tick(); await settle([a, b]);
  assert.ok(a.owned().includes(migrating) && !b.owned().includes(migrating), "before migration A owns it and B is denied");
  await a.reservoir.stop();
  const a2 = runtimeCell("runtime-a-2", only(ids, 1, 3), coordinator); // A restarted without the phone
  await a2.reservoir.tick(); await b.reservoir.tick(); await settle([a2, b]);
  assert.deepEqual(a2.owned(), ids.slice(0, 3));
  assert.deepEqual(b.owned(), ids.slice(3, 8), "B owns the migrated phone");
  assert.ok(!asked.get("runtime-a-2")!.has(migrating), "the restarted A never asks for the migrated phone");
  const union = [...a2.owned(), ...b.owned()];
  assert.equal(new Set(union).size, 8);
  await a2.reservoir.stop(); await b.reservoir.stop();
});

test("H · stale runtime fencing: a dead owner's lease expires by TTL, the scoped successor takes over with a newer token, and the stale owner cannot reclaim", async () => {
  const ids = await seedPhones(`scope-h-${Date.now()}`, 2);
  let clock = Date.now();
  const coordinator = new InMemoryPacingCoordinator(() => clock);
  const a = runtimeCell("runtime-a", new Set(ids), coordinator);
  const b = runtimeCell("runtime-b", new Set(ids), coordinator);
  await a.reservoir.tick(); await settle([a]);
  const aTokens = new Map(a.reservoir.metrics().map((lane) => [lane.phoneNumberId, lane.fencingToken]));
  // A dies: no release, no further ticks. B is denied while A's lease is valid.
  clock += 1_000;
  await b.reservoir.tick(); await settle([b]);
  assert.deepEqual(b.owned(), []);
  clock += 5_000; // past the 5s ownership TTL
  await b.reservoir.tick(); await settle([b]);
  assert.deepEqual(b.owned(), ids, "B acquires the phones once A's lease expired");
  for (const lane of b.reservoir.metrics()) assert.ok(lane.fencingToken > aTokens.get(lane.phoneNumberId)!, "the successor's token is strictly newer");
  // The stale runtime comes back: it is denied, drops its lanes without releasing B's lease, and B keeps ownership.
  await a.reservoir.tick(); await settle([a]);
  assert.deepEqual(a.owned(), []);
  assert.ok(a.log.revoked.length >= 2, "the stale runtime revokes its own transport ownership");
  await b.reservoir.tick(); await settle([b]);
  assert.deepEqual(b.owned(), ids, "B still owns after the stale runtime's attempt");
  await a.reservoir.stop(); await b.reservoir.stop();
});

test("K · a phone is never owned by two runtimes at once under repeated concurrent discovery", async () => {
  const ids = await seedPhones(`scope-k-${Date.now()}`, 8);
  const coordinator = new InMemoryPacingCoordinator();
  const cells = [
    runtimeCell("cell-1", only(ids, 1, 5), coordinator),
    runtimeCell("cell-2", only(ids, 4, 8), coordinator),
    runtimeCell("cell-3", undefined, coordinator),
  ];
  for (let round = 0; round < 5; round += 1) {
    await Promise.all(cells.map((cell) => cell.reservoir.tick()));
    await settle(cells);
    const all = cells.flatMap((cell) => cell.owned());
    assert.equal(new Set(all).size, all.length, `round ${round}: no phone has two owners`);
    // The unscoped cell also owns phones of other fixtures in the shared test database; count only this fixture's.
    assert.equal(all.filter((id) => ids.includes(id)).length, 8, `round ${round}: every phone of the fixture has an owner`);
  }
  await Promise.all(cells.map((cell) => cell.reservoir.stop()));
});

test("runtime · CAMPAIGN_TRANSPORT_PHONE_IDS scopes a CampaignRuntime, and an unset variable leaves it unscoped", async () => {
  const previous = process.env[CAMPAIGN_TRANSPORT_PHONE_IDS_ENV];
  const sender = { async send() { return { providerMessageId: "x" }; } } as any;
  try {
    delete process.env[CAMPAIGN_TRANSPORT_PHONE_IDS_ENV];
    const unscoped = new CampaignRuntime(sender, undefined, { pacingCoordinator: new InMemoryPacingCoordinator() });
    assert.equal(unscoped.phoneScope(), undefined);
    await unscoped.stop();
    process.env[CAMPAIGN_TRANSPORT_PHONE_IDS_ENV] = "1-4";
    const scoped = new CampaignRuntime(sender, undefined, { pacingCoordinator: new InMemoryPacingCoordinator() });
    assert.deepEqual([...scoped.phoneScope()!], [1, 2, 3, 4]);
    await scoped.stop();
    const explicit = new CampaignRuntime(sender, undefined, { pacingCoordinator: new InMemoryPacingCoordinator(), phoneScope: new Set([9]) });
    assert.deepEqual([...explicit.phoneScope()!], [9], "an explicit option wins over the environment");
    await explicit.stop();
  } finally {
    if (previous === undefined) delete process.env[CAMPAIGN_TRANSPORT_PHONE_IDS_ENV];
    else process.env[CAMPAIGN_TRANSPORT_PHONE_IDS_ENV] = previous;
  }
});
