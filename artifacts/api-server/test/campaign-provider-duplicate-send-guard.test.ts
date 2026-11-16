// Closes a coverage gap identified during the roadmap audit: the send path
// (WhatsAppTemplateSender.send) is *designed* to make a duplicate send to
// WhatsApp impossible even if a worker crashes between reserving a
// provider_messages row and recording the provider's response, but until
// now nothing exercised that exact danger window with a real test. This
// test proves both halves of that guarantee against the real send code path
// (not a mock of it):
//
//   1. If a prior attempt got as far as reserving a send (status "pending"
//      or "delivery_unknown" -- the state a crash-after-accept/before-commit
//      or an ambiguous provider response would leave behind) a retried job
//      must fail closed with a manual-reconciliation error, never silently
//      re-send.
//   2. If a prior attempt already completed (status "sent"), a retried job
//      must return the exact same provider message id without attempting a
//      new provider call at all.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  providerMessagesTable,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import { resolveJobTemplate } from "../src/services/template-resolution";
import { WhatsAppTemplateSender } from "../src/services/whatsapp-template-sender";
import { ProviderRequestError } from "../src/services/whatsapp-provider";

after(async () => {
  await pool.end();
});

async function seedFixture(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `${slug}-waba`, displayName: slug }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId: organization.id, wabaId: waba.id,
    phone: `+1555${organization.id.toString().padStart(7, "0")}`,
    displayName: `${slug}-phone`, status: "Connected", tpsLimit: 10,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId: organization.id, wabaId: waba.id, name: `${slug}-tpl`, status: "Approved", language: "en_US",
    body: "Hi {{1}}",
    components: [{ type: "BODY", text: "Hi {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({ organizationId: organization.id, name: slug, status: "Running" }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId: organization.id, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id, configuredTps: 10,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId: organization.id, campaignId: campaign.id, templateId: template.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId: organization.id, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "csv", sourceValue: "name",
  });
  const [contact] = await db.insert(campaignContactsTable).values({
    organizationId: organization.id, campaignId: campaign.id, rowNumber: 1,
    rawPhone: "+15559993001", normalizedPhone: "+15559993001", status: "Valid",
    data: { name: "Dana" }, idempotencyKey: `${slug}-contact`,
  }).returning();
  const [job] = await db.insert(campaignJobsTable).values({
    organizationId: organization.id, campaignId: campaign.id, routeId: route.id, contactId: contact.id,
    templateId: template.id, type: "ResolveTemplateAndSend", status: "Processing", lockedBy: "test-worker",
    leaseToken: `${slug}-lease`, idempotencyKey: `${slug}-send`,
  }).returning();
  return { organization, phone, template, campaign, route, contact, job };
}

test("a job crashed mid-flight with an unresolved provider reservation is never silently retried into a duplicate send", async () => {
  const slug = `dup-guard-pending-${process.pid}-${Date.now()}`;
  const fixture = await seedFixture(slug);
  try {
    // Simulate the exact crash window: a previous attempt reserved the send
    // (advisory-lock transaction committed a "pending" row) but the process
    // died before the provider call resolved and the row was ever updated
    // to "sent" or "rejected". This is indistinguishable, from a retry's
    // point of view, from "we don't know if WhatsApp already has this".
    await db.insert(providerMessagesTable).values({
      organizationId: fixture.organization.id, campaignJobId: fixture.job.id, provider: "whatsapp-business",
      requestKey: `${slug}-orphaned-reservation`, status: "pending", recipientExternalId: fixture.contact.normalizedPhone,
    });

    const resolved = await resolveJobTemplate(fixture.job);
    const sender = new WhatsAppTemplateSender();
    await assert.rejects(
      () => sender.send(resolved, { signal: new AbortController().signal, idempotencyKey: resolved.idempotencyKey }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError, "must fail with the provider-request error type, not a generic crash");
        assert.match(error.message, /manual reconciliation/i);
        return true;
      },
      "a retried job must never attempt a new provider send while a prior reservation's outcome is unknown",
    );

    const rows = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, fixture.job.id));
    assert.equal(rows.length, 1, "the retry must not create a second provider_messages row -- still exactly one reservation for this job");
    assert.equal(rows[0].status, "pending", "the retry must not have mutated the orphaned reservation's state on its own");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

test("a job that already completed returns the same provider message id on retry, without a new provider call", async () => {
  const slug = `dup-guard-sent-${process.pid}-${Date.now()}`;
  const fixture = await seedFixture(slug);
  try {
    const [priorSend] = await db.insert(providerMessagesTable).values({
      organizationId: fixture.organization.id, campaignJobId: fixture.job.id, provider: "whatsapp-business",
      requestKey: `${slug}-completed`,
      status: "sent",
      providerMessageId: `wamid.already-sent-${fixture.organization.id}-${fixture.job.id}`,
      recipientExternalId: fixture.contact.normalizedPhone,
    }).returning();

    const resolved = await resolveJobTemplate(fixture.job);
    const sender = new WhatsAppTemplateSender();
    const result = await sender.send(resolved, { signal: new AbortController().signal, idempotencyKey: resolved.idempotencyKey });
    assert.equal(result.providerMessageId, priorSend.providerMessageId, "a retry of an already-sent job must return the exact same provider message id");

    const rows = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, fixture.job.id));
    assert.equal(rows.length, 1, "no second provider_messages row was created by the retry");
    assert.equal(rows[0].providerMessageId, priorSend.providerMessageId, "the original reservation row was never overwritten with a new send");
  } finally {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
  }
});

for (const status of ["delivered", "read", "failed"] as const) {
  test(`a job whose accepted send a status webhook already moved to ${status} returns the same provider message id on retry, without a new provider call`, async () => {
    // The crash window between the outcome flush (intent sent, with the provider's id) and the job's own settlement:
    // the job stays Processing, a status webhook moves the intent on within seconds, and only then does lease
    // recovery requeue the job. Before this was covered, only `sent` was treated as already sent, so a delivered
    // (or read, or failed-delivery) message was sent a second time.
    const slug = `dup-guard-${status}-${process.pid}-${Date.now()}`;
    const fixture = await seedFixture(slug);
    try {
      const [priorSend] = await db.insert(providerMessagesTable).values({
        organizationId: fixture.organization.id, campaignJobId: fixture.job.id, provider: "whatsapp-business",
        requestKey: `${slug}-completed`,
        status,
        providerMessageId: `wamid.moved-on-${status}-${fixture.organization.id}-${fixture.job.id}`,
        recipientExternalId: fixture.contact.normalizedPhone,
      }).returning();

      const resolved = await resolveJobTemplate(fixture.job);
      const sender = new WhatsAppTemplateSender();
      const result = await sender.send(resolved, { signal: new AbortController().signal, idempotencyKey: resolved.idempotencyKey });
      assert.equal(result.providerMessageId, priorSend.providerMessageId, "the retry replays the accepted id");

      const rows = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.campaignJobId, fixture.job.id));
      assert.equal(rows.length, 1, "no second provider_messages row");
      assert.equal(rows[0].providerMessageId, priorSend.providerMessageId, "the accepted id is never overwritten");
      assert.equal(rows[0].status, status, "the webhook's status is kept; the replay writes nothing over it");
    } finally {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organization.id));
    }
  });
}

test("an outcome whose provider id is already recorded for another job cannot hold the outcome flush of the whole process", async () => {
  // The mock client's id is a hash of phone and payload, so two campaigns sending the same template to the same
  // number get the same id. Before, the batched flush violated provider_messages_provider_id_uq and retried the
  // whole batch forever, holding every later outcome of the process (live workspaces included).
  const stamp = `${process.pid}-${Date.now()}`;
  const a = await seedFixture(`dup-guard-collide-a-${stamp}`);
  const b = await seedFixture(`dup-guard-collide-b-${stamp}`);
  const c = await seedFixture(`dup-guard-collide-c-${stamp}`);
  try {
    const rows = await db.insert(providerMessagesTable).values([a, b, c].map((fixture, i) => ({
      organizationId: fixture.organization.id, campaignJobId: fixture.job.id, provider: "whatsapp-business",
      requestKey: `dup-guard-collide-${stamp}-${i}`, status: "pending", recipientExternalId: fixture.contact.normalizedPhone,
    }))).returning();
    const sender = new WhatsAppTemplateSender();
    const shared = `wamid.collide-${stamp}`;
    const acknowledged = [
      sender.settlePreparedTransport(a.job, { providerMessageRowId: rows[0]!.id }, { providerMessageId: shared }),
      sender.settlePreparedTransport(b.job, { providerMessageRowId: rows[1]!.id }, { providerMessageId: shared }),
      sender.settlePreparedTransport(c.job, { providerMessageRowId: rows[2]!.id }, { providerMessageId: `wamid.unrelated-${stamp}` }),
    ];
    await sender.flushPreparedOutcomes().catch(() => {});
    const settled = await Promise.race([
      Promise.all(acknowledged).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.equal(settled, true, "every outcome is acknowledged; none is left retrying behind the collision");
    const after = new Map((await db.select().from(providerMessagesTable)
      .where(eq(providerMessagesTable.requestKey, `dup-guard-collide-${stamp}-1`))).map((row) => [row.id, row]));
    const [first] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, rows[0]!.id));
    const [second] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, rows[1]!.id));
    const [third] = await db.select().from(providerMessagesTable).where(eq(providerMessagesTable.id, rows[2]!.id));
    assert.ok(after.size === 1);
    assert.deepEqual([first!.status, first!.providerMessageId], ["sent", shared]);
    assert.deepEqual([second!.status, second!.providerMessageId], ["sent", `${shared}#${rows[1]!.id}`],
      "recorded as accepted under a row-unique id, so it is still replayed and never re-sent");
    assert.deepEqual([third!.status, third!.providerMessageId], ["sent", `wamid.unrelated-${stamp}`], "the unrelated outcome is not held");
  } finally {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, [a.organization.id, b.organization.id, c.organization.id]));
  }
});
