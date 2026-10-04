import { and, eq } from "drizzle-orm";
import {
  campaignAuditTable,
  campaignMessageSetupsTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  campaignTemplateSelectionsTable,
  db,
  suppressionsTable,
  templatesTable,
} from "@workspace/db";
import { normalizePhone } from "./contact-processing";
import { loadCampaignMediaAssets } from "./campaign-media-assets";
import { ensureMediaBinding } from "./campaign-media-binding";
import { describeTemplate } from "./template-mapping";
import { decidePair, loadCompatibilityState } from "./template-eligibility";
import { resolveTemplateParameters } from "./template-resolution";
import { buildMetaTemplatePayload } from "./whatsapp-template-sender";
import { sendDirectWhatsAppMessage, type DirectFetch } from "./whatsapp-direct-sender";
import { providerClient, ProviderRequestError, type WhatsAppProviderClient } from "./whatsapp-provider";
import { resolveSendingCredential, SendingCredentialUnavailableError } from "./whatsapp-transport-credentials";
import { loadPreviewContact, templateVerdict } from "./message-studio";
import { MessageStudioError } from "./message-studio-errors";
import { logger } from "../lib/logger";

// V2-05B isolated test send. NOT campaign execution: no campaign_jobs row,
// no allocation, no provider_messages row, no metric, no status or plan
// change. It runs the same checks the send path enforces -- ownership,
// number state and credential, the V2-04 pair decision, a provider-backed
// sendable template, resolved mappings, media kind -- and every one of them
// fails BEFORE any provider request. The payload comes from the real
// resolver (resolveTemplateParameters) and the real builder
// (buildMetaTemplatePayload). The outcome is recorded as one campaign audit
// row (`test_send_requested`) with ids and a classification only.

export type TestSendInput = {
  organizationId: number;
  campaignId: number;
  actorUserId?: number;
  phoneNumberId: number;
  templateId: number;
  contactId?: number;
  recipientPhone?: string;
};

export type TestSendResult = { result: "sent" | "failed" | "unknown"; code: string | null; message: string; providerMessageId: string | null };

type Seams = { directFetch?: DirectFetch; connectorClient?: WhatsAppProviderClient; timeoutMs?: number };
let seams: Seams = {};
/** Tests only: fake provider transports (no live send is ever made by tests). */
export function setTestSendSeamsForTests(next: Seams): void {
  seams = next;
}

async function audit(input: TestSendInput, status: string, metadata: Record<string, unknown>) {
  await db.insert(campaignAuditTable).values({
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    actorUserId: input.actorUserId,
    action: "test_send_requested",
    fromStatus: status,
    toStatus: status,
    metadata: { senderPhoneNumberId: input.phoneNumberId, templateId: input.templateId, recipient: input.contactId !== undefined ? "contact" : "explicit", ...metadata },
  });
}

export async function testSendMessage(input: TestSendInput): Promise<TestSendResult> {
  const [campaign] = await db.select({ id: campaignsTable.id, status: campaignsTable.status }).from(campaignsTable)
    .where(and(eq(campaignsTable.id, input.campaignId), eq(campaignsTable.organizationId, input.organizationId)));
  if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);
  const refuse = async (error: MessageStudioError): Promise<never> => {
    await audit(input, campaign.status, { result: "refused", code: error.code });
    throw error;
  };

  // 1. Both the number and the template must be part of this campaign's saved message setup.
  const [setup] = await db.select({ senders: campaignMessageSetupsTable.senderPhoneNumberIds }).from(campaignMessageSetupsTable).where(and(
    eq(campaignMessageSetupsTable.campaignId, input.campaignId), eq(campaignMessageSetupsTable.organizationId, input.organizationId),
  ));
  const [selected] = await db.select({ id: campaignTemplateSelectionsTable.id }).from(campaignTemplateSelectionsTable).where(and(
    eq(campaignTemplateSelectionsTable.organizationId, input.organizationId),
    eq(campaignTemplateSelectionsTable.campaignId, input.campaignId),
    eq(campaignTemplateSelectionsTable.templateId, input.templateId),
  ));
  if (!setup?.senders.includes(input.phoneNumberId) || !selected) {
    return refuse(new MessageStudioError("not_selected", "Save this number and template in the message setup before sending a test.", 409));
  }

  // 2. Number, credential and the V2-04 pair decision (tenant-scoped state).
  const state = await loadCompatibilityState(input.organizationId, { phoneIds: [input.phoneNumberId], templateIds: [input.templateId] });
  const phone = state.phones.get(input.phoneNumberId);
  const [templateRow] = await db.select({
    id: templatesTable.id, name: templatesTable.name, language: templatesTable.language, body: templatesTable.body, components: templatesTable.components,
    status: templatesTable.status, providerTemplateId: templatesTable.providerTemplateId, isSample: templatesTable.isSample, metadata: templatesTable.metadata,
  }).from(templatesTable).where(and(eq(templatesTable.id, input.templateId), eq(templatesTable.organizationId, input.organizationId)));
  if (!phone || !templateRow) return refuse(new MessageStudioError("not_found", "Number or template not found in this workspace", 404));
  const verdict = templateVerdict(templateRow);
  if (!verdict.usable) return refuse(new MessageStudioError("template_unusable", `${templateRow.name}: ${verdict.message}`, 409));
  const decision = decidePair(state, input.phoneNumberId, input.templateId);
  if (!decision.eligible || !decision.transport) {
    return refuse(new MessageStudioError(decision.code === "credential_inactive" ? "credential_inactive" : "incompatible", `${phone.phone} cannot send ${templateRow.name}: ${decision.message}`, 409));
  }
  const transport = decision.transport;
  let accessToken: string | null = null;
  if (transport === "workspace_credential") {
    try {
      accessToken = (await resolveSendingCredential(input.organizationId, phone.sendingCredentialId!)).accessToken;
    } catch (error) {
      if (error instanceof SendingCredentialUnavailableError) return refuse(new MessageStudioError("credential_inactive", "The number's workspace sending credential is not active.", 409));
      throw error;
    }
  }

  // 3. Recipient: an audience contact or an explicit international number; opted-out numbers are never messaged.
  let recipient: string;
  const contact = await loadPreviewContact(input.organizationId, input.campaignId, input.contactId).catch(async (error) => {
    if (error instanceof MessageStudioError) return refuse(error);
    throw error;
  });
  if (input.recipientPhone !== undefined) {
    const normalized = normalizePhone(input.recipientPhone);
    if (!normalized.value) return refuse(new MessageStudioError("recipient_invalid", "Enter the test number with + and its country code.", 400));
    recipient = normalized.value;
  } else {
    if (!contact?.normalizedPhone || (input.contactId !== undefined && contact.status !== "Valid")) {
      return refuse(new MessageStudioError("recipient_invalid", "Choose a ready audience contact or enter a test number.", 400));
    }
    recipient = contact.normalizedPhone;
  }
  const [suppressed] = await db.select({ id: suppressionsTable.id }).from(suppressionsTable).where(and(
    eq(suppressionsTable.organizationId, input.organizationId), eq(suppressionsTable.normalizedPhone, recipient),
  ));
  if (suppressed) return refuse(new MessageStudioError("recipient_suppressed", "This number has opted out and cannot be messaged.", 409));

  // 4. Mappings (saved state, the same resolver as send preparation).
  const mappingRows = await db.select().from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, input.organizationId),
    eq(campaignTemplateMappingsTable.campaignId, input.campaignId),
    eq(campaignTemplateMappingsTable.templateId, input.templateId),
  ));
  const { resolved, unresolved } = resolveTemplateParameters(templateRow, mappingRows, contact?.data ?? {});
  if (unresolved.length) {
    return refuse(new MessageStudioError("mapping_unresolved", "Some template variables have no value for this recipient.", 400, unresolved.map((issue) => `${issue.key}: ${issue.reason}`)));
  }

  // 5. Media: the asset must be this campaign's, ready and of the header's kind.
  if (resolved.headerMedia) {
    const assetId = Number(resolved.headerMedia.assetId);
    const asset = (await loadCampaignMediaAssets(input.organizationId, input.campaignId, [assetId])).get(assetId);
    const kind = describeTemplate(templateRow).headerKind;
    if (!asset || asset.status !== "ready") return refuse(new MessageStudioError("media_unavailable", "The header file is no longer available.", 409));
    if (asset.kind !== kind) return refuse(new MessageStudioError("media_kind_mismatch", `${asset.fileName} is a ${asset.kind}, but this template needs a ${kind} header.`, 409));
    if (transport === "legacy_connector") {
      return refuse(new MessageStudioError("media_unsupported_transport", "Campaign media files need a number connected with its own workspace credential.", 409));
    }
    // Management-plane media preparation (the media endpoint, not a send).
    try {
      resolved.headerMedia.id = await ensureMediaBinding({ organizationId: input.organizationId, asset, phone, transport });
    } catch (error) {
      if (error instanceof MessageStudioError) return refuse(error);
      throw error;
    }
  }

  const payload = buildMetaTemplatePayload(recipient, templateRow.name, templateRow.language, resolved, templateRow.components);

  // 6. The one provider request.
  const signal = AbortSignal.timeout(seams.timeoutMs ?? 15_000);
  try {
    let providerMessageId: string;
    if (transport === "workspace_credential") {
      providerMessageId = await sendDirectWhatsAppMessage({ accessToken: accessToken!, providerPhoneId: phone.providerPhoneId!, payload, signal, fetchImpl: seams.directFetch });
    } else if (transport === "legacy_connector") {
      providerMessageId = await (seams.connectorClient ?? providerClient("real")).send(phone.providerPhoneId!, payload, signal);
    } else {
      providerMessageId = await providerClient("mock").send(phone.providerPhoneId ?? `mock-phone-${phone.id}`, payload);
    }
    await audit(input, campaign.status, { result: "sent", transport });
    return { result: "sent", code: null, message: `Test message accepted by WhatsApp for ${recipient}.`, providerMessageId };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      // The request may have reached Meta: report it as unknown, never retry.
      await audit(input, campaign.status, { result: "unknown", transport });
      return { result: "unknown", code: "delivery_unknown", message: "WhatsApp did not answer in time; the test message may or may not have been sent. It is not retried automatically.", providerMessageId: null };
    }
    if (error instanceof ProviderRequestError) {
      logger.info({ organizationId: input.organizationId, campaignId: input.campaignId, providerCode: error.code }, "test send rejected by provider");
      const code = error.code === "190" ? "credential_inactive" : error.retryable ? "provider_unavailable" : "provider_rejected";
      await audit(input, campaign.status, { result: "failed", transport, providerCode: error.code ?? null });
      return { result: "failed", code, message: `WhatsApp did not accept the test message: ${error.message}`, providerMessageId: null };
    }
    throw error;
  }
}

