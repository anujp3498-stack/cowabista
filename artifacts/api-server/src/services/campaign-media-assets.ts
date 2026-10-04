import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  campaignMediaAssetsTable,
  campaignMediaProviderBindingsTable,
  campaignsTable,
  campaignTemplateMappingsTable,
  db,
  type CampaignMediaAsset,
} from "@workspace/db";
import { configuredCampaignMediaStore } from "./campaign-media-storage";
import { hasExecutionHistory } from "./campaign-import-lifecycle";
import { MessageStudioError } from "./message-studio-errors";

// Campaign delivery media assets (V2-05B). Uploads come from the
// authenticated request body only (never a URL), are bounded per kind,
// checked by declared type AND leading bytes, and stored under a key the
// server generates. No provider call happens here.

export type CampaignMediaKind = "image" | "video" | "document";

// WhatsApp Cloud API media limits for these types (images 5 MB, video
// 16 MB, documents 100 MB).
export const CAMPAIGN_MEDIA_LIMITS: Record<string, { kind: CampaignMediaKind; maxBytes: number }> = {
  "image/jpeg": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "image/png": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "video/mp4": { kind: "video", maxBytes: 16 * 1024 * 1024 },
  "video/3gpp": { kind: "video", maxBytes: 16 * 1024 * 1024 },
  "application/pdf": { kind: "document", maxBytes: 100 * 1024 * 1024 },
};

const SAFE_FILE_NAME = /^[A-Za-z0-9._ ()-]{1,120}$/;

function leadingBytesMatch(contentType: string, head: Buffer): boolean {
  const at = (offset: number, ...bytes: number[]) => bytes.every((byte, index) => head[offset + index] === byte);
  switch (contentType) {
    case "image/jpeg": return at(0, 0xff, 0xd8, 0xff);
    case "image/png": return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "application/pdf": return at(0, 0x25, 0x50, 0x44, 0x46, 0x2d);
    case "video/mp4": return head.subarray(4, 8).toString("latin1") === "ftyp" && !head.subarray(8, 10).toString("latin1").startsWith("3g");
    case "video/3gpp": return head.subarray(4, 8).toString("latin1") === "ftyp" && head.subarray(8, 10).toString("latin1") === "3g";
    default: return false;
  }
}

export function serializeMediaAsset(row: CampaignMediaAsset) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    fileName: row.fileName,
    contentType: row.contentType,
    byteLength: row.byteLength,
    kind: row.kind as CampaignMediaKind,
    status: row.status as "ready" | "deleted",
    createdAt: row.createdAt,
  };
}

/**
 * Read-only editability for media writes: an unreferenced asset does not
 * change what a plan would send, so upload/delete never supersede a plan;
 * they only require a pre-execution campaign (Draft, or Ready with no jobs).
 */
async function assertMediaEditable(organizationId: number, campaignId: number): Promise<void> {
  const [campaign] = await db.select({ status: campaignsTable.status }).from(campaignsTable).where(and(
    eq(campaignsTable.id, campaignId),
    eq(campaignsTable.organizationId, organizationId),
  ));
  if (!campaign) throw new MessageStudioError("not_found", "Campaign not found", 404);
  if (!["Draft", "Ready"].includes(campaign.status)) {
    throw new MessageStudioError("setup_locked", `Media can only change while the campaign is a draft (current status: ${campaign.status})`, 409);
  }
  if (await hasExecutionHistory(db, organizationId, campaignId)) {
    throw new MessageStudioError("execution_history", "This campaign already has execution history; its media can no longer change", 409);
  }
}

export async function uploadCampaignMediaAsset(input: {
  organizationId: number;
  campaignId: number;
  userId: number | null;
  fileName: string;
  contentType: string;
  declaredLength: number | null;
  body: AsyncIterable<Buffer>;
}): Promise<ReturnType<typeof serializeMediaAsset>> {
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  const limit = CAMPAIGN_MEDIA_LIMITS[contentType];
  if (!limit) throw new MessageStudioError("media_invalid", "Unsupported file type. Use a JPEG or PNG image, an MP4 or 3GPP video, or a PDF document.", 400);
  const fileName = input.fileName.trim();
  if (!SAFE_FILE_NAME.test(fileName)) throw new MessageStudioError("media_invalid", "Use a simple file name (letters, numbers, dots, dashes, spaces, brackets).", 400);
  const tooLarge = () => new MessageStudioError("media_invalid", `${limit.kind === "image" ? "Images" : limit.kind === "video" ? "Videos" : "Documents"} must be at most ${Math.round(limit.maxBytes / 1024 / 1024)} MB.`, 400);
  if (input.declaredLength !== null && input.declaredLength > limit.maxBytes) throw tooLarge();
  await assertMediaEditable(input.organizationId, input.campaignId);
  const store = configuredCampaignMediaStore();
  if (!store) throw new MessageStudioError("media_storage_unavailable", "Media storage is not configured on this server.", 503);

  const storageKey = `organizations/${input.organizationId}/campaigns/${input.campaignId}/media/${randomUUID()}`;
  const hash = createHash("sha256");
  let byteLength = 0;
  let head = Buffer.alloc(0);
  let checkedHead = false;
  let failure: MessageStudioError | null = null;
  async function* checked(): AsyncGenerator<Buffer> {
    for await (const raw of input.body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      byteLength += chunk.length;
      if (byteLength > limit!.maxBytes) {
        failure = tooLarge();
        throw failure;
      }
      if (!checkedHead) {
        head = Buffer.concat([head, chunk]).subarray(0, 16);
        if (head.length >= 12) {
          checkedHead = true;
          if (!leadingBytesMatch(contentType, head)) {
            failure = new MessageStudioError("media_invalid", `The file's content is not a ${contentType} file.`, 400);
            throw failure;
          }
        }
      }
      hash.update(chunk);
      yield chunk;
    }
  }
  try {
    await store.put(storageKey, checked());
    if (!byteLength) throw new MessageStudioError("media_invalid", "The uploaded file is empty.", 400);
    if (!checkedHead && !leadingBytesMatch(contentType, head)) {
      throw new MessageStudioError("media_invalid", `The file's content is not a ${contentType} file.`, 400);
    }
  } catch (error) {
    await store.remove(storageKey).catch(() => undefined);
    if (failure) throw failure;
    throw error;
  }
  const [row] = await db.insert(campaignMediaAssetsTable).values({
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    fileName,
    contentType,
    byteLength,
    kind: limit.kind,
    storageKey,
    sha256: hash.digest("hex"),
    status: "ready",
    createdBy: input.userId,
  }).returning();
  return serializeMediaAsset(row!);
}

export async function listCampaignMediaAssets(organizationId: number, campaignId: number) {
  const rows = await db.select().from(campaignMediaAssetsTable).where(and(
    eq(campaignMediaAssetsTable.organizationId, organizationId),
    eq(campaignMediaAssetsTable.campaignId, campaignId),
    eq(campaignMediaAssetsTable.status, "ready"),
  )).orderBy(asc(campaignMediaAssetsTable.id));
  return rows.map(serializeMediaAsset);
}

/** One asset of this organization AND campaign (any status), or null. */
export async function loadCampaignMediaAsset(organizationId: number, campaignId: number, assetId: number): Promise<CampaignMediaAsset | null> {
  const [row] = await db.select().from(campaignMediaAssetsTable).where(and(
    eq(campaignMediaAssetsTable.id, assetId),
    eq(campaignMediaAssetsTable.organizationId, organizationId),
    eq(campaignMediaAssetsTable.campaignId, campaignId),
  ));
  return row ?? null;
}

export async function loadCampaignMediaAssets(organizationId: number, campaignId: number, assetIds: number[]): Promise<Map<number, CampaignMediaAsset>> {
  const ids = [...new Set(assetIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const rows = await db.select().from(campaignMediaAssetsTable).where(and(
    eq(campaignMediaAssetsTable.organizationId, organizationId),
    eq(campaignMediaAssetsTable.campaignId, campaignId),
    inArray(campaignMediaAssetsTable.id, ids),
  ));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function deleteCampaignMediaAsset(organizationId: number, campaignId: number, assetId: number): Promise<void> {
  const asset = await loadCampaignMediaAsset(organizationId, campaignId, assetId);
  if (!asset || asset.status !== "ready") throw new MessageStudioError("not_found", "Media not found in this campaign", 404);
  await assertMediaEditable(organizationId, campaignId);
  const [reference] = await db.select({ id: campaignTemplateMappingsTable.id }).from(campaignTemplateMappingsTable).where(and(
    eq(campaignTemplateMappingsTable.organizationId, organizationId),
    eq(campaignTemplateMappingsTable.campaignId, campaignId),
    eq(campaignTemplateMappingsTable.mediaAssetId, assetId),
  )).limit(1);
  if (reference) throw new MessageStudioError("media_in_use", "This file is still used by a template. Choose another file for it first.", 409);
  await db.transaction(async (tx) => {
    await tx.update(campaignMediaAssetsTable).set({ status: "deleted", deletedAt: new Date() }).where(eq(campaignMediaAssetsTable.id, asset.id));
    await tx.delete(campaignMediaProviderBindingsTable).where(eq(campaignMediaProviderBindingsTable.mediaAssetId, asset.id));
  });
  await configuredCampaignMediaStore()?.remove(asset.storageKey).catch(() => undefined);
}
