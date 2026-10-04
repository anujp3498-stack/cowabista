import { createHash } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  campaignMediaAssetsTable,
  campaignMediaProviderBindingsTable,
  db,
  type CampaignMediaAsset,
} from "@workspace/db";
import { configuredCampaignMediaStore } from "./campaign-media-storage";
import { ManualMetaClient, type FetchLike } from "./whatsapp-manual-client";
import { directGraphBaseUrl } from "./whatsapp-direct-sender";
import { ProviderRequestError } from "./whatsapp-provider";
import { resolveSendingCredential, SendingCredentialUnavailableError } from "./whatsapp-transport-credentials";
import type { TransportKind } from "./template-eligibility";
import { MessageStudioError } from "./message-studio-errors";

// Provider media ids for campaign media assets (V2-05B), bound per asset
// AND sending number, server-side only.
//
// Meta's media endpoint is per phone number (/{phone-number-id}/media) and
// its ids expire (30 days per the Cloud API reference), so an id is never
// assumed to work for another number, business account or credential.
// Bindings are created by plan-time preparation (inside the campaign
// lifecycle lock, before the plan is frozen) and by test send; send
// preparation only READS them (attachProviderMedia) and fails closed when
// one is missing or expired. A frozen plan carries the asset id, never a
// provider id, a token or an upload handle.

export const MEDIA_BINDING_TTL_MS = 29 * 24 * 60 * 60 * 1000;
/** A binding is reused at preparation only if it still has this long to live. */
export const MEDIA_BINDING_REUSE_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export type MediaBindingPhone = {
  id: number;
  organizationId: number;
  wabaId: number | null;
  providerPhoneId: string | null;
  sendingCredentialId: number | null;
};

let fetchOverride: FetchLike | undefined;
/** Tests only: route provider media uploads to a fake. */
export function setMediaUploadFetchForTests(fetchImpl: FetchLike | undefined): void {
  fetchOverride = fetchImpl;
}

function mockMediaId(asset: CampaignMediaAsset, phoneId: number): string {
  return `mock-media-${createHash("sha256").update(`${asset.id}:${phoneId}:${asset.sha256}`).digest("hex").slice(0, 24)}`;
}

/**
 * Returns a provider media id usable by `phone` for `asset`, uploading the
 * bytes once if no valid binding exists. Called only from the management
 * plane (planning, test send). Errors are MessageStudioError with a stable
 * code and no secret in the text.
 */
export async function ensureMediaBinding(input: {
  organizationId: number;
  asset: CampaignMediaAsset;
  phone: MediaBindingPhone;
  transport: TransportKind;
  now?: Date;
}): Promise<string> {
  const { asset, phone } = input;
  const now = input.now ?? new Date();
  if (asset.organizationId !== input.organizationId || phone.organizationId !== input.organizationId) {
    throw new MessageStudioError("not_found", "Media or number not found in this workspace", 404);
  }
  if (asset.status !== "ready") throw new MessageStudioError("media_unavailable", `${asset.fileName} is no longer available`, 409);
  if (input.transport === "legacy_connector") {
    throw new MessageStudioError("media_unsupported_transport", "Campaign media files need a number connected with its own workspace credential; the shared connector cannot upload them.", 409);
  }
  let credentialRevision: number | null = null;
  let accessToken: string | null = null;
  if (input.transport === "workspace_credential") {
    if (phone.sendingCredentialId === null || !phone.providerPhoneId) {
      throw new MessageStudioError("credential_inactive", "The number has no active sending credential", 409);
    }
    try {
      const credential = await resolveSendingCredential(input.organizationId, phone.sendingCredentialId);
      credentialRevision = credential.credentialRevision;
      accessToken = credential.accessToken;
    } catch (error) {
      if (error instanceof SendingCredentialUnavailableError) throw new MessageStudioError("credential_inactive", "The number's workspace sending credential is not active", 409);
      throw error;
    }
  }
  const [existing] = await db.select().from(campaignMediaProviderBindingsTable).where(and(
    eq(campaignMediaProviderBindingsTable.mediaAssetId, asset.id),
    eq(campaignMediaProviderBindingsTable.phoneNumberId, phone.id),
  ));
  if (
    existing
    && existing.sha256 === asset.sha256
    && existing.transport === input.transport
    && existing.credentialId === (input.transport === "workspace_credential" ? phone.sendingCredentialId : null)
    && existing.credentialRevision === credentialRevision
    && existing.expiresAt.getTime() > now.getTime() + MEDIA_BINDING_REUSE_MARGIN_MS
  ) {
    return existing.providerMediaId;
  }

  let providerMediaId: string;
  if (input.transport === "local_mock") {
    providerMediaId = mockMediaId(asset, phone.id);
  } else {
    const store = configuredCampaignMediaStore();
    if (!store) throw new MessageStudioError("media_storage_unavailable", "Media storage is not configured on this server.", 503);
    const bytes = await store.read(asset.storageKey, asset.byteLength);
    const client = new ManualMetaClient({ accessToken: accessToken!, baseUrl: directGraphBaseUrl(), fetchImpl: fetchOverride });
    try {
      providerMediaId = await client.uploadMessageMedia(phone.providerPhoneId!, { bytes, contentType: asset.contentType, fileName: asset.fileName });
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        if (error.code === "190" || error.status === 401) throw new MessageStudioError("credential_inactive", "Meta rejected the workspace credential. Reconnect it in Number Center.", 409);
        throw new MessageStudioError(error.retryable ? "provider_unavailable" : "media_preparation_failed", `Meta did not accept ${asset.fileName}: ${error.message}`, 502);
      }
      throw error;
    }
  }
  const values = {
    organizationId: input.organizationId,
    mediaAssetId: asset.id,
    phoneNumberId: phone.id,
    wabaId: phone.wabaId,
    transport: input.transport,
    providerMediaId,
    credentialId: input.transport === "workspace_credential" ? phone.sendingCredentialId : null,
    credentialRevision,
    sha256: asset.sha256,
    uploadedAt: now,
    expiresAt: new Date(now.getTime() + MEDIA_BINDING_TTL_MS),
  };
  await db.insert(campaignMediaProviderBindingsTable).values(values).onConflictDoUpdate({
    target: [campaignMediaProviderBindingsTable.mediaAssetId, campaignMediaProviderBindingsTable.phoneNumberId],
    set: { ...values, updatedAt: now },
  });
  return providerMediaId;
}

/**
 * Send-preparation side: fills `resolved.headerMedia.id` for each item from
 * an existing, unexpired binding of a ready asset for the item's sending
 * number, in ONE query for the batch. Returns, per item, null on success
 * or the error that must fail that job (never a substitute).
 */
export async function attachProviderMedia(
  organizationId: number,
  items: Array<{ resolved: { headerMedia?: { assetId: string; id?: string } }; phoneNumberId: number | null }>,
  now: Date = new Date(),
): Promise<Array<Error | null>> {
  const wanted = items.map((item) => ({ assetId: Number(item.resolved.headerMedia?.assetId), phoneNumberId: item.phoneNumberId }));
  const assetIds = [...new Set(wanted.flatMap((w) => (Number.isInteger(w.assetId) && w.assetId > 0 ? [w.assetId] : [])))];
  const phoneIds = [...new Set(wanted.flatMap((w) => (w.phoneNumberId === null ? [] : [w.phoneNumberId])))];
  const rows = assetIds.length && phoneIds.length
    ? await db.select({
      mediaAssetId: campaignMediaProviderBindingsTable.mediaAssetId,
      phoneNumberId: campaignMediaProviderBindingsTable.phoneNumberId,
      providerMediaId: campaignMediaProviderBindingsTable.providerMediaId,
    }).from(campaignMediaProviderBindingsTable)
      .innerJoin(campaignMediaAssetsTable, and(
        eq(campaignMediaAssetsTable.id, campaignMediaProviderBindingsTable.mediaAssetId),
        eq(campaignMediaAssetsTable.organizationId, campaignMediaProviderBindingsTable.organizationId),
        eq(campaignMediaAssetsTable.status, "ready"),
        eq(campaignMediaAssetsTable.sha256, campaignMediaProviderBindingsTable.sha256),
      ))
      .where(and(
        eq(campaignMediaProviderBindingsTable.organizationId, organizationId),
        inArray(campaignMediaProviderBindingsTable.mediaAssetId, assetIds),
        inArray(campaignMediaProviderBindingsTable.phoneNumberId, phoneIds),
        gt(campaignMediaProviderBindingsTable.expiresAt, now),
      ))
    : [];
  const byPair = new Map(rows.map((row) => [`${row.mediaAssetId}:${row.phoneNumberId}`, row.providerMediaId]));
  return items.map((item, index) => {
    const want = wanted[index]!;
    const id = want.phoneNumberId === null ? undefined : byPair.get(`${want.assetId}:${want.phoneNumberId}`);
    if (!id) return new Error(`Campaign media ${item.resolved.headerMedia?.assetId ?? "?"} is not prepared for this sending number; plan the campaign again`);
    item.resolved.headerMedia!.id = id;
    return null;
  });
}
