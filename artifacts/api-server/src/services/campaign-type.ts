import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  campaignRoutesTable,
  campaignsTable,
  campaignTypes,
  type CampaignDeliveryMode,
  type CampaignDistributionMode,
  type CampaignType,
  db,
} from "@workspace/db";

// Campaign modules. A campaign is created as either a Normal ("standard")
// or a Rocket ("rocket") campaign and keeps that type for life. Both run on
// the same engine (message setup, delivery setup, preflight, launch,
// allocator v2, runtime); the type only decides which setup a campaign
// starts with and the few module rules below. A campaign created before
// types existed has campaign_type null: no rule applies to it and its type
// is inferred, for listing only, from its routes.

export { campaignTypes, type CampaignType };

export function isCampaignType(value: unknown): value is CampaignType {
  return typeof value === "string" && (campaignTypes as readonly string[]).includes(value);
}

/** The type shown for a campaign: its stored type, else inferred (more than one route = rocket). */
export function effectiveCampaignType(stored: string | null, routesCount: number): { campaignType: CampaignType; campaignTypeInferred: boolean } {
  if (isCampaignType(stored)) return { campaignType: stored, campaignTypeInferred: false };
  return { campaignType: routesCount > 1 ? "rocket" : "standard", campaignTypeInferred: true };
}

/**
 * The same rule as effectiveCampaignType, as SQL over the campaigns row, for
 * filtering a list by module. The route count is organization-scoped, like
 * the counts the list endpoints return.
 */
export function effectiveCampaignTypeSql(): SQL<string> {
  return sql<string>`coalesce(${campaignsTable.campaignType}, case when (
    select count(*) from ${campaignRoutesTable}
    where ${campaignRoutesTable.campaignId} = ${campaignsTable.id}
      and ${campaignRoutesTable.organizationId} = ${campaignsTable.organizationId}
  ) > 1 then 'rocket' else 'standard' end)`;
}

/**
 * The setup a new campaign of a type starts with. Both use allocator v2
 * with an automatic equal share per number. A Normal campaign has no
 * Delivery step, so it starts at the Balanced speed (changed on its Review
 * step); a Rocket campaign's speed is chosen in its Delivery step.
 */
export function campaignTypeDefaults(type: CampaignType): { distributionMode: CampaignDistributionMode; deliveryMode: CampaignDeliveryMode | null } {
  return type === "standard"
    ? { distributionMode: "equal_numbers", deliveryMode: "balanced" }
    : { distributionMode: "equal_numbers", deliveryMode: null };
}

/** A Normal campaign sends from one number with one template. */
export const STANDARD_MAX_SENDERS = 1;
export const STANDARD_MAX_TEMPLATES = 1;

export function standardSelectionProblem(senderCount: number, templateCount: number): string | null {
  if (senderCount > STANDARD_MAX_SENDERS && templateCount > STANDARD_MAX_TEMPLATES) return "A Normal campaign sends from one number with one template. Use a Rocket campaign for several numbers or templates.";
  if (senderCount > STANDARD_MAX_SENDERS) return "A Normal campaign sends from one number. Use a Rocket campaign for several numbers.";
  if (templateCount > STANDARD_MAX_TEMPLATES) return "A Normal campaign sends one template. Use a Rocket campaign to rotate several templates.";
  return null;
}

/** The stored type of an organization's campaign (null = untyped or not found). */
export async function storedCampaignType(executor: Pick<typeof db, "select">, organizationId: number, campaignId: number): Promise<CampaignType | null> {
  const [row] = await executor.select({ campaignType: campaignsTable.campaignType }).from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId), eq(campaignsTable.organizationId, organizationId),
  ));
  return isCampaignType(row?.campaignType) ? row.campaignType : null;
}

export const TYPED_ROUTE_REFUSAL = "This campaign's routes come from its numbers, templates and speed. Change them in the campaign's Message and Delivery steps; manual routes and the legacy Rocket setup are only for campaigns created before campaign types.";
