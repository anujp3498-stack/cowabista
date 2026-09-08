import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  campaignJobsTable,
  campaignMetricsTable,
  campaignsTable,
  db,
  phoneNumbersTable,
  providerEventsTable,
  providerMessagesTable,
  suppressionsTable,
} from "@workspace/db";
import { inFlightRegistry } from "./campaign-inflight";
import { normalizePhone } from "./contact-processing";

export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const suppliedHex = signatureHeader.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type WhatsAppStatus = {
  eventId: string;
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: Date;
  errorCode?: string;
  errorReason?: string;
};

export function parseWhatsAppStatuses(payload: unknown): WhatsAppStatus[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const result: WhatsAppStatus[] = [];
  for (const entry of entries) {
    const changes = entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).changes)
      ? (entry as Record<string, unknown>).changes as unknown[] : [];
    for (const change of changes) {
      const value = change && typeof change === "object" ? (change as Record<string, unknown>).value as Record<string, unknown> : undefined;
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const item of statuses) {
        if (!item || typeof item !== "object") continue;
        const status = item as Record<string, unknown>;
        const type = String(status.status ?? "");
        const messageId = String(status.id ?? "");
        if (!messageId || !["sent", "delivered", "read", "failed"].includes(type)) continue;
        const timestamp = Number(status.timestamp);
        const error = Array.isArray(status.errors) && status.errors[0] && typeof status.errors[0] === "object"
          ? status.errors[0] as Record<string, unknown> : undefined;
        const errorCode = error?.code === undefined ? undefined : String(error.code);
        const errorReason = typeof error?.title === "string"
          ? error.title.slice(0, 300)
          : typeof error?.message === "string" ? error.message.slice(0, 300) : undefined;
        result.push({
          eventId: `${messageId}:${type}:${String(status.timestamp ?? "")}:${errorCode ?? ""}`,
          messageId,
          status: type as WhatsAppStatus["status"],
          occurredAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date(0),
          errorCode,
          errorReason,
        });
      }
    }
  }
  return result;
}

export type WhatsAppInboundOptOut = {
  eventId: string;
  phoneNumberId: string;
  from: string;
  text: string;
  occurredAt: Date;
};

/** Exact-match keywords WhatsApp/carrier convention treats as an opt-out request. */
const OPT_OUT_KEYWORDS = new Set(["stop", "unsubscribe", "opt out", "optout", "cancel", "quit", "end"]);

/**
 * Parses inbound (not status) WhatsApp webhook text messages that look like
 * an opt-out request. Only exact-match keywords are treated as opt-outs --
 * substring matching would false-positive on ordinary messages that happen
 * to contain a word like "stop" ("please stop by tomorrow").
 */
export function parseWhatsAppOptOuts(payload: unknown): WhatsAppInboundOptOut[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const result: WhatsAppInboundOptOut[] = [];
  for (const entry of entries) {
    const changes = entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).changes)
      ? (entry as Record<string, unknown>).changes as unknown[] : [];
    for (const change of changes) {
      const value = change && typeof change === "object" ? (change as Record<string, unknown>).value as Record<string, unknown> : undefined;
      const metadata = value?.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : undefined;
      const phoneNumberId = typeof metadata?.phone_number_id === "string" ? metadata.phone_number_id : undefined;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      if (!phoneNumberId) continue;
      for (const item of messages) {
        if (!item || typeof item !== "object") continue;
        const message = item as Record<string, unknown>;
        if (message.type !== "text") continue;
        const from = typeof message.from === "string" ? message.from : undefined;
        const messageId = typeof message.id === "string" ? message.id : undefined;
        const textBody = message.text && typeof message.text === "object"
          ? (message.text as Record<string, unknown>).body : undefined;
        if (!from || !messageId || typeof textBody !== "string") continue;
        const normalizedKeyword = textBody.trim().toLowerCase();
        if (!OPT_OUT_KEYWORDS.has(normalizedKeyword)) continue;
        const timestamp = Number(message.timestamp);
        result.push({
          eventId: `${messageId}:opt-out`,
          phoneNumberId,
          from,
          text: textBody.slice(0, 300),
          occurredAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date(),
        });
      }
    }
  }
  return result;
}

/**
 * Resolves the inbound message's receiving phone_number_id to a tenant,
 * then records the sender on that tenant's suppression list. Idempotent:
 * replays of the same webhook only refresh the reason/timestamp via the
 * table's (organizationId, normalizedPhone) unique index.
 */
export async function processWhatsAppOptOut(event: WhatsAppInboundOptOut): Promise<"suppressed" | "unmatched" | "invalid"> {
  const [phoneNumber] = await db.select({ organizationId: phoneNumbersTable.organizationId })
    .from(phoneNumbersTable).where(eq(phoneNumbersTable.providerPhoneId, event.phoneNumberId)).limit(1);
  if (!phoneNumber) return "unmatched";
  const normalized = normalizePhone(`+${event.from.replace(/\D/g, "")}`);
  const normalizedPhone = normalized.value;
  if (!normalizedPhone) return "invalid";
  // Same advisory lock key a send reservation takes on this org+phone right
  // before its provider handoff (see whatsapp-template-sender.ts). Taking it
  // here too makes "STOP recorded" and "send reserved" mutually exclusive:
  // whichever transaction commits first is authoritative, so a STOP can
  // never lose a genuine race against an in-flight send for the same phone.
  //
  // normalizedPhone (not normalized.value) is captured above and reused
  // below: narrowing a variable's property is not preserved across a
  // closure boundary, since TS can't rule out the object mutating before
  // the callback runs -- using normalized.value directly inside the
  // transaction callback re-widens it to `string | undefined`.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`suppression-phone:${phoneNumber.organizationId}:${normalizedPhone}`}))`);
    await tx.insert(suppressionsTable).values({
      organizationId: phoneNumber.organizationId,
      normalizedPhone,
      reason: `STOP reply ("${event.text}")`,
    }).onConflictDoUpdate({
      target: [suppressionsTable.organizationId, suppressionsTable.normalizedPhone],
      set: { reason: `STOP reply ("${event.text}")`, updatedAt: new Date() },
    });
    // This is the durable half of reservoir revocation. The same suppression
    // fence serializes prepareBatch's pending-intent arm with STOP: intents
    // armed first are made non-sendable here; STOP first is observed by the
    // bulk prepare validation. The in-memory registry below handles envelopes
    // already handed to a phone lane without putting a DB read on transport.
    await tx.update(providerMessagesTable).set({
      status: "rejected",
      errorReason: `Recipient opted out (STOP reply "${event.text}")`,
    }).where(and(
      eq(providerMessagesTable.organizationId, phoneNumber.organizationId),
      eq(providerMessagesTable.recipientExternalId, normalizedPhone),
      eq(providerMessagesTable.status, "pending"),
    ));
  });
  // Any durable provider intents already armed in an in-memory reservoir are
  // revoked before their paced permit can reach transport.
  inFlightRegistry.abortRecipient(
    phoneNumber.organizationId,
    normalizedPhone,
    `Recipient opted out (${event.text})`,
  );
  return "suppressed";
}

export type StatusDelta = {
  nextStatus: string;
  delivered: number;
  read: number;
  failed: number;
  apply: boolean;
};

export function statusTransition(current: string, incoming: WhatsAppStatus["status"]): StatusDelta {
  if (current === "failed" || current === "read" || current === incoming) {
    return { nextStatus: current, delivered: 0, read: 0, failed: 0, apply: false };
  }
  if (current === "delivered") {
    return incoming === "read"
      ? { nextStatus: "read", delivered: 0, read: 1, failed: 0, apply: true }
      : { nextStatus: current, delivered: 0, read: 0, failed: 0, apply: false };
  }
  if (incoming === "read") return { nextStatus: "read", delivered: 1, read: 1, failed: 0, apply: true };
  if (incoming === "delivered") return { nextStatus: "delivered", delivered: 1, read: 0, failed: 0, apply: true };
  if (incoming === "failed") return { nextStatus: "failed", delivered: 0, read: 0, failed: 1, apply: true };
  return { nextStatus: current, delivered: 0, read: 0, failed: 0, apply: false };
}

export async function processWhatsAppStatus(event: WhatsAppStatus): Promise<"applied" | "duplicate" | "unmatched" | "ignored"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whatsapp:${event.messageId}`}))`);
    const [message] = await tx.select({
      id: providerMessagesTable.id,
      organizationId: providerMessagesTable.organizationId,
      campaignJobId: providerMessagesTable.campaignJobId,
      status: providerMessagesTable.status,
      lastStatusAt: providerMessagesTable.lastStatusAt,
      campaignId: campaignJobsTable.campaignId,
    }).from(providerMessagesTable).innerJoin(campaignJobsTable, and(
      eq(campaignJobsTable.id, providerMessagesTable.campaignJobId),
      eq(campaignJobsTable.organizationId, providerMessagesTable.organizationId),
    )).where(and(
      eq(providerMessagesTable.provider, "whatsapp-business"),
      eq(providerMessagesTable.providerMessageId, event.messageId),
    ));
    if (!message) return "unmatched";
    const [inserted] = await tx.insert(providerEventsTable).values({
      organizationId: message.organizationId,
      providerMessageDbId: message.id,
      campaignJobId: message.campaignJobId,
      provider: "whatsapp-business",
      providerEventId: event.eventId,
      providerMessageId: event.messageId,
      eventType: event.status,
      occurredAt: event.occurredAt,
      errorCode: event.errorCode,
      errorReason: event.errorReason,
      payload: { status: event.status },
    }).onConflictDoNothing().returning({ id: providerEventsTable.id });
    if (!inserted) return "duplicate";
    const delta = statusTransition(message.status, event.status);
    if (!delta.apply || (message.lastStatusAt && event.occurredAt < message.lastStatusAt)) return "ignored";
    // The authoritative reason for a webhook-reported failure lands on the
    // provider_events row (errorReason, above) regardless of what happens
    // next -- but route-health analytics (and any other reader of
    // provider_messages directly) only ever sees provider_messages.errorReason.
    // Without backfilling it here, any failure that WhatsApp reports *after*
    // the message was already accepted (the common case) permanently reads
    // as "Unknown error" even though the real reason is sitting in the DB.
    const reason = event.errorReason ?? event.errorCode ?? "Provider delivery failed";
    await tx.update(providerMessagesTable).set({
      status: delta.nextStatus,
      lastStatusAt: event.occurredAt,
      ...(delta.failed ? { errorReason: reason } : {}),
    }).where(eq(providerMessagesTable.id, message.id));
    const [metrics] = await tx.select({ errorReasons: campaignMetricsTable.errorReasons })
      .from(campaignMetricsTable).where(eq(campaignMetricsTable.campaignId, message.campaignId));
    const errorReasons = { ...(metrics?.errorReasons ?? {}) };
    if (delta.failed) errorReasons[reason] = (errorReasons[reason] ?? 0) + 1;
    await tx.update(campaignMetricsTable).set({
      delivered: sql`${campaignMetricsTable.delivered} + ${delta.delivered}`,
      read: sql`${campaignMetricsTable.read} + ${delta.read}`,
      failed: sql`${campaignMetricsTable.failed} + ${delta.failed}`,
      ...(delta.failed ? { errorReasons } : {}),
    }).where(eq(campaignMetricsTable.campaignId, message.campaignId));
    await tx.update(campaignsTable).set({
      delivered: sql`${campaignsTable.delivered} + ${delta.delivered}`,
      read: sql`${campaignsTable.read} + ${delta.read}`,
      failed: sql`${campaignsTable.failed} + ${delta.failed}`,
    }).where(and(
      eq(campaignsTable.id, message.campaignId),
      eq(campaignsTable.organizationId, message.organizationId),
    ));
    return "applied";
  });
}