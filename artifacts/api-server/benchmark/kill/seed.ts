// Seeds the kill benchmark's workspace into the disposable benchmark database: one organization whose phones send
// with an encrypted workspace credential (so every send goes over HTTP to the fake Graph server), one approved
// provider-backed template verified by the eligibility backfill, one Running campaign with one route per phone and
// `rows` jobs per route with unique recipients.
//
// Production-shaped (as benchmark/campaign-benchmark.ts): an Active frozen plan, and every job carries planId,
// configuredTps and templateId like Execute writes them. Jobs without a plan take the per-job template-resolution
// path (template-resolution.ts), about 8 ms per job, which no real Rocket campaign uses.
//
// Env: DATABASE_URL (the benchmark database), WHATSAPP_CREDENTIAL_ENCRYPTION_KEY, KILL_BENCH_TOKEN (a fake token,
// never logged), KILL_BENCH_PHONES, KILL_BENCH_TPS, KILL_BENCH_ROWS_PER_PHONE, KILL_BENCH_SLUG, KILL_BENCH_SEED_OUT.
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  campaignMetricsTable,
  campaignPlansTable,
  campaignRoutesTable,
  campaignsTable,
  campaignTemplateSelectionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { credentialFingerprint, encryptCredential } from "../../src/services/credential-crypto";
import { backfillTemplateEligibility } from "../../src/services/template-eligibility";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function positive(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const token = required("KILL_BENCH_TOKEN");
const phones = positive("KILL_BENCH_PHONES");
const tps = positive("KILL_BENCH_TPS");
const rowsPerPhone = positive("KILL_BENCH_ROWS_PER_PHONE");
const slug = required("KILL_BENCH_SLUG");
const out = required("KILL_BENCH_SEED_OUT");

const started = Date.now();
const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
const orgId = organization!.id;
const enc = encryptCredential(token, { organizationId: orgId, kind: "manual_token", provider: "whatsapp-business" });
const [credential] = await db.insert(whatsappCredentialsTable).values({
  organizationId: orgId, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
  tokenFingerprint: credentialFingerprint(token), status: "active",
}).returning();
const [waba] = await db.insert(wabasTable).values({
  organizationId: orgId, externalId: `kill-waba-${slug}`, displayName: "Kill benchmark account", credentialId: credential!.id,
}).returning();
const phoneRows: Array<typeof phoneNumbersTable.$inferSelect> = [];
for (let index = 0; index < phones; index += 1) {
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: orgId, wabaId: waba!.id, providerPhoneId: `kill-pp-${index + 1}`,
    phone: `+1555${String(orgId).padStart(5, "0")}${String(index).padStart(2, "0")}`,
    displayName: `Kill sender ${index + 1}`, status: "Connected", setupState: "active", tpsLimit: tps,
    credentialId: credential!.id, sendingCredentialId: credential!.id,
  }).returning();
  phoneRows.push(phone!);
}
const [template] = await db.insert(templatesTable).values({
  organizationId: orgId, wabaId: waba!.id, providerTemplateId: `kill-tpl-${slug}`,
  metadata: { source: "workspace_credential", providerStatus: "APPROVED" },
  name: "kill_benchmark", status: "Approved", language: "en_US", category: "Marketing",
  body: "Kill benchmark message", components: [{ type: "BODY", text: "Kill benchmark message" }],
}).returning();
await backfillTemplateEligibility(orgId);

const [campaign] = await db.insert(campaignsTable).values({ organizationId: orgId, name: `${slug}-campaign`, status: "Running" }).returning();
await db.insert(campaignTemplateSelectionsTable).values({ organizationId: orgId, campaignId: campaign!.id, templateId: template!.id });
const total = phones * rowsPerPhone;
await db.insert(campaignMetricsTable).values({ organizationId: orgId, campaignId: campaign!.id, total, valid: total, queued: total });

const routes = await db.insert(campaignRoutesTable).values(phoneRows.map((phone) => ({
  organizationId: orgId, campaignId: campaign!.id, phoneNumberId: phone.id, templateId: template!.id,
  configuredTps: tps, queueDepth: rowsPerPhone,
}))).returning();
const [plan] = await db.insert(campaignPlansTable).values({
  organizationId: orgId, campaignId: campaign!.id, version: 1, allocatorVersion: "kill-benchmark-production-shape-v1",
  partitionCount: Math.max(routes.length, 64),
  routes: routes.map((route, index) => ({
    routeId: route.id, phoneNumberId: phoneRows[index]!.id, templateId: template!.id, configuredTps: tps, providerTpsLimit: tps,
    phone: phoneRows[index]!.phone, displayName: phoneRows[index]!.displayName, sendingCredentialId: credential!.id,
  })),
  templateIds: [template!.id],
  templatesSnapshot: [{
    id: template!.id, name: template!.name, language: template!.language, wabaId: template!.wabaId,
    body: template!.body, components: template!.components,
  }],
  mappingsSnapshot: [],
  status: "Active",
}).returning();
for (const [index, route] of routes.entries()) {
  // Recipients are +1999<phone index><9-digit serial>: unique per run, and the phone is readable from the number.
  await db.execute(sql`
    insert into campaign_contacts
      (organization_id, campaign_id, row_number, raw_phone, normalized_phone, data, status, route_id, idempotency_key)
    select ${orgId}::int, ${campaign!.id}::int, ${index * rowsPerPhone}::int + g, n, n, '{}'::jsonb, 'Valid', ${route!.id}::int,
           ${slug}::text || '-p' || ${String(index)}::text || '-contact-' || g::text
    from generate_series(1, ${rowsPerPhone}::int) g,
         lateral (select '+1999' || ${String(index)}::text || lpad(g::text, 9, '0') as n) r`);
  await db.execute(sql`
    insert into campaign_jobs (organization_id, campaign_id, route_id, contact_id, configured_tps, template_id, plan_id, type,
                               idempotency_key, payload, available_at)
    select organization_id, campaign_id, route_id, id, ${tps}::int, ${template!.id}::int, ${plan!.id}::int, 'ResolveTemplateAndSend',
           ${slug}::text || '-p' || ${String(index)}::text || '-send-' || row_number::text, jsonb_build_object('contactId', id), now()
    from campaign_contacts where campaign_id = ${campaign!.id}::int and route_id = ${route!.id}::int`);
}
await db.execute(sql`analyze campaign_jobs`);
await db.execute(sql`analyze campaign_contacts`);

writeFileSync(out, `${JSON.stringify({
  slug, organizationId: orgId, campaignId: campaign!.id, planId: plan!.id, templateId: template!.id, tps, rowsPerPhone, total,
  phones: phoneRows.map((phone, index) => ({
    index, id: phone.id, providerPhoneId: phone.providerPhoneId, routeId: routes[index]!.id, recipientPrefix: `+1999${index}`,
  })),
  seededMs: Date.now() - started,
}, null, 2)}\n`);
console.log(`KILL_BENCH_SEEDED campaign=${campaign!.id} phones=${phones} rows=${total} in ${Date.now() - started} ms`);
await pool.end();
process.exit(0);
