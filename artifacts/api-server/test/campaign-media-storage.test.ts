import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Readable } from "node:stream";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CampaignMediaStoreError,
  configuredCampaignMediaStore,
  LocalDiskMediaStore,
  createS3Client,
  describeCampaignMediaStorage,
  parseCampaignMediaStorageConfig,
  S3_MIN_PART_BYTES,
  S3MediaStore,
  type CampaignMediaStorageConfig,
} from "../src/services/campaign-media-storage";
import { startFakeS3 } from "./fake-s3-server";

// R-D2 (R1b): campaign media bytes live in an S3-compatible bucket (MinIO on the dedicated servers) selected
// explicitly with CAMPAIGN_MEDIA_STORAGE; local disk stays for development and tests only. No database. The
// store contract runs against an in-process fake S3 and, when CAMPAIGN_TEST_S3_ENDPOINT points at a local S3
// emulator (moto, MinIO), against that too. Never a real bucket.

const SECRET = `test-secret-${randomBytes(12).toString("hex")}`;
const ACCESS_KEY = `test-access-${randomBytes(6).toString("hex")}`;
const s3Env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  CAMPAIGN_MEDIA_STORAGE: "s3",
  CAMPAIGN_MEDIA_S3_BUCKET: "wabista-media",
  CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID: ACCESS_KEY,
  CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY: SECRET,
  ...extra,
});
const key = () => `organizations/1/campaigns/2/media/${randomUUID()}`;
const MiB = 1024 * 1024;

async function* chunked(bytes: Buffer, size = 64 * 1024): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function assertSafeMessage(error: unknown, ...forbidden: string[]) {
  const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
  for (const value of forbidden) assert.ok(!text.includes(value), `the error must not carry ${value}`);
}

describe("CAMPAIGN_MEDIA_STORAGE configuration", () => {
  test("unset means no storage; a stray setting without the selector is refused", () => {
    assert.deepEqual(parseCampaignMediaStorageConfig({}), { kind: "none" });
    assert.deepEqual(parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE: "  " }), { kind: "none" });
    assert.deepEqual(parseCampaignMediaStorageConfig({ PRIVATE_OBJECT_DIR: "/replit/objects" }), { kind: "none" }, "the retired sidecar setting is ignored");
    assert.throws(() => parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE_DIR: "/tmp/media" }), /CAMPAIGN_MEDIA_STORAGE_DIR is set but CAMPAIGN_MEDIA_STORAGE is not/);
    assert.throws(() => parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_S3_BUCKET: "wabista-media" }), /CAMPAIGN_MEDIA_S3_BUCKET is set but CAMPAIGN_MEDIA_STORAGE is not/);
    assert.throws(() => parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE: "gcs" }), /must be local or s3/);
  });

  test("local needs an absolute directory, takes no S3 settings and is refused in production", () => {
    assert.deepEqual(parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE: "local", CAMPAIGN_MEDIA_STORAGE_DIR: "/srv/media" }), { kind: "local", dir: "/srv/media" });
    assert.throws(() => parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE: "local" }), /absolute directory/);
    assert.throws(() => parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE: "local", CAMPAIGN_MEDIA_STORAGE_DIR: "media" }), /absolute directory/);
    assert.throws(() => parseCampaignMediaStorageConfig({ CAMPAIGN_MEDIA_STORAGE: "local", CAMPAIGN_MEDIA_STORAGE_DIR: "/srv/media", CAMPAIGN_MEDIA_S3_BUCKET: "b-1" }), /CAMPAIGN_MEDIA_S3_BUCKET is set but CAMPAIGN_MEDIA_STORAGE=local/);
    assert.throws(() => parseCampaignMediaStorageConfig({ NODE_ENV: "production", CAMPAIGN_MEDIA_STORAGE: "local", CAMPAIGN_MEDIA_STORAGE_DIR: "/srv/media" }), /refused in production/);
  });

  test("s3 needs a bucket and explicit credentials; no message ever echoes the secret or the key id", () => {
    const parsed = parseCampaignMediaStorageConfig(s3Env());
    assert.deepEqual(parsed, { kind: "s3", endpoint: undefined, region: "us-east-1", bucket: "wabista-media", prefix: "campaign-media", forcePathStyle: false, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET });
    for (const missing of ["CAMPAIGN_MEDIA_S3_BUCKET", "CAMPAIGN_MEDIA_S3_ACCESS_KEY_ID", "CAMPAIGN_MEDIA_S3_SECRET_ACCESS_KEY"]) {
      const env = s3Env();
      delete env[missing];
      assert.throws(() => parseCampaignMediaStorageConfig(env), (error: Error) => {
        assert.match(error.message, new RegExp(`needs ${missing}`));
        assertSafeMessage(error, SECRET, ACCESS_KEY);
        return true;
      });
    }
    assert.throws(() => parseCampaignMediaStorageConfig(s3Env({ CAMPAIGN_MEDIA_STORAGE_DIR: "/srv/media" })), /CAMPAIGN_MEDIA_STORAGE_DIR is set but CAMPAIGN_MEDIA_STORAGE=s3/);
    assert.equal((parseCampaignMediaStorageConfig({ ...s3Env(), NODE_ENV: "production" }) as { kind: string }).kind, "s3", "s3 is the production backend");
  });

  test("endpoint, region, bucket, prefix and path-style settings are validated strictly", () => {
    const parse = (extra: Record<string, string>) => parseCampaignMediaStorageConfig(s3Env(extra)) as Extract<CampaignMediaStorageConfig, { kind: "s3" }>;
    const minio = parse({ CAMPAIGN_MEDIA_S3_ENDPOINT: "http://10.0.0.9:9000/" });
    assert.equal(minio.endpoint, "http://10.0.0.9:9000");
    assert.equal(minio.forcePathStyle, true, "a custom endpoint (MinIO) defaults to path-style addressing");
    assert.equal(parse({ CAMPAIGN_MEDIA_S3_ENDPOINT: "https://minio.internal:9000", CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE: "false" }).forcePathStyle, false);
    for (const endpoint of ["minio.internal:9000", "ftp://minio.internal", "https://minio.internal/bucket", "https://minio.internal?x=1", "not a url"]) {
      assert.throws(() => parse({ CAMPAIGN_MEDIA_S3_ENDPOINT: endpoint }), /CAMPAIGN_MEDIA_S3_ENDPOINT must be a full http\(s\) origin/, endpoint);
    }
    assert.throws(() => parse({ CAMPAIGN_MEDIA_S3_ENDPOINT: `https://user:${SECRET}@minio.internal` }), (error: Error) => {
      assertSafeMessage(error, SECRET);
      return /must be a full http\(s\) origin/.test(error.message);
    }, "credentials in the endpoint are refused without echoing them");
    assert.throws(() => parse({ CAMPAIGN_MEDIA_S3_FORCE_PATH_STYLE: "yes" }), /must be true or false/);
    assert.throws(() => parse({ CAMPAIGN_MEDIA_S3_REGION: "US East" }), /not a valid region/);
    assert.equal(parse({ CAMPAIGN_MEDIA_S3_REGION: "ap-south-1" }).region, "ap-south-1");
    for (const bucket of ["Wabista_Media", "ab", "-wabista", "wabista/media"]) {
      assert.throws(() => parse({ CAMPAIGN_MEDIA_S3_BUCKET: bucket }), /not a valid bucket name/, bucket);
    }
    assert.equal(parse({ CAMPAIGN_MEDIA_S3_PREFIX: "" }).prefix, "", "an explicitly empty prefix stores at the bucket root");
    assert.equal(parse({ CAMPAIGN_MEDIA_S3_PREFIX: "cell-a/campaign-media" }).prefix, "cell-a/campaign-media");
    for (const prefix of ["/campaign-media", "campaign-media/", "a/../b", "a//b", "a b"]) {
      assert.throws(() => parse({ CAMPAIGN_MEDIA_S3_PREFIX: prefix }), /CAMPAIGN_MEDIA_S3_PREFIX must be path segments/, prefix);
    }
  });

  test("the startup description carries no credentials; the store is built once per configuration", () => {
    const described = describeCampaignMediaStorage(s3Env({ CAMPAIGN_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000" }));
    assert.deepEqual(described, { kind: "s3", endpoint: "http://127.0.0.1:9000", region: "us-east-1", bucket: "wabista-media", prefix: "campaign-media", forcePathStyle: true });
    assertSafeMessage(new Error(JSON.stringify(described)), SECRET, ACCESS_KEY);
    assert.deepEqual(describeCampaignMediaStorage({}), { kind: "none" });
    assert.throws(() => describeCampaignMediaStorage({ CAMPAIGN_MEDIA_STORAGE: "s3" }), /needs CAMPAIGN_MEDIA_S3_BUCKET/, "startup refuses a half-configured server");

    const env = s3Env({ CAMPAIGN_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000" });
    const first = configuredCampaignMediaStore(env);
    assert.equal(first?.kind, "s3");
    assert.equal(configuredCampaignMediaStore({ ...env }), first, "the same configuration reuses one client and its connection pool");
    assert.notEqual(configuredCampaignMediaStore({ ...env, CAMPAIGN_MEDIA_S3_PREFIX: "other" }), first);
    assert.equal(configuredCampaignMediaStore({ CAMPAIGN_MEDIA_STORAGE: "local", CAMPAIGN_MEDIA_STORAGE_DIR: "/tmp/wabista-media-test" })?.kind, "local_disk");
    assert.equal(configuredCampaignMediaStore({}), null);
  });
});

type Target = { name: string; store: (partBytes?: number) => S3MediaStore; bucket: string; endpoint: string; close: () => Promise<void> };

function clientFor(endpoint: string, bucket: string) {
  return createS3Client({ kind: "s3", endpoint, region: "us-east-1", bucket, prefix: "campaign-media", forcePathStyle: true, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET });
}

/** The store contract both the fake and an S3 emulator must satisfy. */
function storeContract(target: () => Target) {
  test("a small body is stored, read back, streamed and removed (remove is idempotent)", async () => {
    const store = target().store();
    const id = key();
    const bytes = randomBytes(4096);
    await store.put(id, chunked(bytes, 1000));
    assert.ok((await store.read(id, bytes.length)).equals(bytes));
    assert.ok((await collect(store.stream(id))).equals(bytes));
    await store.remove(id);
    await store.remove(id);
    await assert.rejects(store.read(id, bytes.length), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "not_found");
  });

  test("a body larger than one part goes up as a multipart upload and round-trips byte for byte", async () => {
    const store = target().store(S3_MIN_PART_BYTES);
    const id = key();
    const bytes = randomBytes(11 * MiB + 123);
    await store.put(id, chunked(bytes));
    const back = await store.read(id, bytes.length);
    assert.equal(createHash("sha256").update(back).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assert.ok((await collect(store.stream(id))).equals(bytes));
    await store.remove(id);
  });

  test("read enforces the byte cap; a missing object is not_found with a message naming no bucket, key or endpoint", async () => {
    const { bucket, endpoint } = target();
    const store = target().store();
    const id = key();
    await store.put(id, chunked(randomBytes(2048)));
    await assert.rejects(store.read(id, 2047), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "too_large");
    await store.remove(id);
    const missing = key();
    await assert.rejects(store.read(missing, 10), (error: unknown) => {
      assert.ok(error instanceof CampaignMediaStoreError && error.code === "not_found");
      assertSafeMessage(error, bucket, missing, endpoint, SECRET, ACCESS_KEY);
      return true;
    });
    await assert.rejects(collect(store.stream(missing)), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "not_found", "a stream of a missing object errors before any data");
  });

  test("an error from the body (a size or content check) aborts the multipart upload, leaves no object and is rethrown unchanged", async () => {
    const store = target().store(S3_MIN_PART_BYTES);
    const id = key();
    const refusal = new Error("Documents must be at most 100 MB.");
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(S3_MIN_PART_BYTES + 10);
      throw refusal;
    }
    await assert.rejects(store.put(id, failing()), (error: unknown) => error === refusal);
    await assert.rejects(store.read(id, 100 * MiB), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "not_found");
  });

  test("keys are checked before any request", async () => {
    const store = target().store();
    for (const bad of ["../etc/passwd", "organizations/1/campaigns/2/media/../../x", "campaign-media/organizations/1"]) {
      await assert.rejects(store.put(bad, chunked(Buffer.from("x"))), /Invalid campaign media storage key/);
      await assert.rejects(store.read(bad, 1), /Invalid campaign media storage key/);
      assert.throws(() => store.stream(bad), /Invalid campaign media storage key/);
      await assert.rejects(store.remove(bad), /Invalid campaign media storage key/);
    }
  });
}

describe("S3MediaStore against the in-process fake S3", () => {
  let fake: Awaited<ReturnType<typeof startFakeS3>>;
  const bucket = "wabista-test";
  before(async () => { fake = await startFakeS3({ bucket }); });
  after(async () => { await fake.close(); });
  const target = (): Target => ({ name: "fake", bucket, endpoint: fake.endpoint, store: (partBytes) => new S3MediaStore(clientFor(fake.endpoint, bucket), bucket, "campaign-media", partBytes), close: async () => undefined });

  storeContract(target);

  test("a small body is ONE signed PutObject with an explicit length under the prefix; nothing is chunk-encoded", async () => {
    const store = target().store();
    const id = key();
    const bytes = randomBytes(3000);
    const before = fake.requests.length;
    await store.put(id, chunked(bytes, 700));
    const sent = fake.requests.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.method, "PUT");
    assert.equal(sent[0]!.path, `/${bucket}/campaign-media/${id}`);
    assert.ok(!sent[0]!.query.has("uploads") && !sent[0]!.query.has("uploadId"));
    assert.equal(sent[0]!.headers["content-length"], String(bytes.length));
    assert.equal(sent[0]!.headers["cache-control"], "private, no-store");
    assert.ok(String(sent[0]!.headers.authorization).startsWith("AWS4-HMAC-SHA256 Credential="), "SigV4 signed");
    assert.ok(!String(sent[0]!.headers.authorization).includes(SECRET), "the secret never travels");
    assert.ok(!String(sent[0]!.headers["content-encoding"] ?? "").includes("aws-chunked"));
    assert.ok(fake.objects.get(`campaign-media/${id}`)!.equals(bytes));
  });

  test("multipart: create, sequential parts of the configured size, complete; no upload left open", async () => {
    const store = target().store(S3_MIN_PART_BYTES);
    const id = key();
    const before = fake.requests.length;
    await store.put(id, chunked(randomBytes(2 * S3_MIN_PART_BYTES + 7)));
    const sent = fake.requests.slice(before).map((r) => `${r.method} ${r.query.has("uploads") ? "uploads" : r.query.has("partNumber") ? `part${r.query.get("partNumber")}:${r.bodyBytes}` : r.query.has("uploadId") ? "complete" : "object"}`);
    assert.deepEqual(sent, ["POST uploads", `PUT part1:${S3_MIN_PART_BYTES}`, `PUT part2:${S3_MIN_PART_BYTES}`, "PUT part3:7", "POST complete"]);
    assert.equal(fake.uploads.size, 0);
  });

  test("a body error after the first part sends AbortMultipartUpload", async () => {
    const store = target().store(S3_MIN_PART_BYTES);
    const before = fake.requests.length;
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(S3_MIN_PART_BYTES);
      throw new Error("too large");
    }
    await assert.rejects(store.put(key(), failing()), /too large/);
    const sent = fake.requests.slice(before);
    assert.equal(sent.at(-1)!.method, "DELETE");
    assert.ok(sent.at(-1)!.query.has("uploadId"), "the open upload is aborted");
    assert.equal(fake.uploads.size, 0);
  });

  test("a storage failure mid-upload is a fixed 'unavailable' error (no endpoint, bucket or key) and the upload is aborted", async () => {
    const failing = await startFakeS3({ bucket, failPutAfterParts: 1 });
    try {
      const store = new S3MediaStore(clientFor(failing.endpoint, bucket), bucket, "campaign-media", S3_MIN_PART_BYTES);
      const id = key();
      await assert.rejects(store.put(id, chunked(randomBytes(2 * S3_MIN_PART_BYTES + 1))), (error: unknown) => {
        assert.ok(error instanceof CampaignMediaStoreError && error.code === "unavailable");
        assert.equal((error as Error).message, "Campaign media storage is unavailable");
        assertSafeMessage(error, failing.endpoint, bucket, id, SECRET);
        return true;
      });
      assert.equal(failing.uploads.size, 0, "aborted");
      assert.equal(failing.objects.size, 0);
    } finally {
      await failing.close();
    }
  });

  test("a missing bucket is a storage fault ('unavailable'), never reported as a lost file", async () => {
    const store = new S3MediaStore(clientFor(fake.endpoint, "no-such-bucket"), "no-such-bucket", "campaign-media");
    const id = key();
    await assert.rejects(store.read(id, 10), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "unavailable");
    await assert.rejects(collect(store.stream(id)), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "unavailable");
    await assert.rejects(store.remove(id), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "unavailable");
  });

  test("an unreachable endpoint is 'unavailable' for every operation, with a fixed message", async () => {
    const gone = await startFakeS3({ bucket });
    const endpoint = gone.endpoint;
    await gone.close();
    const store = new S3MediaStore(clientFor(endpoint, bucket), bucket, "campaign-media");
    const id = key();
    const unavailable = (error: unknown) => {
      assert.ok(error instanceof CampaignMediaStoreError && error.code === "unavailable", String(error));
      assertSafeMessage(error, endpoint, "127.0.0.1", id);
      return true;
    };
    await assert.rejects(store.put(id, chunked(Buffer.from("bytes"))), unavailable);
    await assert.rejects(store.read(id, 10), unavailable);
    await assert.rejects(collect(store.stream(id)), unavailable);
    await assert.rejects(store.remove(id), unavailable);
  });
});

const emulator = process.env.CAMPAIGN_TEST_S3_ENDPOINT;
describe("S3MediaStore against a local S3 emulator (CAMPAIGN_TEST_S3_ENDPOINT)", { skip: emulator ? false : "CAMPAIGN_TEST_S3_ENDPOINT is not set" }, () => {
  const bucket = `wabista-test-${randomBytes(4).toString("hex")}`;
  before(async () => {
    const url = new URL(emulator!);
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname), "the emulator must be local");
    await clientFor(url.origin, bucket).send(new CreateBucketCommand({ Bucket: bucket }));
  });
  const target = (): Target => ({ name: "emulator", bucket, endpoint: new URL(emulator!).origin, store: (partBytes) => new S3MediaStore(clientFor(new URL(emulator!).origin, bucket), bucket, "campaign-media", partBytes), close: async () => undefined });
  storeContract(target);
});

describe("LocalDiskMediaStore (development and tests)", () => {
  test("raises the same typed errors as the S3 store: not_found for a missing file, too_large over the cap", async () => {
    const store = new LocalDiskMediaStore(mkdtempSync(path.join(os.tmpdir(), "campaign-media-local-")));
    const id = key();
    await assert.rejects(store.read(id, 10), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "not_found");
    await store.put(id, chunked(Buffer.from("0123456789")));
    await assert.rejects(store.read(id, 9), (error: unknown) => error instanceof CampaignMediaStoreError && error.code === "too_large");
    assert.equal((await store.read(id, 10)).toString(), "0123456789");
    await store.remove(id);
    await store.remove(id);
  });
});
