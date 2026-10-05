import { and, asc, eq } from "drizzle-orm";
import { campaignRoutesTable, db, phoneNumbersTable } from "@workspace/db";
import { ALLOCATOR_V1, ALLOCATOR_V2 } from "./allocator-version";
import { AllocatorInputError, createAllocatorV2, type DistributionMode } from "./campaign-allocator-v2";
import { isDeliveryMode, resolveCampaignDelivery } from "./campaign-delivery";
import { allocatorInputFromFrozen, type FrozenRoute } from "./campaign-planning";
import { loadReadinessContext } from "./campaign-preflight";
import { getCampaignPreflight } from "./campaign-preflight-report";
import { assignRoute, partitionFor } from "./contact-processing";
import { loadPreviewContact, previewMessage } from "./message-studio";
import { MessageStudioError } from "./message-studio-errors";
import { decidePair } from "./template-eligibility";

// V2-06C Review & Launch read models. Both are READS: no plan, allocation,
// job, route change, provider media binding or provider request.
//
// - The projection is a cheap, clearly approximate "what will be sent"
//   computed from the active valid-recipient count, the distribution mode,
//   the sender lanes, the V2-04 compatibility matrix and the resolved
//   speeds; it never scans recipients. Launch's frozen plan is the exact
//   allocation (plan summary).
// - The recipient preview decides ONE audience recipient with the same
//   inputs and functions Planning uses (lanes in route-id order, the shared
//   delivery resolver's rates, decidePair, allocatorInputFromFrozen +
//   createAllocatorV2; v1: partitionFor -> assignRoute -> route template)
//   and resolves its message with the same resolver as Message Studio /
//   send preparation. For an unchanged configuration it equals the frozen
//   allocation Launch will write (tested).

export async function getLaunchProjection(organizationId: number, campaignId: number) {
  const report = await getCampaignPreflight(organizationId, campaignId);
  const recipients = report.recipients.valid;
  const mode = report.distribution.mode as DistributionMode | null;
  const lanes = report.senders.filter((sender) => sender.usable && sender.eligibleTemplateIds.length > 0);
  const templateName = new Map(report.templates.map((template) => [template.templateId, template.name]));
  const base = { approximate: true as const, distributionMode: mode, recipients, senders: [] as Array<unknown>, templates: [] as Array<unknown> };
  if (!mode || !lanes.length || (mode === "equal_templates" && lanes.some((lane) => lane.plannedRate === null))) {
    return { ...base, available: false, reason: !mode ? "Choose a distribution to see how recipients are shared." : "Fix the items that need attention to see how recipients are shared." };
  }
  // Pair shares (sender, template) -> fraction of all recipients.
  const pairShare = new Map<string, number>();
  const add = (phoneNumberId: number, templateId: number, share: number) => pairShare.set(`${phoneNumberId}:${templateId}`, (pairShare.get(`${phoneNumberId}:${templateId}`) ?? 0) + share);
  if (mode === "equal_numbers") {
    for (const lane of lanes) for (const templateId of lane.eligibleTemplateIds) add(lane.phoneNumberId, templateId, 1 / lanes.length / lane.eligibleTemplateIds.length);
  } else {
    const templateIds = [...new Set(lanes.flatMap((lane) => lane.eligibleTemplateIds))].sort((a, b) => a - b);
    for (const templateId of templateIds) {
      const eligible = lanes.filter((lane) => lane.eligibleTemplateIds.includes(templateId));
      const total = eligible.reduce((sum, lane) => sum + lane.plannedRate!, 0);
      for (const lane of eligible) add(lane.phoneNumberId, templateId, (1 / templateIds.length) * (lane.plannedRate! / total));
    }
  }
  const approx = (share: number) => Math.round(recipients * share);
  const senders = lanes.map((lane) => {
    const templates = lane.eligibleTemplateIds.map((templateId) => ({ templateId, name: templateName.get(templateId) ?? "", approxShare: pairShare.get(`${lane.phoneNumberId}:${templateId}`) ?? 0 }));
    const share = templates.reduce((sum, template) => sum + template.approxShare, 0);
    return {
      phoneNumberId: lane.phoneNumberId, phone: lane.phone, displayName: lane.displayName, plannedRate: lane.plannedRate,
      approxShare: share, approxRecipients: approx(share),
      templates: templates.map((template) => ({ ...template, approxRecipients: approx(template.approxShare) })),
    };
  });
  const templateTotals = new Map<number, number>();
  for (const [key, share] of pairShare) {
    const templateId = Number(key.split(":")[1]);
    templateTotals.set(templateId, (templateTotals.get(templateId) ?? 0) + share);
  }
  const templates = [...templateTotals.entries()].sort(([a], [b]) => a - b).map(([templateId, share]) => ({
    templateId, name: templateName.get(templateId) ?? "", approxShare: share, approxRecipients: approx(share),
  }));
  return { ...base, available: true, reason: null, senders, templates };
}

/** The live allocation decision for one recipient, exactly as Planning would make it now. */
async function liveDecision(organizationId: number, campaignId: number, normalizedPhone: string) {
  const readiness = await loadReadinessContext(organizationId, campaignId);
  const routes = await db.select({ id: campaignRoutesTable.id, phoneNumberId: campaignRoutesTable.phoneNumberId, templateId: campaignRoutesTable.templateId, configuredTps: campaignRoutesTable.configuredTps })
    .from(campaignRoutesTable).innerJoin(phoneNumbersTable, and(eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId), eq(phoneNumbersTable.organizationId, organizationId)))
    .where(and(eq(campaignRoutesTable.organizationId, organizationId), eq(campaignRoutesTable.campaignId, campaignId)))
    .orderBy(asc(campaignRoutesTable.id));
  const unavailable = (reason: string) => new MessageStudioError("preview_unavailable", reason, 409);
  if (readiness.distributionMode === null) {
    // Allocator v1 (legacy campaigns): partition -> route -> route template.
    const usable = routes.filter((route) => route.templateId !== null);
    if (!usable.length) throw unavailable("There is no sending route to preview yet.");
    const routeIds = usable.map((route) => route.id);
    const routeId = assignRoute(partitionFor(normalizedPhone, Math.max(routeIds.length, 64)), routeIds)!;
    const route = usable.find((candidate) => candidate.id === routeId)!;
    return { allocatorVersion: ALLOCATOR_V1, routeId, phoneNumberId: route.phoneNumberId, templateId: route.templateId! };
  }
  let rates = new Map(routes.map((route) => [route.phoneNumberId, route.configuredTps]));
  if (readiness.deliveryMode !== null) {
    if (!isDeliveryMode(readiness.deliveryMode)) throw unavailable("The saved speed is not supported.");
    const resolution = resolveCampaignDelivery(readiness.state, [...new Set(routes.map((route) => route.phoneNumberId))], readiness.deliveryMode, readiness.deliverySettings);
    if (resolution.problems.length) throw unavailable("Fix the speed settings to preview who sends to this recipient.");
    rates = new Map(resolution.perSender.map((entry) => [entry.phoneNumberId, entry.plannedRate!]));
  }
  const selected = readiness.selectedTemplateIds.slice().sort((a, b) => a - b);
  const lanes = routes.map((route) => ({
    routeId: route.id,
    phoneNumberId: route.phoneNumberId,
    configuredTps: rates.get(route.phoneNumberId) ?? route.configuredTps,
    eligibleTemplateIds: selected.filter((templateId) => decidePair(readiness.state, route.phoneNumberId, templateId).eligible),
  })) as FrozenRoute[];
  try {
    const decision = createAllocatorV2(allocatorInputFromFrozen(readiness.distributionMode as DistributionMode, lanes, readiness.selectedTemplateIds)).allocate(normalizedPhone);
    return { allocatorVersion: ALLOCATOR_V2, ...decision };
  } catch (error) {
    if (error instanceof AllocatorInputError) throw unavailable("Fix the items that need attention to preview who sends to this recipient.");
    throw error;
  }
}

export async function previewLaunchRecipient(organizationId: number, campaignId: number, contactId?: number) {
  const contact = await loadPreviewContact(organizationId, campaignId, contactId);
  if (!contact) throw new MessageStudioError("not_found", "The audience has no valid recipient to preview", 404);
  if (contact.status !== "Valid" || !contact.normalizedPhone) {
    return { contactId: contact.id, normalizedPhone: contact.normalizedPhone, willSend: false, reason: `This recipient will not be sent to (${contact.status.toLowerCase()}).`, decision: null, message: null };
  }
  const decision = await liveDecision(organizationId, campaignId, contact.normalizedPhone);
  const readiness = await loadReadinessContext(organizationId, campaignId);
  const phone = readiness.state.phones.get(decision.phoneNumberId);
  const template = readiness.state.templates.get(decision.templateId);
  const message = await previewMessage({ organizationId, campaignId, templateId: decision.templateId, contactId: contact.id });
  return {
    contactId: contact.id,
    normalizedPhone: contact.normalizedPhone,
    willSend: true,
    reason: null,
    decision: {
      allocatorVersion: decision.allocatorVersion,
      routeId: decision.routeId,
      sender: { phoneNumberId: decision.phoneNumberId, phone: phone?.phone ?? "", displayName: phone?.displayName ?? "" },
      template: { templateId: decision.templateId, name: template?.name ?? "", language: template?.language ?? "" },
    },
    message: { resolved: message.resolved, headerMedia: message.headerMedia, unresolved: message.unresolved },
  };
}
