// Rocket Campaign roadmap requirement: "per-number configurable TPS up to
// (never silently reduced below) the provider-approved cap", combined with
// "parallel per-number processing". Earlier rate-limit tests only prove the
// atomic pacing reservations are correct for a handful of concurrent
// claims; they never run a real CampaignRuntime over wall-clock time to see
// whether several differently-configured phone numbers can each *sustain*
// their own configured throughput at once. Before the parallel-lanes fix to
// CampaignRuntime.tick(), that would have been structurally impossible: one
// runtime could only ever have one send in flight, so the sum of achieved
// rates across numbers was capped by 1/sendLatency, not by each number's own
// configured TPS. This test seeds three phone numbers with three different
// configured caps, runs a real CampaignRuntime for several seconds, and
// checks each phone's achieved rate is both never above its cap (the "up
// to" ceiling) and not silently starved far below it (the "never silently
// reduced below" guarantee) despite sharing one runtime with the others.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignJobsTable,
  campaignMetricsTable,
  campaignRoutesTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  campaignsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  pool,
  templatesTable,
  wabasTable,
} from "@workspace/db";
import type { ProviderSender } from "../src/services/campaign-queue";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { inFlightRegistry } from "../src/services/campaign-inflight";
import {
  CAMPAIGN_PLATFORM_MAX_TPS,
  InMemoryPacingCoordinator,
} from "../src/services/campaign-pacing-coordinator";

after(async () => {
  inFlightRegistry.clear();
  await pool.end();
});

class ImmediateSender implements ProviderSender {
  readonly sentAtByRoute = new Map<number, number[]>();

  async send(job: typeof campaignJobsTable.$inferSelect, options: { idempotencyKey: string }) {
    if (job.routeId) {
      const timestamps = this.sentAtByRoute.get(job.routeId) ?? [];
      timestamps.push(performance.now());
      this.sentAtByRoute.set(job.routeId, timestamps);
    }
    return { providerMessageId: `provider-${options.idempotencyKey}` };
  }
}

const RUN_SECONDS = 5;
const PHONE_CONFIGS = [
  { label: "low", tps: 5 },
  { label: "mid", tps: 10 },
  { label: "high", tps: 18 },
];
// Generous backlog so no phone ever runs dry mid-run regardless of scheduling jitter.
const JOBS_PER_PHONE = Math.max(...PHONE_CONFIGS.map((c) => c.tps)) * (RUN_SECONDS + 3);

function assertNoRollingSecondExceedsCap(timestamps: readonly number[], cap: number, label: string): void {
  for (let start = 0; start < timestamps.length; start += 1) {
    let sendsInWindow = 0;
    for (let end = start; end < timestamps.length && timestamps[end]! - timestamps[start]! < 1_000; end += 1) {
      sendsInWindow += 1;
    }
    assert.ok(
      sendsInWindow <= cap,
      `${label} phone (cap ${cap}/s) sent ${sendsInWindow} messages in rolling second beginning at ${timestamps[start]!.toFixed(1)}ms`,
    );
  }
}

async function seedPhone(slug: string, organizationId: number, label: string, tps: number) {
  const [waba] = await db.insert(wabasTable).values({
    organizationId, externalId: `${slug}-${label}-waba`, displayName: label,
  }).returning();
  const [phone] = await db.insert(phoneNumbersTable).values({
    organizationId, wabaId: waba.id,
    phone: `+1555${organizationId.toString().padStart(4, "0")}${PHONE_CONFIGS.findIndex((c) => c.label === label)}00`,
    displayName: `${slug}-${label}`, status: "Connected", tpsLimit: tps,
  }).returning();
  const [template] = await db.insert(templatesTable).values({
    organizationId, wabaId: waba.id, name: `${slug}-${label}-template`, status: "Approved",
    body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }],
  }).returning();
  const [campaign] = await db.insert(campaignsTable).values({
    organizationId, name: `${slug}-${label}`, status: "Running",
  }).returning();
  const [route] = await db.insert(campaignRoutesTable).values({
    organizationId, campaignId: campaign.id, phoneNumberId: phone.id, templateId: template.id,
    configuredTps: tps, queueDepth: JOBS_PER_PHONE,
  }).returning();
  await db.insert(campaignTemplateSelectionsTable).values({ organizationId, campaignId: campaign.id, templateId: template.id });
  await db.insert(campaignTemplateMappingsTable).values({
    organizationId, campaignId: campaign.id, templateId: template.id, component: "body", variable: "1", source: "static", sourceValue: "World",
  });
  await db.insert(campaignMetricsTable).values({
    organizationId, campaignId: campaign.id, total: JOBS_PER_PHONE, valid: JOBS_PER_PHONE, queued: JOBS_PER_PHONE,
  });
  const contacts = await db.insert(campaignContactsTable).values(Array.from({ length: JOBS_PER_PHONE }, (_, index) => {
    const recipientPhone = `+1777${organizationId.toString().padStart(4, "0")}${PHONE_CONFIGS.findIndex((c) => c.label === label)}${index.toString().padStart(4, "0")}`;
    return {
      organizationId, campaignId: campaign.id, rowNumber: index + 1,
      rawPhone: recipientPhone, normalizedPhone: recipientPhone,
      data: { phone: recipientPhone }, status: "Valid" as const, partitionKey: index, routeId: route.id,
      idempotencyKey: `${slug}-${label}-contact-${index}`,
    };
  })).returning();
  await db.insert(campaignJobsTable).values(contacts.map((contact, index) => ({
    organizationId, campaignId: campaign.id, routeId: route.id, contactId: contact.id,
    type: "ResolveTemplateAndSend", idempotencyKey: `${slug}-${label}-send-${index}`,
  })));
  return { phone, route, campaign };
}

test(
  "three phone numbers with different configured TPS each sustain close to their own cap concurrently on one CampaignRuntime, and none exceeds its cap",
  { timeout: 30_000 },
  async () => {
    const slug = `sustained-tps-${process.pid}-${Date.now()}`;
    const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
    const fixtures = await Promise.all(
      PHONE_CONFIGS.map((config) => seedPhone(slug, organization.id, config.label, config.tps)),
    );

    const sender = new ImmediateSender();
    // One coordinator is shared by every lane of this real runtime. Its
    // per-phone keys make the three independently configured timelines a
    // direct test of AtomicPacingCoordinator rather than database windows.
    const pacingCoordinator = new InMemoryPacingCoordinator();
    const runtime = new CampaignRuntime(sender, undefined, { pacingCoordinator });
    try {
      runtime.start(20);
      await new Promise((resolve) => setTimeout(resolve, RUN_SECONDS * 1_000));
      await runtime.stop();

      const actualTimelines: Array<{ label: string; first: number; last: number }> = [];
      for (const [index, config] of PHONE_CONFIGS.entries()) {
        const route = fixtures[index]!.route;
        const sent = (await db.select().from(campaignJobsTable).where(and(
          eq(campaignJobsTable.routeId, route.id),
          eq(campaignJobsTable.status, "Sent"),
        ))).length;
        const achievedRate = sent / RUN_SECONDS;
        const cap = Math.min(config.tps, CAMPAIGN_PLATFORM_MAX_TPS);
        // Never-silently-throttled floor: with three independently-capped
        // numbers running concurrently on one runtime, each should still
        // reach the large majority of its own configured rate, not be
        // starved down towards 1/sendLatency by the other numbers' traffic.
        assert.ok(achievedRate >= cap * 0.6, `${config.label} phone (cap ${cap}/s) must not be silently throttled far below its cap, got only ~${achievedRate.toFixed(1)}/s`);

        const claimed = await db.select({
          id: campaignJobsTable.id,
          scheduledSendAt: campaignJobsTable.scheduledSendAt,
        }).from(campaignJobsTable).where(and(
          eq(campaignJobsTable.routeId, route.id),
          eq(campaignJobsTable.status, "Sent"),
        )).orderBy(asc(campaignJobsTable.scheduledSendAt), asc(campaignJobsTable.id));
        assert.ok(claimed.length > cap, `${config.label} phone must claim enough scheduled slots to assess pacing`);
        assert.ok(
          claimed.every((job) => job.scheduledSendAt !== null),
          `${config.label} phone must assign scheduledSendAt to every claimed job`,
        );
        const scheduledSlots = claimed.map((job) => job.scheduledSendAt!.getTime());
        const slotIntervals = scheduledSlots.slice(1).map((slot, slotIndex) => slot - scheduledSlots[slotIndex]!);
        assert.ok(
          slotIntervals.every((interval) => interval > 0),
          `${config.label} phone scheduled slots must be strictly monotonic`,
        );
        assert.ok(
          Math.min(...slotIntervals) >= Math.floor(1_000 / cap),
          `${config.label} phone scheduled slots must respect its ${cap}/s effective cap`,
        );
        const actualTimestamps = [...(sender.sentAtByRoute.get(route.id) ?? [])].sort((left, right) => left - right);
        assert.equal(actualTimestamps.length, claimed.length, `${config.label} phone must record every claimed send`);
        assertNoRollingSecondExceedsCap(actualTimestamps, cap, config.label);
        actualTimelines.push({
          label: config.label,
          first: actualTimestamps[0]!,
          last: actualTimestamps[actualTimestamps.length - 1]!,
        });
      }
      // The phones were active over a common interval. This rejects a runtime
      // that drains one phone before it starts another, while the per-phone
      // slot and rolling-window checks above retain their distinct TPS caps.
      const latestFirstSend = Math.max(...actualTimelines.map(({ first }) => first));
      const earliestLastSend = Math.min(...actualTimelines.map(({ last }) => last));
      assert.ok(
        latestFirstSend <= earliestLastSend,
        `phone timelines must overlap rather than serialize by phone: ${actualTimelines.map(({ label, first, last }) => `${label}=${(last - first).toFixed(0)}ms`).join(", ")}`,
      );
    } finally {
      await runtime.stop();
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
    }
  },
);
