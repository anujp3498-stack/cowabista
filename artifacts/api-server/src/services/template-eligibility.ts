import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  phoneNumbersTable,
  providerConnectionsTable,
  templateEligibilityTable,
  templatesTable,
  wabasTable,
  type TemplateEligibilitySource,
} from "@workspace/db";
import { loadSendingCredentialStates, type SendingCredentialState } from "./whatsapp-transport-credentials";

// V2-04 sender-template compatibility: ONE tenant-scoped decision, reused by
// route create/update, Rocket setup, readiness/preflight, planning, the
// compatibility endpoints and send preparation.
//
// Four separate questions, answered in order:
//   A. identity   the template row is the exact provider template of its
//                 WABA; a phone belongs to a WABA (never inferred by name).
//   B. transport  which path would send: a workspace credential, the legacy
//                 shared connector in real mode, or the explicit local/mock
//                 context (legacy connector in mock mode, no credential).
//   C. state      provider evidence (template_eligibility, written only by an
//                 applied sync or the backfill) + LIVE phone, WABA and
//                 credential state. Cached evidence never outranks live
//                 state: a revoked credential, a disconnected phone or a
//                 template the templates row now shows Paused/Removed is
//                 ineligible whatever the evidence row says.
//   D. campaign   selection/mapping/TPS rules stay in campaign-preflight.
//
// The local/mock exception is explicit and isolated: it applies only when
// the organization's provider connection is in mock mode AND the phone has
// no sending credential. It allows local (non-provider) templates and
// unbound test numbers to pair when their WABA references agree (both
// null counts as agreeing ONLY here). It can never authorise a workspace
// credential or a real connector send, because those transports are
// decided before this branch is reached.

export type TransportKind = "workspace_credential" | "legacy_connector" | "local_mock";

export type EligibilityReasonCode =
  | "eligible"
  | "eligible_local_mock"
  | "not_found"
  | "phone_sample"
  | "phone_not_connected"
  | "phone_no_provider_identity"
  | "phone_no_waba"
  | "credential_inactive"
  | "credential_unbound"
  | "legacy_waba_not_claimed"
  | "template_sample"
  | "template_not_provider_backed"
  | "template_not_approved"
  | "template_removed"
  | "evidence_missing"
  | "evidence_not_sendable"
  | "waba_mismatch";

export type PhoneState = {
  id: number; organizationId: number; wabaId: number | null; status: string; providerPhoneId: string | null;
  sendingCredentialId: number | null; isSample: boolean; phone: string; displayName: string; tpsLimit: number;
};
export type TemplateState = {
  id: number; organizationId: number; wabaId: number | null; status: string; providerTemplateId: string | null;
  isSample: boolean; providerMissing: boolean; name: string; language: string;
};
export type WabaState = { id: number; organizationId: number; externalId: string; credentialId: number | null };
export type EvidenceState = { templateId: number; wabaId: number; sendable: boolean; status: string; providerMissing: boolean; verifiedAt: Date; evidenceSource: TemplateEligibilitySource };
export type ConnectionState = { mode: string; claimedWabaId: number | null };

export type CompatibilityState = {
  organizationId: number;
  phones: Map<number, PhoneState>;
  templates: Map<number, TemplateState>;
  wabas: Map<number, WabaState>;
  credentials: Map<number, SendingCredentialState>;
  evidence: Map<number, EvidenceState>;
  connection: ConnectionState;
};

export type Evidence = { source: TemplateEligibilitySource | "local_mock"; verifiedAt: Date | null };

export type PairDecision = {
  eligible: boolean;
  code: EligibilityReasonCode;
  message: string;
  transport: TransportKind | null;
  evidence: Evidence | null;
};

const MESSAGES: Record<EligibilityReasonCode, string> = {
  eligible: "Can send",
  eligible_local_mock: "Can send (local test context: mock provider, no workspace credential)",
  not_found: "Not found in this workspace",
  phone_sample: "Sample numbers cannot send",
  phone_not_connected: "The number is not connected for sending",
  phone_no_provider_identity: "The number has no provider phone id",
  phone_no_waba: "The number is not attached to a WhatsApp Business Account",
  credential_inactive: "The number's workspace sending credential is not active",
  credential_unbound: "The number's WhatsApp Business Account is not associated with its sending credential",
  legacy_waba_not_claimed: "The number or template is not on the WhatsApp Business Account claimed by this workspace",
  template_sample: "Sample templates cannot be sent",
  template_not_provider_backed: "The template is a local draft, not a template approved at Meta",
  template_not_approved: "The template is not approved at Meta",
  template_removed: "Meta no longer lists this template",
  evidence_missing: "The template has not been verified by a synchronisation yet",
  evidence_not_sendable: "The last synchronisation did not find this template approved",
  waba_mismatch: "The number and the template belong to different WhatsApp Business Accounts",
};

export function reasonMessage(code: EligibilityReasonCode): string {
  return MESSAGES[code];
}

/** B. Which transport a phone would send through (never a token). */
export function transportFor(phone: PhoneState, connection: ConnectionState): TransportKind {
  if (phone.sendingCredentialId !== null) return "workspace_credential";
  return connection.mode === "real" ? "legacy_connector" : "local_mock";
}

type PhoneVerdict = { ok: true; transport: TransportKind } | { ok: false; code: EligibilityReasonCode };

function checkPhone(state: CompatibilityState, phone: PhoneState | undefined): PhoneVerdict {
  if (!phone || phone.organizationId !== state.organizationId) return { ok: false, code: "not_found" };
  if (phone.isSample) return { ok: false, code: "phone_sample" };
  if (phone.status !== "Connected") return { ok: false, code: "phone_not_connected" };
  const transport = transportFor(phone, state.connection);
  if (transport === "local_mock") return { ok: true, transport };
  if (!phone.providerPhoneId) return { ok: false, code: "phone_no_provider_identity" };
  if (phone.wabaId === null) return { ok: false, code: "phone_no_waba" };
  const waba = state.wabas.get(phone.wabaId);
  if (!waba || waba.organizationId !== state.organizationId) return { ok: false, code: "phone_no_waba" };
  if (transport === "workspace_credential") {
    const credential = state.credentials.get(phone.sendingCredentialId!);
    if (!credential || !credential.active || credential.organizationId !== state.organizationId) return { ok: false, code: "credential_inactive" };
    if (waba.credentialId !== phone.sendingCredentialId) return { ok: false, code: "credential_unbound" };
    return { ok: true, transport };
  }
  if (state.connection.claimedWabaId === null || phone.wabaId !== state.connection.claimedWabaId) return { ok: false, code: "legacy_waba_not_claimed" };
  return { ok: true, transport };
}

type TemplateVerdict = { ok: true; evidence: Evidence } | { ok: false; code: EligibilityReasonCode };

function checkTemplate(state: CompatibilityState, template: TemplateState | undefined, transport: TransportKind): TemplateVerdict {
  if (!template || template.organizationId !== state.organizationId) return { ok: false, code: "not_found" };
  if (template.isSample) return { ok: false, code: "template_sample" };
  if (template.providerMissing || template.status === "Removed") return { ok: false, code: "template_removed" };
  if (template.status !== "Approved") return { ok: false, code: "template_not_approved" };
  if (transport === "local_mock") {
    const row = state.evidence.get(template.id);
    if (row && !row.sendable) return { ok: false, code: "evidence_not_sendable" };
    return { ok: true, evidence: row ? { source: row.evidenceSource, verifiedAt: row.verifiedAt } : { source: "local_mock", verifiedAt: null } };
  }
  if (!template.providerTemplateId) return { ok: false, code: "template_not_provider_backed" };
  if (template.wabaId === null) return { ok: false, code: "waba_mismatch" };
  const row = state.evidence.get(template.id);
  if (!row) return { ok: false, code: "evidence_missing" };
  if (!row.sendable || row.providerMissing || row.wabaId !== template.wabaId) return { ok: false, code: "evidence_not_sendable" };
  return { ok: true, evidence: { source: row.evidenceSource, verifiedAt: row.verifiedAt } };
}

/** The shared pair decision. Pure: works on already-loaded state, no I/O. */
export function decidePair(state: CompatibilityState, phoneId: number, templateId: number): PairDecision {
  const phone = state.phones.get(phoneId);
  const phoneVerdict = checkPhone(state, phone);
  if (!phoneVerdict.ok) return { eligible: false, code: phoneVerdict.code, message: MESSAGES[phoneVerdict.code], transport: null, evidence: null };
  const transport = phoneVerdict.transport;
  const template = state.templates.get(templateId);
  const templateVerdict = checkTemplate(state, template, transport);
  if (!templateVerdict.ok) return { eligible: false, code: templateVerdict.code, message: MESSAGES[templateVerdict.code], transport, evidence: null };
  // A. identity: same WABA, by internal id, never by name.
  if (transport === "legacy_connector") {
    if (template!.wabaId !== state.connection.claimedWabaId) return { eligible: false, code: "legacy_waba_not_claimed", message: MESSAGES.legacy_waba_not_claimed, transport, evidence: null };
  } else if (template!.wabaId !== phone!.wabaId) {
    return { eligible: false, code: "waba_mismatch", message: MESSAGES.waba_mismatch, transport, evidence: null };
  }
  const code: EligibilityReasonCode = transport === "local_mock" ? "eligible_local_mock" : "eligible";
  return { eligible: true, code, message: MESSAGES[code], transport, evidence: templateVerdict.evidence };
}

/** Phone-only verdict (for "number has no eligible template" explanations). */
export function describePhone(state: CompatibilityState, phoneId: number): { ok: boolean; code: EligibilityReasonCode; transport: TransportKind | null } {
  const verdict = checkPhone(state, state.phones.get(phoneId));
  return verdict.ok ? { ok: true, code: "eligible", transport: verdict.transport } : { ok: false, code: verdict.code, transport: null };
}

function templateStateFrom(row: { id: number; organizationId: number; wabaId: number | null; status: string; providerTemplateId: string | null; isSample: boolean; metadata: Record<string, unknown> | null; name: string; language: string }): TemplateState {
  return {
    id: row.id, organizationId: row.organizationId, wabaId: row.wabaId, status: row.status, providerTemplateId: row.providerTemplateId,
    isSample: row.isSample, providerMissing: row.metadata?.providerMissing === true, name: row.name, language: row.language,
  };
}

/** Read-only provider connection mode (never creates the row; absent = mock, the same default creation uses). */
export async function loadConnectionState(organizationId: number): Promise<ConnectionState> {
  const [connection] = await db.select({ mode: providerConnectionsTable.mode, configuredWabaExternalId: providerConnectionsTable.configuredWabaExternalId })
    .from(providerConnectionsTable).where(and(eq(providerConnectionsTable.organizationId, organizationId), eq(providerConnectionsTable.provider, "whatsapp-business")));
  if (!connection) return { mode: "mock", claimedWabaId: null };
  let claimedWabaId: number | null = null;
  if (connection.configuredWabaExternalId) {
    const [claimed] = await db.select({ id: wabasTable.id }).from(wabasTable)
      .where(and(eq(wabasTable.organizationId, organizationId), eq(wabasTable.externalId, connection.configuredWabaExternalId)));
    claimedWabaId = claimed?.id ?? null;
  }
  return { mode: connection.mode, claimedWabaId };
}

/**
 * Batched loader: a handful of set queries for any number of phones and
 * templates, every one scoped by the organization. Ids from another tenant
 * simply do not come back (and decide as not_found).
 */
export async function loadCompatibilityState(organizationId: number, input: { phoneIds: number[]; templateIds: number[] }): Promise<CompatibilityState> {
  const phoneIds = [...new Set(input.phoneIds)];
  const templateIds = [...new Set(input.templateIds)];
  const [phones, templates, connection] = await Promise.all([
    phoneIds.length ? db.select({
      id: phoneNumbersTable.id, organizationId: phoneNumbersTable.organizationId, wabaId: phoneNumbersTable.wabaId, status: phoneNumbersTable.status,
      providerPhoneId: phoneNumbersTable.providerPhoneId, sendingCredentialId: phoneNumbersTable.sendingCredentialId, isSample: phoneNumbersTable.isSample,
      phone: phoneNumbersTable.phone, displayName: phoneNumbersTable.displayName, tpsLimit: phoneNumbersTable.tpsLimit,
    }).from(phoneNumbersTable).where(and(eq(phoneNumbersTable.organizationId, organizationId), inArray(phoneNumbersTable.id, phoneIds))) : Promise.resolve([]),
    templateIds.length ? db.select({
      id: templatesTable.id, organizationId: templatesTable.organizationId, wabaId: templatesTable.wabaId, status: templatesTable.status,
      providerTemplateId: templatesTable.providerTemplateId, isSample: templatesTable.isSample, metadata: templatesTable.metadata, name: templatesTable.name, language: templatesTable.language,
    }).from(templatesTable).where(and(eq(templatesTable.organizationId, organizationId), inArray(templatesTable.id, templateIds))) : Promise.resolve([]),
    loadConnectionState(organizationId),
  ]);
  const wabaIds = [...new Set([...phones, ...templates].flatMap((row) => (row.wabaId === null ? [] : [row.wabaId])))];
  const [wabas, credentials, evidence] = await Promise.all([
    wabaIds.length ? db.select({ id: wabasTable.id, organizationId: wabasTable.organizationId, externalId: wabasTable.externalId, credentialId: wabasTable.credentialId })
      .from(wabasTable).where(and(eq(wabasTable.organizationId, organizationId), inArray(wabasTable.id, wabaIds))) : Promise.resolve([]),
    loadSendingCredentialStates(phones.flatMap((phone) => (phone.sendingCredentialId === null ? [] : [phone.sendingCredentialId]))),
    templates.length ? db.select({
      templateId: templateEligibilityTable.templateId, wabaId: templateEligibilityTable.wabaId, sendable: templateEligibilityTable.sendable, status: templateEligibilityTable.status,
      providerMissing: templateEligibilityTable.providerMissing, verifiedAt: templateEligibilityTable.verifiedAt, evidenceSource: templateEligibilityTable.evidenceSource,
    }).from(templateEligibilityTable).where(and(eq(templateEligibilityTable.organizationId, organizationId), inArray(templateEligibilityTable.templateId, templates.map((t) => t.id)))) : Promise.resolve([]),
  ]);
  return {
    organizationId,
    phones: new Map(phones.map((phone) => [phone.id, phone])),
    templates: new Map(templates.map((row) => [row.id, templateStateFrom(row)])),
    wabas: new Map(wabas.map((waba) => [waba.id, waba])),
    credentials,
    evidence: new Map(evidence.map((row) => [row.templateId, { ...row, evidenceSource: row.evidenceSource as TemplateEligibilitySource }])),
    connection,
  };
}

export const COMPATIBILITY_MAX_IDS = 50;
export const COMPATIBILITY_MAX_DERIVED = 200;

export type CompatibilityMatrix = {
  evaluatedAt: Date;
  numbers: Array<{ phoneNumberId: number; phone: string; displayName: string; wabaId: number | null; wabaExternalId: string | null; transport: TransportKind | null; eligibleTemplateIds: number[]; code: EligibilityReasonCode }>;
  templates: Array<{ templateId: number; name: string; language: string; wabaId: number | null; wabaExternalId: string | null; eligiblePhoneNumberIds: number[]; evidence: Evidence | null; code: EligibilityReasonCode }>;
  incompatiblePairs: Array<{ phoneNumberId: number; templateId: number; code: EligibilityReasonCode; message: string }>;
  numbersWithoutTemplate: number[];
  templatesWithoutNumber: number[];
};

export class CompatibilityInputError extends Error {}

/**
 * Bounded matrix for selected numbers and templates. When one side is
 * omitted it is derived from the other side's WABAs (bounded), so Number
 * Center can ask "what can this number send" and Template Center "who can
 * send this template" without a workspace-wide Cartesian product. Never
 * calls the provider.
 */
export async function buildCompatibilityMatrix(organizationId: number, input: { phoneIds?: number[]; templateIds?: number[] }): Promise<CompatibilityMatrix> {
  const phoneIds = [...new Set(input.phoneIds ?? [])];
  const templateIds = [...new Set(input.templateIds ?? [])];
  if (phoneIds.length > COMPATIBILITY_MAX_IDS || templateIds.length > COMPATIBILITY_MAX_IDS) throw new CompatibilityInputError(`At most ${COMPATIBILITY_MAX_IDS} numbers and ${COMPATIBILITY_MAX_IDS} templates per request`);
  if (!phoneIds.length && !templateIds.length) throw new CompatibilityInputError("Select at least one number or one template");
  const connection = await loadConnectionState(organizationId);
  // Derive the missing side from the WABAs of the given side (plus, in the
  // local/mock context, unbound rows), bounded and deterministic by id.
  if (!templateIds.length) {
    const phones = await db.select({ wabaId: phoneNumbersTable.wabaId }).from(phoneNumbersTable).where(and(eq(phoneNumbersTable.organizationId, organizationId), inArray(phoneNumbersTable.id, phoneIds)));
    const wabaIds = [...new Set(phones.flatMap((p) => (p.wabaId === null ? [] : [p.wabaId])))];
    const includeUnbound = connection.mode !== "real" && phones.some((p) => p.wabaId === null);
    const conditions = [eq(templatesTable.organizationId, organizationId), eq(templatesTable.isSample, false)];
    const scope = includeUnbound ? (wabaIds.length ? sql`(${inArray(templatesTable.wabaId, wabaIds)} or ${isNull(templatesTable.wabaId)})` : isNull(templatesTable.wabaId)) : (wabaIds.length ? inArray(templatesTable.wabaId, wabaIds) : sql`false`);
    const rows = await db.select({ id: templatesTable.id }).from(templatesTable).where(and(...conditions, scope)).orderBy(templatesTable.id).limit(COMPATIBILITY_MAX_DERIVED);
    templateIds.push(...rows.map((r) => r.id));
  } else if (!phoneIds.length) {
    const templates = await db.select({ wabaId: templatesTable.wabaId }).from(templatesTable).where(and(eq(templatesTable.organizationId, organizationId), inArray(templatesTable.id, templateIds)));
    const wabaIds = [...new Set(templates.flatMap((t) => (t.wabaId === null ? [] : [t.wabaId])))];
    const includeUnbound = connection.mode !== "real" && templates.some((t) => t.wabaId === null);
    const conditions = [eq(phoneNumbersTable.organizationId, organizationId), eq(phoneNumbersTable.isSample, false)];
    const scope = includeUnbound ? (wabaIds.length ? sql`(${inArray(phoneNumbersTable.wabaId, wabaIds)} or ${isNull(phoneNumbersTable.wabaId)})` : isNull(phoneNumbersTable.wabaId)) : (wabaIds.length ? inArray(phoneNumbersTable.wabaId, wabaIds) : sql`false`);
    const rows = await db.select({ id: phoneNumbersTable.id }).from(phoneNumbersTable).where(and(...conditions, scope)).orderBy(phoneNumbersTable.id).limit(COMPATIBILITY_MAX_DERIVED);
    phoneIds.push(...rows.map((r) => r.id));
  }
  const state = await loadCompatibilityState(organizationId, { phoneIds, templateIds });
  return matrixFromState(state, phoneIds, templateIds);
}

export function matrixFromState(state: CompatibilityState, phoneIds: number[], templateIds: number[]): CompatibilityMatrix {
  const evaluatedAt = new Date();
  const incompatiblePairs: CompatibilityMatrix["incompatiblePairs"] = [];
  const eligibleByPhone = new Map<number, number[]>(phoneIds.map((id) => [id, []]));
  const eligibleByTemplate = new Map<number, number[]>(templateIds.map((id) => [id, []]));
  const templateEvidence = new Map<number, Evidence | null>();
  for (const phoneId of phoneIds) {
    for (const templateId of templateIds) {
      const decision = decidePair(state, phoneId, templateId);
      if (decision.eligible) {
        eligibleByPhone.get(phoneId)!.push(templateId);
        eligibleByTemplate.get(templateId)!.push(phoneId);
        if (!templateEvidence.has(templateId)) templateEvidence.set(templateId, decision.evidence);
      } else {
        incompatiblePairs.push({ phoneNumberId: phoneId, templateId, code: decision.code, message: decision.message });
      }
    }
  }
  const wabaExternal = (wabaId: number | null) => (wabaId === null ? null : state.wabas.get(wabaId)?.externalId ?? null);
  const numbers = phoneIds.map((phoneNumberId) => {
    const phone = state.phones.get(phoneNumberId);
    const verdict = describePhone(state, phoneNumberId);
    return {
      phoneNumberId,
      phone: phone?.phone ?? "",
      displayName: phone?.displayName ?? "",
      wabaId: phone?.wabaId ?? null,
      wabaExternalId: wabaExternal(phone?.wabaId ?? null),
      transport: verdict.transport,
      eligibleTemplateIds: eligibleByPhone.get(phoneNumberId)!,
      code: verdict.code,
    };
  });
  const templates = templateIds.map((templateId) => {
    const template = state.templates.get(templateId);
    const eligible = eligibleByTemplate.get(templateId)!;
    const row = state.evidence.get(templateId);
    let code: EligibilityReasonCode = "eligible";
    if (!template) code = "not_found";
    else if (template.isSample) code = "template_sample";
    else if (template.providerMissing || template.status === "Removed") code = "template_removed";
    else if (template.status !== "Approved") code = "template_not_approved";
    else if (!eligible.length && incompatiblePairs.some((p) => p.templateId === templateId)) code = incompatiblePairs.find((p) => p.templateId === templateId)!.code;
    return {
      templateId,
      name: template?.name ?? "",
      language: template?.language ?? "",
      wabaId: template?.wabaId ?? null,
      wabaExternalId: wabaExternal(template?.wabaId ?? null),
      eligiblePhoneNumberIds: eligible,
      evidence: templateEvidence.get(templateId) ?? (row ? { source: row.evidenceSource, verifiedAt: row.verifiedAt } : null),
      code,
    };
  });
  return {
    evaluatedAt,
    numbers,
    templates,
    incompatiblePairs,
    numbersWithoutTemplate: numbers.filter((n) => !n.eligibleTemplateIds.length).map((n) => n.phoneNumberId),
    templatesWithoutNumber: templates.filter((t) => !t.eligiblePhoneNumberIds.length).map((t) => t.templateId),
  };
}

// ----------------------------------------------------------- Rocket pairing

export type PairingResult =
  | { ok: true; assignments: Array<{ phoneNumberId: number; templateId: number }> }
  | { ok: false; message: string; uncoveredTemplateIds: number[]; numbersWithoutTemplate: number[] };

/**
 * Deterministic setup pairing (V2-04; not the V2-06 recipient allocator).
 * Model unchanged: one template per route, one route per selected number,
 * every selected template covered. Step 1 finds a template-saturating
 * matching with augmenting paths (Kuhn), trying templates in request
 * order and, for each, numbers in request order, so the same inputs always
 * give the same matching and a feasible combination the old rotating
 * greedy pass could miss is found. Step 2 gives every remaining number the
 * eligible template with the fewest numbers so far, ties by request
 * order. Ordering inputs: the request's number order and template order.
 */
export function pairSendersToTemplates(phoneIds: number[], templateIds: number[], eligible: (phoneId: number, templateId: number) => boolean): PairingResult {
  const matchOfPhone = new Map<number, number>();
  const matchOfTemplate = new Map<number, number>();
  const tryTemplate = (templateId: number, visited: Set<number>): boolean => {
    // Prefer a still-free eligible number (keeps earlier assignments where
    // possible); only then re-route an earlier assignment through an
    // augmenting path. Both passes walk numbers in request order.
    for (const phoneId of phoneIds) {
      if (visited.has(phoneId) || !eligible(phoneId, templateId) || matchOfPhone.has(phoneId)) continue;
      visited.add(phoneId);
      matchOfPhone.set(phoneId, templateId);
      matchOfTemplate.set(templateId, phoneId);
      return true;
    }
    for (const phoneId of phoneIds) {
      if (visited.has(phoneId) || !eligible(phoneId, templateId)) continue;
      visited.add(phoneId);
      const current = matchOfPhone.get(phoneId)!;
      if (tryTemplate(current, visited)) {
        matchOfPhone.set(phoneId, templateId);
        matchOfTemplate.set(templateId, phoneId);
        return true;
      }
    }
    return false;
  };
  const uncovered: number[] = [];
  for (const templateId of templateIds) {
    if (!tryTemplate(templateId, new Set())) uncovered.push(templateId);
  }
  const numbersWithoutTemplate = phoneIds.filter((phoneId) => !templateIds.some((templateId) => eligible(phoneId, templateId)));
  if (uncovered.length || numbersWithoutTemplate.length) {
    const parts: string[] = [];
    if (uncovered.length) parts.push(`${uncovered.length === 1 ? "template" : "templates"} ${uncovered.join(", ")} cannot be covered by the selected numbers`);
    if (numbersWithoutTemplate.length) parts.push(`${numbersWithoutTemplate.length === 1 ? "number" : "numbers"} ${numbersWithoutTemplate.join(", ")} cannot send any selected template`);
    return { ok: false, message: `The selected combination cannot be set up: ${parts.join("; ")}.`, uncoveredTemplateIds: uncovered, numbersWithoutTemplate };
  }
  const load = new Map<number, number>(templateIds.map((id) => [id, 0]));
  for (const templateId of matchOfTemplate.keys()) load.set(templateId, 1);
  const assignments: Array<{ phoneNumberId: number; templateId: number }> = [];
  for (const phoneId of phoneIds) {
    let templateId = matchOfPhone.get(phoneId);
    if (templateId === undefined) {
      for (const candidate of templateIds) {
        if (!eligible(phoneId, candidate)) continue;
        if (templateId === undefined || load.get(candidate)! < load.get(templateId)!) templateId = candidate;
      }
      load.set(templateId!, load.get(templateId!)! + 1);
    }
    assignments.push({ phoneNumberId: phoneId, templateId: templateId! });
  }
  return { ok: true, assignments };
}

// --------------------------------------------------------- evidence writers

export type ProviderTemplateObservation = { templateId: number; wabaId: number; providerTemplateId: string; providerStatus: string | null; status: string };

type Executor = Pick<typeof db, "insert" | "update" | "select" | "execute">;

/**
 * Called INSIDE an applied sync transaction (after generation ordering and
 * credential/WABA revalidation): every template Meta listed gets its
 * evidence row; templates of the WABA that Meta no longer lists lose
 * `sendable` and gain `providerMissing`. Never called for a failed or
 * superseded sync, so those write no evidence.
 */
export async function recordAppliedTemplateEvidence(tx: Executor, input: {
  organizationId: number; wabaId: number; source: TemplateEligibilitySource; verifiedAt: Date; syncGeneration: number | null; credentialId: number | null;
  observed: ProviderTemplateObservation[];
}): Promise<void> {
  for (const row of input.observed) {
    const values = {
      organizationId: input.organizationId, templateId: row.templateId, wabaId: row.wabaId, providerTemplateId: row.providerTemplateId,
      providerStatus: row.providerStatus, status: row.status, providerMissing: false, sendable: row.status === "Approved",
      evidenceSource: input.source, verifiedAt: input.verifiedAt, syncGeneration: input.syncGeneration, credentialId: input.credentialId,
    };
    await tx.insert(templateEligibilityTable).values(values).onConflictDoUpdate({
      target: [templateEligibilityTable.organizationId, templateEligibilityTable.templateId],
      set: { ...values, updatedAt: new Date() },
    });
  }
  const seen = input.observed.map((row) => row.templateId);
  await tx.update(templateEligibilityTable).set({
    sendable: false, providerMissing: true, providerStatus: null, status: "Removed", evidenceSource: input.source, verifiedAt: input.verifiedAt, syncGeneration: input.syncGeneration, updatedAt: new Date(),
  }).where(and(
    eq(templateEligibilityTable.organizationId, input.organizationId),
    eq(templateEligibilityTable.wabaId, input.wabaId),
    eq(templateEligibilityTable.providerMissing, false),
    ...(seen.length ? [sql`${templateEligibilityTable.templateId} not in (${sql.join(seen.map((id) => sql`${id}`), sql`, `)})`] : []),
  ));
}

/**
 * Idempotent backfill from valid existing relationships: every non-sample
 * templates row that carries a provider template id AND a WABA gets a
 * `backfill` evidence row stating exactly what the templates row already
 * says (Approved -> sendable, Removed/missing -> not). Rows a sync has
 * written are left alone (they are fresher and provenance-bearing); a
 * backfill row is refreshed only by another backfill or a sync. Local and
 * sample rows are never promoted. Also fills campaign_routes.waba_id from
 * the route's phone where it is still null. Safe to run any number of
 * times; one statement each.
 */
export async function backfillTemplateEligibility(organizationId?: number): Promise<{ templatesEvaluated: number; routesFilled: number }> {
  const orgFilter = organizationId === undefined ? sql`` : sql`and t.organization_id = ${organizationId}`;
  const evidence = await db.execute(sql`
    insert into template_eligibility (organization_id, template_id, waba_id, provider_template_id, provider_status, status, provider_missing, sendable, evidence_source, verified_at, sync_generation, credential_id)
    select t.organization_id, t.id, t.waba_id, t.provider_template_id,
      nullif(t.metadata->>'providerStatus', ''),
      t.status,
      coalesce((t.metadata->>'providerMissing')::boolean, false),
      (t.status = 'Approved' and not coalesce((t.metadata->>'providerMissing')::boolean, false)),
      'backfill',
      coalesce(t.last_synced_at, t.updated_at),
      null,
      case when (t.metadata->>'credentialId') ~ '^[0-9]+$' then (t.metadata->>'credentialId')::integer else null end
    from templates t
    join wabas w on w.id = t.waba_id and w.organization_id = t.organization_id
    where t.provider_template_id is not null and t.waba_id is not null and t.is_sample = false ${orgFilter}
    on conflict (organization_id, template_id) do update set
      waba_id = excluded.waba_id, provider_template_id = excluded.provider_template_id, provider_status = excluded.provider_status,
      status = excluded.status, provider_missing = excluded.provider_missing, sendable = excluded.sendable,
      verified_at = excluded.verified_at, credential_id = excluded.credential_id, updated_at = now()
    where template_eligibility.evidence_source = 'backfill'
  `);
  const routeOrgFilter = organizationId === undefined ? sql`` : sql`and r.organization_id = ${organizationId}`;
  const routes = await db.execute(sql`
    update campaign_routes r set waba_id = p.waba_id
    from phone_numbers p
    where p.id = r.phone_number_id and p.organization_id = r.organization_id and r.waba_id is null and p.waba_id is not null ${routeOrgFilter}
  `);
  return { templatesEvaluated: evidence.rowCount ?? 0, routesFilled: routes.rowCount ?? 0 };
}

/** Phone's WABA, server-derived, for campaign_routes.waba_id (validated derived data, never client input). */
export async function derivedRouteWabaId(organizationId: number, phoneNumberId: number): Promise<number | null> {
  const [phone] = await db.select({ wabaId: phoneNumbersTable.wabaId }).from(phoneNumbersTable).where(and(eq(phoneNumbersTable.id, phoneNumberId), eq(phoneNumbersTable.organizationId, organizationId)));
  return phone?.wabaId ?? null;
}

