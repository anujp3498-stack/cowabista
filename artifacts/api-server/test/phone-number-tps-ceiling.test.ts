import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  providerConnectionsTable,
} from "@workspace/db";
import { syncWhatsApp } from "../src/services/whatsapp-sync";
import phoneNumbersRouter from "../src/routes/phone-numbers";

// Regression coverage for the per-number TPS ceiling bug: operators were
// permanently stuck at the conservative 50-mps default because
// providerMetadata.approvedTpsLimit -- the only value routes/phone-numbers.ts
// trusts to allow a higher configured TPS -- was never populated by
// whatsapp-sync.ts, even for a genuinely synced, provider-verified number.
// These tests exercise the real route handlers and the real sync function,
// not a reimplementation of their logic.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRouteHandler(router: any, path: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${path}`);
}

function fakeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.send = (body?: unknown) => { res.body = body; return res; };
  return res;
}

async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization;
}

async function setUpMockConnection(organizationId: number, externalId: string) {
  await db.insert(providerConnectionsTable).values({
    organizationId,
    provider: "whatsapp-business",
    mode: "mock",
    configuredWabaExternalId: externalId,
    status: "configured",
  });
}

async function loadPhone(organizationId: number) {
  const [phone] = await db.select().from(phoneNumbersTable).where(eq(phoneNumbersTable.organizationId, organizationId));
  return phone;
}

const post = findRouteHandler(phoneNumbersRouter, "/phone-numbers", "post");
const patch = findRouteHandler(phoneNumbersRouter, "/phone-numbers/:phoneNumberId", "patch");

test("a brand-new, never-synced phone number is still capped at the conservative unverified default", async () => {
  const slug = `tps-new-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    const rejected = fakeResponse();
    await post(
      { organizationId: organization.id, body: { phone: "+15550001111", displayName: "New number", tpsLimit: 200 } },
      rejected,
      () => {},
    );
    assert.equal(rejected.statusCode, 409, JSON.stringify(rejected.body));

    const accepted = fakeResponse();
    await post(
      { organizationId: organization.id, body: { phone: "+15550001111", displayName: "New number", tpsLimit: 40 } },
      accepted,
      () => {},
    );
    assert.equal(accepted.statusCode, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.tpsLimit, 40);
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("syncing a real (mock-mode) WhatsApp account populates a genuine provider-approved TPS ceiling, unblocking the normal operator raise flow", async () => {
  const slug = `tps-sync-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    await setUpMockConnection(organization.id, `${slug}-waba`);
    await syncWhatsApp(organization.id);

    const phone = await loadPhone(organization.id);
    assert.ok(phone, "sync must have inserted a phone number row");
    // The mock provider client reports STANDARD throughput (Meta's default
    // tier, 80 mps) -- sync must record that as the approved ceiling without
    // touching the operator-configured tpsLimit itself.
    assert.equal(phone.providerMetadata.approvedTpsLimit, 80);
    assert.equal(phone.providerMetadata.throughputLevel, "STANDARD");
    assert.equal(phone.tpsLimit, 50, "sync must not silently raise the operator-configured tpsLimit on its own");

    const withinCap = fakeResponse();
    await patch(
      { organizationId: organization.id, params: { phoneNumberId: String(phone.id) }, body: { tpsLimit: 80 } },
      withinCap,
      () => {},
    );
    assert.equal(withinCap.statusCode, 200, JSON.stringify(withinCap.body));

    const aboveCap = fakeResponse();
    await patch(
      { organizationId: organization.id, params: { phoneNumberId: String(phone.id) }, body: { tpsLimit: 81 } },
      aboveCap,
      () => {},
    );
    assert.equal(aboveCap.statusCode, 409, JSON.stringify(aboveCap.body));
    const stillCapped = await loadPhone(organization.id);
    assert.equal(stillCapped.tpsLimit, 80, "the rejected over-cap PATCH must not have changed the stored tpsLimit");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("re-syncing overwrites a stale/corrupted provider-approved ceiling instead of leaving it in place", async () => {
  const slug = `tps-resync-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    await setUpMockConnection(organization.id, `${slug}-waba`);
    await syncWhatsApp(organization.id);
    const first = await loadPhone(organization.id);
    assert.equal(first.providerMetadata.approvedTpsLimit, 80);

    // Simulate a stale/corrupted row -- e.g. from a bug, a manual DB edit, or
    // (before this fix) a sync path that never refreshed providerMetadata on
    // conflict -- reporting an inflated ceiling that Meta never actually
    // approved.
    await db.update(phoneNumbersTable).set({
      providerMetadata: { ...first.providerMetadata, approvedTpsLimit: 9999 },
    }).where(eq(phoneNumbersTable.id, first.id));

    await syncWhatsApp(organization.id);
    const resynced = await loadPhone(organization.id);
    assert.equal(resynced.providerMetadata.approvedTpsLimit, 80, "re-sync must overwrite a stale ceiling with the real provider-reported one");

    const exploit = fakeResponse();
    await patch(
      { organizationId: organization.id, params: { phoneNumberId: String(resynced.id) }, body: { tpsLimit: 9999 } },
      exploit,
      () => {},
    );
    assert.equal(exploit.statusCode, 409, JSON.stringify(exploit.body));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test("an operator can never configure TPS above the actual provider-approved cap, even a high one", async () => {
  const slug = `tps-high-${process.pid}-${Date.now()}`;
  const organization = await createOrganization(slug);
  try {
    // Shaped exactly like a HIGH-throughput number whatsapp-sync.ts would
    // produce (Meta's automatic 1,000 mps upgrade tier).
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id,
      phone: "+15550009999",
      displayName: "High throughput number",
      status: "Connected",
      tpsLimit: 50,
      providerMetadata: { approvedTpsLimit: 1000, throughputLevel: "HIGH" },
    }).returning();

    const withinCap = fakeResponse();
    await patch(
      { organizationId: organization.id, params: { phoneNumberId: String(phone.id) }, body: { tpsLimit: 1000 } },
      withinCap,
      () => {},
    );
    assert.equal(withinCap.statusCode, 200, JSON.stringify(withinCap.body));

    const aboveCap = fakeResponse();
    await patch(
      { organizationId: organization.id, params: { phoneNumberId: String(phone.id) }, body: { tpsLimit: 1001 } },
      aboveCap,
      () => {},
    );
    assert.equal(aboveCap.statusCode, 409, JSON.stringify(aboveCap.body));
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
  }
});

test.after(async () => {
  await pool.end();
});
