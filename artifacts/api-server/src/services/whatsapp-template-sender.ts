import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignPlansTable,
  campaignRoutesTable,
  db,
  phoneNumbersTable,
  providerMessagesTable,
  suppressionsTable,
  templatesTable,
  wabasTable,
  type CampaignJob,
} from "@workspace/db";
import { PreparedProviderFailure, type ProviderSender, type SendOptions } from "./campaign-queue";
import type { SerializableTransportPayload } from "./campaign-transport-shards";
import { getOrCreateProviderConnection } from "./whatsapp-sync";
import { ProviderRequestError, providerClient, redactProviderText, type ProviderMode } from "./whatsapp-provider";

type FrozenTemplateContext = {
  templateId: number;
  templateName: string;
  language: string;
  templateWabaId: number | null;
  templateComponents: Record<string, unknown>[];
};

type PreparedSendContext = {
  organizationId: number;
  campaignId: number;
  jobId: number;
  routeId: number;
  contactId: number;
  phoneNumberId: number;
  providerPhoneId: string | null;
  recipient: string;
  phoneWabaId: number | null;
  templateWabaId: number | null;
  templateName: string;
  language: string;
  templateComponents: Record<string, unknown>[];
  connection: Awaited<ReturnType<typeof getOrCreateProviderConnection>>;
  providerMessageRowId: number;
  priorProviderMessageId: string | null;
  payload: Record<string, unknown>;
};

type PendingProviderOutcome = {
  providerMessageRowId: number;
  providerMessageId: string | null;
  status: "sent" | "rejected" | "delivery_unknown";
  errorReason: string | null;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Recovers the template a job's frozen plan actually assigned it to, from
 * the plan's own frozen templatesSnapshot -- never the live `templates`
 * table -- so a template edited (name/language/components) after planning
 * can never change what an already-planned/executing job sends. Falls back
 * to the live route's templateId only for jobs without a resolvable plan
 * (created directly against the live tables, e.g. bypass fixtures).
 */
async function frozenTemplateForSend(job: CampaignJob): Promise<FrozenTemplateContext | undefined> {
  const [plan] = job.planId
    ? await db.select().from(campaignPlansTable).where(and(
      eq(campaignPlansTable.id, job.planId),
      eq(campaignPlansTable.organizationId, job.organizationId),
      eq(campaignPlansTable.campaignId, job.campaignId),
    ))
    : await db.select().from(campaignPlansTable).where(and(
      eq(campaignPlansTable.organizationId, job.organizationId),
      eq(campaignPlansTable.campaignId, job.campaignId),
      eq(campaignPlansTable.status, "Active"),
    ))
      .orderBy(desc(campaignPlansTable.version))
      .limit(1);
  if (!plan) return undefined;
  const frozenRoute = plan.routes.find((route) => route.routeId === job.routeId);
  const templateId = frozenRoute?.templateId ?? job.templateId ?? undefined;
  if (!templateId) return undefined;
  const snapshot = plan.templatesSnapshot.find((template) => template.id === templateId);
  if (!snapshot) return undefined;
  return {
    templateId: snapshot.id,
    templateName: snapshot.name,
    language: snapshot.language,
    templateWabaId: snapshot.wabaId,
    templateComponents: snapshot.components,
  };
}

type ResolvedParameters = {
  header?: Record<string, string>;
  body?: Record<string, string>;
  button?: Record<string, string>;
};

function orderedValues(values: Record<string, string> | undefined): string[] {
  return Object.entries(values ?? {})
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value);
}

export function buildMetaTemplatePayload(
  recipient: string,
  templateName: string,
  language: string,
  resolved: ResolvedParameters,
  templateComponents: Record<string, unknown>[] = [],
): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  const header = orderedValues(resolved.header);
  const body = orderedValues(resolved.body);
  const headerDefinition = templateComponents.find((component) => String(component.type).toUpperCase() === "HEADER");
  const headerFormat = String(headerDefinition?.format ?? "TEXT").toLowerCase();
  if (header.length) {
    if (["image", "video", "document"].includes(headerFormat)) {
      components.push({ type: "header", parameters: [{ type: headerFormat, [headerFormat]: { link: header[0] } }] });
    } else components.push({ type: "header", parameters: header.map((text) => ({ type: "text", text })) });
  }
  if (body.length) components.push({ type: "body", parameters: body.map((text) => ({ type: "text", text })) });
  const dynamicUrlIndexes = new Set<number>();
  for (const definition of templateComponents) {
    if (String(definition.type).toUpperCase() !== "BUTTONS" || !Array.isArray(definition.buttons)) continue;
    definition.buttons.forEach((button, index) => {
      if (button && typeof button === "object" && typeof (button as Record<string, unknown>).url === "string" &&
        /\{\{\s*\d+\s*\}\}/.test((button as Record<string, string>).url)) dynamicUrlIndexes.add(index);
    });
  }
  for (const [key, text] of Object.entries(resolved.button ?? {}).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    const match = /^(\d+):\d+$/.exec(key);
    if (!match || !dynamicUrlIndexes.has(Number(match[1]))) throw new Error(`Invalid dynamic URL button parameter ${key}`);
    components.push({ type: "button", sub_type: "url", index: match[1], parameters: [{ type: "text", text }] });
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      ...(components.length ? { components } : {}),
    },
  };
}

export class WhatsAppTemplateSender implements ProviderSender {
  private static readonly OUTCOME_QUEUE_CAPACITY = 4_096;
  private static readonly OUTCOME_FLUSH_SIZE = 256;
  private readonly outcomes: PendingProviderOutcome[] = [];
  private readonly reservedOutcomeJobIds = new Set<number>();
  private flushing: Promise<void> | undefined;
  private outcomeDeadline: NodeJS.Timeout | undefined;

  private reserveOutcomeSlots(jobIds: number[]): void {
    const uniqueJobIds = [...new Set(jobIds)];
    if (
      this.outcomes.length + this.reservedOutcomeJobIds.size + uniqueJobIds.length
      > WhatsAppTemplateSender.OUTCOME_QUEUE_CAPACITY
    ) {
      throw new ProviderRequestError("Provider outcome settlement is backpressured", true);
    }
    for (const jobId of uniqueJobIds) this.reservedOutcomeJobIds.add(jobId);
  }

  private releaseOutcomeSlot(jobId: number): void {
    this.reservedOutcomeJobIds.delete(jobId);
  }

  preparedRecipient(preparedContext: unknown): { organizationId: number; recipient: string } | undefined {
    const context = preparedContext as Partial<PreparedSendContext> | undefined;
    return typeof context?.organizationId === "number" && typeof context.recipient === "string"
      ? { organizationId: context.organizationId, recipient: context.recipient }
      : undefined;
  }

  async validatePrepared(preparedContext: unknown): Promise<boolean> {
    const context = preparedContext as PreparedSendContext;
    const [suppression] = await db.select({ reason: suppressionsTable.reason })
      .from(suppressionsTable).where(and(
        eq(suppressionsTable.organizationId, context.organizationId),
        eq(suppressionsTable.normalizedPhone, context.recipient),
      ));
    return !suppression;
  }

  /**
   * One suppression lookup for a whole prepared batch.
   *
   * prepareBatch() already screens recipients inside the durable-intent
   * transaction; this is the re-check the reservoir runs on the prepared
   * envelopes just before publication, catching a suppression that committed
   * after that transaction. It used to cost one round trip per message.
   *
   * suppressions is unique on (organization_id, normalized_phone), so the
   * per-message validatePrepared() is an existence test on that one pair.
   * This asks which of the batch's distinct (organization, recipient) pairs
   * exist and rejects every context whose pair is present: the same predicate
   * evaluated on the same key, so for a given suppression set the decisions
   * are identical to calling validatePrepared() per message. Contexts that
   * share a recipient share one pair and therefore one decision. Like the
   * per-message check this is a non-transactional read; a suppression that
   * commits after it has been evaluated is caught when the job is next
   * prepared, exactly as before.
   */
  async validatePreparedBatch(
    items: ReadonlyArray<{ jobId: number; preparedContext: unknown }>,
  ): Promise<ReadonlySet<number>> {
    const key = (organizationId: number, recipient: string) => `${organizationId}\u0000${recipient}`;
    const pairs = new Map<string, { organizationId: number; recipient: string }>();
    for (const { preparedContext } of items) {
      const context = preparedContext as PreparedSendContext;
      pairs.set(key(context.organizationId, context.recipient), {
        organizationId: context.organizationId,
        recipient: context.recipient,
      });
    }
    if (!pairs.size) return new Set();
    const rows = await db.select({
      organizationId: suppressionsTable.organizationId,
      normalizedPhone: suppressionsTable.normalizedPhone,
    }).from(suppressionsTable).where(sql`(${suppressionsTable.organizationId}, ${suppressionsTable.normalizedPhone}) in (${
      sql.join([...pairs.values()].map((pair) => sql`(${pair.organizationId}, ${pair.recipient})`), sql`, `)
    })`);
    const suppressed = new Set(rows.map((row) => key(row.organizationId, row.normalizedPhone)));
    const rejected = new Set<number>();
    for (const { jobId, preparedContext } of items) {
      const context = preparedContext as PreparedSendContext;
      if (suppressed.has(key(context.organizationId, context.recipient))) rejected.add(jobId);
    }
    return rejected;
  }

  async revokePrepared(preparedContext: unknown, reason: unknown): Promise<void> {
    const context = preparedContext as PreparedSendContext;
    this.releaseOutcomeSlot(context.jobId);
    if (context.priorProviderMessageId) return;
    await db.update(providerMessagesTable).set({
      status: "rejected",
      errorReason: redactProviderText(reason instanceof Error ? reason.message : reason),
    }).where(and(
      eq(providerMessagesTable.id, context.providerMessageRowId),
      eq(providerMessagesTable.status, "pending"),
    ));
  }

  async prepareBatch(jobs: CampaignJob[], signal?: AbortSignal): Promise<Map<number, unknown>> {
    if (!jobs.length) return new Map();
    if (jobs.some((job) => !job.routeId || !job.contactId)) throw new Error("Campaign job is missing its route or contact");
    const routeIds = [...new Set(jobs.map((job) => job.routeId!))];
    const contactIds = [...new Set(jobs.map((job) => job.contactId!))];
    const [routes, contacts, plans] = await Promise.all([
      db.select({ id: campaignRoutesTable.id, organizationId: campaignRoutesTable.organizationId, campaignId: campaignRoutesTable.campaignId, phoneNumberId: phoneNumbersTable.id, providerPhoneId: phoneNumbersTable.providerPhoneId, phoneWabaId: phoneNumbersTable.wabaId, liveTemplateId: campaignRoutesTable.templateId })
        .from(campaignRoutesTable).innerJoin(phoneNumbersTable, eq(phoneNumbersTable.id, campaignRoutesTable.phoneNumberId)).where(inArray(campaignRoutesTable.id, routeIds)),
      db.select({ id: campaignContactsTable.id, organizationId: campaignContactsTable.organizationId, campaignId: campaignContactsTable.campaignId, recipient: campaignContactsTable.normalizedPhone }).from(campaignContactsTable).where(inArray(campaignContactsTable.id, contactIds)),
      db.select().from(campaignPlansTable).where(inArray(campaignPlansTable.campaignId, [...new Set(jobs.map((job) => job.campaignId))])),
    ]);
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
    const frozenByJob = new Map<number, FrozenTemplateContext | undefined>();
    const templateIds = new Set<number>();
    for (const job of jobs) {
      const plan = plans.filter((candidate) => candidate.organizationId === job.organizationId && candidate.campaignId === job.campaignId && (job.planId ? candidate.id === job.planId : candidate.status === "Active"))
        .sort((a, b) => b.version - a.version)[0];
      const frozenRoute = plan?.routes.find((route) => route.routeId === job.routeId);
      const plannedTemplateId = frozenRoute?.templateId ?? job.templateId ?? undefined;
      const snapshot = plannedTemplateId && plan?.templatesSnapshot.find((template) => template.id === plannedTemplateId);
      const frozen = snapshot ? { templateId: snapshot.id, templateName: snapshot.name, language: snapshot.language, templateWabaId: snapshot.wabaId, templateComponents: snapshot.components } : undefined;
      frozenByJob.set(job.id, frozen);
      const effectiveTemplateId = frozen?.templateId ?? routeById.get(job.routeId!)?.liveTemplateId;
      if (effectiveTemplateId) templateIds.add(effectiveTemplateId);
    }
    const liveTemplates = await db.select({ id: templatesTable.id, organizationId: templatesTable.organizationId, status: templatesTable.status, name: templatesTable.name, language: templatesTable.language, components: templatesTable.components, wabaId: templatesTable.wabaId }).from(templatesTable).where(inArray(templatesTable.id, [...templateIds]));
    const templateById = new Map(liveTemplates.map((template) => [template.id, template]));
    const organizationIds = [...new Set(jobs.map((job) => job.organizationId))];
    const connections = new Map(await Promise.all(organizationIds.map(async (id) => [id, await getOrCreateProviderConnection(id)] as const)));
    const realConnections = [...connections.entries()].filter(([, connection]) => connection.mode === "real");
    const claimedWabas = await db.select({ id: wabasTable.id, organizationId: wabasTable.organizationId, externalId: wabasTable.externalId }).from(wabasTable)
      .where(inArray(wabasTable.organizationId, realConnections.map(([id]) => id)));
    const claimedByOrg = new Map(realConnections.map(([organizationId, connection]) => [
      organizationId,
      claimedWabas.find((waba) => waba.organizationId === organizationId && waba.externalId === connection.configuredWabaExternalId),
    ]));
    await Promise.all(realConnections.map(async ([organizationId, connection]) => {
      if (!connection.connectorAccountId || !connection.configuredWabaExternalId || claimedByOrg.get(organizationId)?.externalId !== connection.configuredWabaExternalId) throw new ProviderRequestError("Real WhatsApp workspace is not verified", false);
      if (await providerClient("real").identity(signal) !== connection.connectorAccountId) throw new ProviderRequestError("Real WhatsApp connector identity no longer matches this workspace claim", false);
    }));
    const pendingContexts: Array<{ job: CampaignJob; context: Omit<PreparedSendContext, "providerMessageRowId" | "priorProviderMessageId" | "payload"> }> = [];
    for (const job of jobs) {
      const route = routeById.get(job.routeId!);
      const contact = contactById.get(job.contactId!);
      if (!route || !contact || route.organizationId !== job.organizationId || contact.organizationId !== job.organizationId || route.campaignId !== job.campaignId || contact.campaignId !== job.campaignId) throw new Error("Campaign route or contact provider context was not found");
      if (!contact.recipient) throw new Error("Campaign contact has no valid recipient phone");
      const frozen = frozenByJob.get(job.id);
      const effectiveTemplateId = frozen?.templateId ?? route.liveTemplateId;
      const template = effectiveTemplateId && templateById.get(effectiveTemplateId);
      if (!template || template.organizationId !== job.organizationId) throw new Error("Campaign job's template no longer exists");
      if (template.status !== "Approved") throw new Error("Only an approved provider template can be sent");
      const connection = connections.get(job.organizationId)!;
      const templateWabaId = frozen?.templateWabaId ?? template.wabaId;
      if (connection.mode === "real" && (route.phoneWabaId !== claimedByOrg.get(job.organizationId)?.id || templateWabaId !== claimedByOrg.get(job.organizationId)?.id)) throw new ProviderRequestError("Route phone and template must belong to the claimed WhatsApp Business Account", false);
      pendingContexts.push({
        job,
        context: {
          ...route,
          jobId: job.id,
          routeId: job.routeId!,
          contactId: job.contactId!,
          recipient: contact.recipient,
          templateWabaId,
          templateName: frozen?.templateName ?? template.name,
          language: frozen?.language ?? template.language,
          templateComponents: frozen?.templateComponents ?? template.components,
          connection,
        },
      });
    }
    const contexts = new Map<number, unknown>();
    // Arm every envelope durably before it enters a phone reservoir. Locks are
    // acquired in stable order, suppression is checked under the same lock
    // used by STOP, and the provider request key is persisted exactly once.
    await db.transaction(async (tx) => {
      const intentInput = pendingContexts.map(({ job, context }) => ({
        jobId: job.id,
        organizationId: job.organizationId,
        requestKey: createHash("sha256")
          .update(`whatsapp-business:${job.organizationId}:${job.idempotencyKey}`).digest("hex"),
        recipient: context.recipient,
      }));
      const lockKeys = [
        ...intentInput.map((item) => `suppression-phone:${item.organizationId}:${item.recipient}`),
        ...intentInput.map((item) => `provider-send:${item.jobId}`),
      ].sort();
      // One deterministic statement takes all fences.  Taking both fence
      // families in one globally sorted order avoids N round trips and lock
      // order inversions between overlapping refill batches.
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtext(lock_key))
        from jsonb_array_elements_text(${JSON.stringify(lockKeys)}::jsonb) as locks(lock_key)
        order by lock_key
      `);
      const suppressed = await tx.execute<{ organizationId: number; recipient: string; reason: string }>(sql`
        with input as (
          select * from jsonb_to_recordset(${JSON.stringify(intentInput)}::jsonb) as item(
            "jobId" int, "organizationId" int, "requestKey" text, recipient text
          )
        )
        select input."organizationId" as "organizationId", input.recipient, suppression.reason
        from input join suppressions as suppression
          on suppression.organization_id = input."organizationId"
         and suppression.normalized_phone = input.recipient
      `);
      if (suppressed.rows.length) {
        throw new ProviderRequestError(
          `Recipient is on the suppression list (${suppressed.rows[0]!.reason})`,
          false,
        );
      }
      const intents = await tx.execute<{
        jobId: number; id: number; status: string;
        providerMessageId: string | null; priorStatus: string | null;
      }>(sql`
        with input as (
          select * from jsonb_to_recordset(${JSON.stringify(intentInput)}::jsonb) as item(
            "jobId" int, "organizationId" int, "requestKey" text, recipient text
          )
        ),
        prior as materialized (
          select input."jobId", message.status as prior_status
          from input join provider_messages as message
            on message.organization_id = input."organizationId"
           and message.campaign_job_id = input."jobId"
        ),
        armed as (
          insert into provider_messages (
            organization_id, campaign_job_id, provider, request_key, status, recipient_external_id
          )
          select "organizationId", "jobId", 'whatsapp-business', "requestKey", 'pending', recipient
          from input
          on conflict (organization_id, campaign_job_id) do update
          set request_key = excluded.request_key,
              status = case when provider_messages.status = 'rejected' then 'pending' else provider_messages.status end,
              error_reason = case when provider_messages.status = 'rejected' then null else provider_messages.error_reason end,
              recipient_external_id = excluded.recipient_external_id
          returning id, campaign_job_id, status, provider_message_id
        )
        select armed.campaign_job_id as "jobId", armed.id, armed.status,
               armed.provider_message_id as "providerMessageId",
               prior.prior_status as "priorStatus"
        from armed left join prior on prior."jobId" = armed.campaign_job_id
      `);
      const intentByJob = new Map(intents.rows.map((intent) => [intent.jobId, intent]));
      for (const { job, context } of pendingContexts) {
        const state = intentByJob.get(job.id);
        if (!state) throw new Error("Provider intent was not returned for prepared campaign job");
        if (state.priorStatus === "pending" || state.priorStatus === "delivery_unknown") {
          contexts.set(
            job.id,
            new PreparedProviderFailure(
              new ProviderRequestError("Provider delivery is unknown; manual reconciliation is required", false),
            ),
          );
          continue;
        }
        const resolved = (job.payload.resolvedParameters ?? {}) as ResolvedParameters;
        contexts.set(job.id, {
          ...context,
          providerMessageRowId: state.id,
          priorProviderMessageId: state.priorStatus === "sent" ? state.providerMessageId : null,
          payload: buildMetaTemplatePayload(
            context.recipient,
            context.templateName,
            context.language,
            resolved,
            context.templateComponents,
          ),
        } satisfies PreparedSendContext);
      }
    });
    this.reserveOutcomeSlots(
      [...contexts.entries()]
        .filter(([, context]) => !(context instanceof PreparedProviderFailure))
        .map(([jobId]) => jobId),
    );
    return contexts;
  }

  async sendPreparedTransport(
    job: CampaignJob,
    options: SendOptions,
    preparedContext: unknown,
  ): Promise<{ providerMessageId: string }> {
    const context = preparedContext as PreparedSendContext;
    if (!context || context.organizationId !== job.organizationId || context.campaignId !== job.campaignId || context.jobId !== job.id || context.routeId !== job.routeId || context.contactId !== job.contactId) throw new Error("Prepared campaign send context does not match job scope");
    if (context.priorProviderMessageId) {
      return { providerMessageId: context.priorProviderMessageId };
    }
    const connection = context.connection;
    const providerPhoneId = context.providerPhoneId ??
      (connection.mode === "mock" ? `mock-phone-${context.phoneNumberId}-job-${job.id}` : null);
    if (!providerPhoneId) throw new Error("Sending phone number has no synchronized provider ID");
    const timeout = AbortSignal.timeout(8_000);
    const signal = AbortSignal.any([options.signal, timeout]);
    const providerMessageId = await providerClient(connection.mode as ProviderMode)
      .send(providerPhoneId, context.payload, signal);
    return { providerMessageId };
  }

  serializePreparedTransport(job: CampaignJob, preparedContext: unknown): SerializableTransportPayload | undefined {
    const context = preparedContext as PreparedSendContext;
    if (!context || context.jobId !== job.id || context.organizationId !== job.organizationId) {
      throw new Error("Prepared campaign transport context does not match job scope");
    }
    if (context.priorProviderMessageId) return undefined;
    const providerPhoneId = context.providerPhoneId ??
      (context.connection.mode === "mock" ? `mock-phone-${context.phoneNumberId}-job-${job.id}` : null);
    if (!providerPhoneId) throw new Error("Sending phone number has no synchronized provider ID");
    return {
      kind: "whatsapp",
      mode: context.connection.mode as ProviderMode,
      providerPhoneId,
      payload: context.payload,
      timeoutMs: 8_000,
    };
  }

  async settlePreparedTransport(
    job: CampaignJob,
    preparedContext: unknown,
    outcome: { providerMessageId: string } | { error: unknown },
  ): Promise<void> {
    const context = preparedContext as PreparedSendContext;
    this.releaseOutcomeSlot(job.id);
    if (this.outcomes.length >= WhatsAppTemplateSender.OUTCOME_QUEUE_CAPACITY) {
      // This must be fail-closed: the job lease remains Processing and its
      // durable intent remains pending, so recovery cannot issue another HTTP
      // request if a process dies while settlement storage is saturated.
      throw new Error("Provider outcome queue is full");
    }
    const acknowledged = new Promise<void>((resolve, reject) => {
      this.outcomes.push("providerMessageId" in outcome
      ? {
        providerMessageRowId: context.providerMessageRowId,
        providerMessageId: outcome.providerMessageId,
        status: "sent",
        errorReason: null,
        resolve,
        reject,
      }
      : {
        providerMessageRowId: context.providerMessageRowId,
        providerMessageId: null,
        status: outcome.error instanceof ProviderRequestError ? "rejected" : "delivery_unknown",
        errorReason: redactProviderText(
          outcome.error instanceof Error ? outcome.error.message : outcome.error,
        ),
        resolve,
        reject,
      });
    });
    if (this.outcomes.length >= WhatsAppTemplateSender.OUTCOME_FLUSH_SIZE) {
      void this.flushPreparedOutcomes().catch(() => {
        // The batch remains queued and applies refill backpressure.
      });
    } else {
      this.scheduleOutcomeFlush();
    }
    // Deliberately return a durable batch acknowledgement. CampaignWorker
    // awaits this only after HTTP completed, before it settles campaign_jobs.
    return acknowledged;
  }

  async flushPreparedOutcomes(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.outcomes.length) {
        const batch = this.outcomes.splice(0, WhatsAppTemplateSender.OUTCOME_FLUSH_SIZE);
        try {
          await db.execute(sql`
            with input as (
              select * from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as item(
                "providerMessageRowId" int,
                "providerMessageId" text,
                status text,
                "errorReason" text
              )
            )
            update provider_messages as message
            set provider_message_id = input."providerMessageId",
                status = input.status,
                error_reason = input."errorReason"
            from input
            where message.id = input."providerMessageRowId"
              and message.status = 'pending'
          `);
          for (const outcome of batch) outcome.resolve();
        } catch (error) {
          this.outcomes.unshift(...batch);
          // Keep each acknowledgement pending and retry the same idempotent
          // durable write. The transport shard retains bounded outcome
          // capacity until this succeeds, then the original promises resolve.
          this.scheduleOutcomeFlush();
          throw error;
        }
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private scheduleOutcomeFlush(): void {
    if (!this.outcomeDeadline) {
      this.outcomeDeadline = setTimeout(() => {
        this.outcomeDeadline = undefined;
        void this.flushPreparedOutcomes().catch(() => {
          // Retained outcomes make capacity backpressure durable/fail-closed.
        });
      }, 25);
      this.outcomeDeadline.unref();
    }
  }

  /** Compatibility orchestration for callers outside the campaign reservoir. */
  async send(job: CampaignJob, options: SendOptions, preparedContext?: unknown): Promise<{ providerMessageId: string }> {
    const context = preparedContext ?? (await this.prepareBatch([job], options.signal)).get(job.id);
    if (context instanceof PreparedProviderFailure) throw context.error;
    try {
      const result = await this.sendPreparedTransport(job, options, context);
      await this.settlePreparedTransport(job, context, result);
      await this.flushPreparedOutcomes();
      return result;
    } catch (error) {
      await this.settlePreparedTransport(job, context, { error });
      await this.flushPreparedOutcomes();
      throw error;
    }
  }
}

/** Selects mock or real through tenant connection metadata for every claimed job. */
export class DelegatingWhatsAppSender implements ProviderSender {
  private readonly sender = new WhatsAppTemplateSender();
  prepareBatch(jobs: CampaignJob[], signal?: AbortSignal): Promise<Map<number, unknown>> {
    return this.sender.prepareBatch(jobs, signal);
  }
  preparedRecipient(preparedContext: unknown): { organizationId: number; recipient: string } | undefined {
    return this.sender.preparedRecipient(preparedContext);
  }
  validatePrepared(preparedContext: unknown): Promise<boolean> {
    return this.sender.validatePrepared(preparedContext);
  }
  validatePreparedBatch(items: ReadonlyArray<{ jobId: number; preparedContext: unknown }>): Promise<ReadonlySet<number>> {
    return this.sender.validatePreparedBatch(items);
  }
  revokePrepared(preparedContext: unknown, reason: unknown): Promise<void> {
    return this.sender.revokePrepared(preparedContext, reason);
  }
  sendPreparedTransport(job: CampaignJob, options: SendOptions, preparedContext: unknown): Promise<{ providerMessageId: string }> {
    return this.sender.sendPreparedTransport(job, options, preparedContext);
  }
  serializePreparedTransport(job: CampaignJob, preparedContext: unknown): SerializableTransportPayload | undefined {
    return this.sender.serializePreparedTransport(job, preparedContext);
  }
  settlePreparedTransport(job: CampaignJob, preparedContext: unknown, outcome: { providerMessageId: string } | { error: unknown }): Promise<void> {
    return this.sender.settlePreparedTransport(job, preparedContext, outcome);
  }
  flushPreparedOutcomes(): Promise<void> {
    return this.sender.flushPreparedOutcomes();
  }
  send(job: CampaignJob, options: SendOptions, preparedContext?: unknown): Promise<{ providerMessageId: string }> {
    return this.sender.send(job, options, preparedContext);
  }
}