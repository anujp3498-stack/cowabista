// Shared fixtures for the V2-05B Message Studio suites (not a suite itself).
// Everything is created inside a fresh organization the caller deletes.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import {
  campaignContactsTable,
  campaignsTable,
  contactImportSessionsTable,
  db,
  organizationsTable,
  phoneNumbersTable,
  providerConnectionsTable,
  templatesTable,
  wabasTable,
  whatsappCredentialsTable,
} from "@workspace/db";
import { credentialFingerprint, encryptCredential } from "../src/services/credential-crypto";
import { backfillTemplateEligibility } from "../src/services/template-eligibility";
import { LocalDiskMediaStore, setCampaignMediaStoreForTests } from "../src/services/campaign-media-storage";

export const TOKEN = `EAAG-studio-${randomBytes(16).toString("hex")}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findRouteHandler(router: any, routePath: string, method: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No handler registered for ${method.toUpperCase()} ${routePath}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fakeResponse(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, chunks: [] as Buffer[], ended: false, headersSent: false };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; res.ended = true; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; };
  res.write = (chunk: Buffer | string) => { res.chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk?: Buffer | string) => { if (chunk) res.chunks.push(Buffer.from(chunk)); res.ended = true; return res; };
  res.on = () => res; res.once = () => res; res.emit = () => true; res.removeListener = () => res;
  res.destroy = () => undefined;
  return res;
}

/** A request whose body is a byte stream (media upload). */
export function streamRequest(bytes: Buffer, extra: Record<string, unknown>) {
  const req = Readable.from([bytes]) as Readable & Record<string, unknown>;
  Object.assign(req, { log: { warn() {}, info() {}, error() {} }, ...extra });
  return req;
}

export function useLocalMediaStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "campaign-media-"));
  const store = new LocalDiskMediaStore(dir);
  setCampaignMediaStoreForTests(store);
  return store;
}

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-fake-image-bytes-for-tests")]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake-jpeg-bytes-for-tests-0123")]);
export const PDF = Buffer.from("%PDF-1.4 fake document bytes for tests");
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom-fake-video-bytes")]);

export type GraphRequest = { method: string; url: string; authorization?: string; contentType?: string; body: Buffer };

/** Fake Meta Graph API (never the real one): /media and /messages. */
export async function startFakeGraph(options: { messageStatus?: number; mediaStatus?: number } = {}) {
  const requests: GraphRequest[] = [];
  let mediaCounter = 0;
  let messageCounter = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, contentType: req.headers["content-type"], body: Buffer.concat(chunks) });
      res.setHeader("content-type", "application/json");
      if ((req.url ?? "").endsWith("/media")) {
        if (options.mediaStatus && options.mediaStatus !== 200) {
          res.writeHead(options.mediaStatus);
          res.end(JSON.stringify({ error: { message: "media refused", code: 100 } }));
          return;
        }
        res.end(JSON.stringify({ id: `media-${++mediaCounter}` }));
        return;
      }
      if ((req.url ?? "").endsWith("/messages")) {
        if (options.messageStatus && options.messageStatus !== 200) {
          res.writeHead(options.messageStatus);
          res.end(JSON.stringify({ error: { message: "template paused", code: 132015 } }));
          return;
        }
        res.end(JSON.stringify({ messages: [{ id: `wamid.test.${++messageCounter}` }] }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.CAMPAIGN_TEST_GRAPH_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    requests,
    close: async () => {
      delete process.env.CAMPAIGN_TEST_GRAPH_BASE_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function createOrganization(slug: string) {
  const [organization] = await db.insert(organizationsTable).values({ name: slug, slug }).returning();
  return organization!;
}

export async function deleteOrganization(id: number) {
  await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
}

type TemplateSpec = { name: string; body: string; components?: Record<string, unknown>[]; providerBacked?: boolean; status?: string };

/**
 * A workspace-credential world: one encrypted active credential, one WABA
 * bound to it, `phones` connected numbers sending with it, and provider-
 * backed templates verified by the eligibility backfill.
 */
export async function workspaceWorld(slug: string, options: { phones?: number; templates: TemplateSpec[]; secondWaba?: boolean }) {
  const organization = await createOrganization(slug);
  const enc = encryptCredential(TOKEN, { organizationId: organization.id, kind: "manual_token", provider: "whatsapp-business" });
  const [credential] = await db.insert(whatsappCredentialsTable).values({
    organizationId: organization.id, tokenCiphertext: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, keyVersion: enc.keyVersion,
    tokenFingerprint: credentialFingerprint(TOKEN), status: "active",
  }).returning();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `waba-${slug}`, displayName: "Main account", credentialId: credential!.id }).returning();
  const phones = [];
  for (let index = 0; index < (options.phones ?? 1); index++) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba!.id, providerPhoneId: `pp-${slug}-${index}`, phone: `+1555${String(organization.id).padStart(5, "0")}${index}0`,
      displayName: `Sender ${index + 1}`, status: "Connected", setupState: "active", tpsLimit: 40,
      credentialId: credential!.id, sendingCredentialId: credential!.id,
    }).returning();
    phones.push(phone!);
  }
  let otherWaba: typeof waba | undefined;
  if (options.secondWaba) {
    [otherWaba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `waba2-${slug}`, displayName: "Other account", credentialId: credential!.id }).returning();
  }
  const templates = [];
  for (const [index, spec] of options.templates.entries()) {
    const [template] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba!.id,
      providerTemplateId: spec.providerBacked === false ? null : `tpl-${slug}-${index}`,
      metadata: { source: "workspace_credential", providerStatus: "APPROVED" },
      name: spec.name, status: spec.status ?? "Approved", language: "en_US", category: "Marketing",
      body: spec.body, components: spec.components ?? [{ type: "BODY", text: spec.body }],
    }).returning();
    templates.push(template!);
  }
  await backfillTemplateEligibility(organization.id);
  return { organization, credential: credential!, waba: waba!, otherWaba, phones, templates };
}

/** A local/mock world (no credential, mock connection), provider-backed templates. */
export async function mockWorld(slug: string, options: { phones?: number; templates: TemplateSpec[] }) {
  const organization = await createOrganization(slug);
  await db.insert(providerConnectionsTable).values({ organizationId: organization.id, provider: "whatsapp-business", mode: "mock", status: "configured" }).onConflictDoNothing();
  const [waba] = await db.insert(wabasTable).values({ organizationId: organization.id, externalId: `waba-${slug}`, displayName: "Mock account" }).returning();
  const phones = [];
  for (let index = 0; index < (options.phones ?? 1); index++) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: organization.id, wabaId: waba!.id, providerPhoneId: `mock-pp-${slug}-${index}`, phone: `+1666${String(organization.id).padStart(5, "0")}${index}0`,
      displayName: `Mock ${index + 1}`, status: "Connected", setupState: "active", tpsLimit: 20,
    }).returning();
    phones.push(phone!);
  }
  const templates = [];
  for (const [index, spec] of options.templates.entries()) {
    const [template] = await db.insert(templatesTable).values({
      organizationId: organization.id, wabaId: waba!.id,
      providerTemplateId: spec.providerBacked === false ? null : `mock-tpl-${slug}-${index}`,
      name: spec.name, status: spec.status ?? "Approved", language: "en_US", category: "Marketing",
      body: spec.body, components: spec.components ?? [{ type: "BODY", text: spec.body }],
    }).returning();
    templates.push(template!);
  }
  return { organization, waba: waba!, phones, templates };
}

export async function createCampaign(organizationId: number, name: string, status = "Draft") {
  const [campaign] = await db.insert(campaignsTable).values({ organizationId, name, status }).returning();
  return campaign!;
}

/** A completed import (active generation 0) with these columns and rows. */
export async function seedAudience(organizationId: number, campaignId: number, columns: string[], rows: Array<Record<string, string>>, options: { generation?: number; key?: string } = {}) {
  const [session] = await db.insert(contactImportSessionsTable).values({
    organizationId, campaignId, idempotencyKey: options.key ?? `aud-${campaignId}-${randomBytes(4).toString("hex")}`, fileName: "audience.csv",
    status: "Completed", columns, rowsProcessed: rows.length + 1, validRows: rows.length, audienceGeneration: options.generation ?? 0,
  }).returning();
  const contacts = rows.length ? await db.insert(campaignContactsTable).values(rows.map((data, index) => ({
    organizationId, campaignId, importSessionId: session!.id, rowNumber: index + 2,
    rawPhone: data.phone, normalizedPhone: data.phone, data, status: "Valid", audienceGeneration: options.generation ?? 0,
    idempotencyKey: `${session!.id}-${index}-${data.phone}`,
  }))).returning() : [];
  return { session: session!, contacts };
}

export const HEADER_IMAGE = (body: string, extra: Record<string, unknown>[] = []) => [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: body }, ...extra];
export const HEADER_VIDEO = (body: string) => [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: body }];
export const HEADER_DOCUMENT = (body: string) => [{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: body }];
