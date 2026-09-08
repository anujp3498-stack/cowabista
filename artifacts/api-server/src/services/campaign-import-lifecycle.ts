import { and, eq, sql } from "drizzle-orm";
import {
  campaignsTable,
  contactImportSessionsTable,
  db,
  type ContactImportSession,
} from "@workspace/db";

export type InitializeContactImportInput = {
  organizationId: number;
  campaignId: number;
  idempotencyKey: string;
  fileName: string;
  phoneColumn?: string;
  defaultCountryCode?: string;
};

export type InitializeContactImportResult =
  | { ok: true; replay: boolean; campaign: { id: number; status: string }; session: ContactImportSession }
  | { ok: false; status: 404 | 409; message: string };

type CampaignTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class CampaignImportFencedError extends Error {
  constructor(message = "Campaign contact import is no longer active") {
    super(message);
    this.name = "CampaignImportFencedError";
  }
}

export async function assertContactImportWritable(
  tx: CampaignTransaction,
  organizationId: number,
  campaignId: number,
  sessionId: number,
): Promise<void> {
  const [campaign] = await tx.select({ status: campaignsTable.status }).from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  )).for("update");
  const [session] = await tx.select({ status: contactImportSessionsTable.status })
    .from(contactImportSessionsTable)
    .where(and(
      eq(contactImportSessionsTable.id, sessionId),
      eq(contactImportSessionsTable.organizationId, organizationId),
      eq(contactImportSessionsTable.campaignId, campaignId),
    ))
    .for("update");
  if (campaign?.status !== "Draft" || session?.status !== "Processing") {
    throw new CampaignImportFencedError(
      campaign?.status === "Cancelled"
        ? "Campaign was cancelled during contact import"
        : "Campaign contact import is no longer active",
    );
  }
}

export async function initializeContactImport(
  input: InitializeContactImportInput,
): Promise<InitializeContactImportResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${String(input.organizationId)}),
        hashtext(${input.idempotencyKey})
      )
    `);
    const [campaign] = await tx.select({
      id: campaignsTable.id,
      status: campaignsTable.status,
    }).from(campaignsTable).where(and(
      eq(campaignsTable.id, input.campaignId),
      eq(campaignsTable.organizationId, input.organizationId),
    )).for("update");
    if (!campaign) return { ok: false, status: 404, message: "Campaign not found" };
    if (campaign.status !== "Draft") {
      return { ok: false, status: 409, message: "Contacts can only be imported while the campaign is Draft" };
    }

    let [session] = await tx.select().from(contactImportSessionsTable).where(and(
      eq(contactImportSessionsTable.organizationId, input.organizationId),
      eq(contactImportSessionsTable.idempotencyKey, input.idempotencyKey),
    ));
    if (session && session.campaignId !== input.campaignId) {
      return { ok: false, status: 409, message: "This import idempotency key belongs to a different campaign" };
    }
    if (session?.status === "Completed") {
      return { ok: true, replay: true, campaign, session };
    }

    const [activeImport] = await tx.select({ id: contactImportSessionsTable.id })
      .from(contactImportSessionsTable)
      .where(and(
        eq(contactImportSessionsTable.organizationId, input.organizationId),
        eq(contactImportSessionsTable.campaignId, input.campaignId),
        eq(contactImportSessionsTable.status, "Processing"),
      ))
      .limit(1);
    if (activeImport) {
      return {
        ok: false,
        status: 409,
        message: activeImport.id === session?.id
          ? "This contact import is already processing"
          : "Another contact import is already processing for this campaign",
      };
    }

    if (!session) {
      const [existingImport] = await tx.select({ id: contactImportSessionsTable.id })
        .from(contactImportSessionsTable)
        .where(and(
          eq(contactImportSessionsTable.organizationId, input.organizationId),
          eq(contactImportSessionsTable.campaignId, input.campaignId),
        ))
        .limit(1);
      if (existingImport) {
        return { ok: false, status: 409, message: "This campaign already has a contact import" };
      }
      [session] = await tx.insert(contactImportSessionsTable).values({
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        idempotencyKey: input.idempotencyKey,
        fileName: input.fileName,
        phoneColumn: input.phoneColumn,
        defaultCountryCode: input.defaultCountryCode,
      }).returning();
    } else {
      [session] = await tx.update(contactImportSessionsTable).set({
        status: "Processing",
        error: null,
      }).where(eq(contactImportSessionsTable.id, session.id)).returning();
    }
    return { ok: true, replay: false, campaign, session };
  });
}