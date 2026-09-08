import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// App Storage's GCS client authenticates through Replit's local sidecar.
export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function privateObjectDirectory(): string {
  const directory = process.env.PRIVATE_OBJECT_DIR?.replace(/\/+$/, "");
  if (!directory) {
    throw new Error("PRIVATE_OBJECT_DIR is not configured");
  }
  return directory;
}

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  const parts = `/${path.replace(/^\/+/, "")}`.split("/");
  if (parts.length < 3 || !parts[1] || !parts[2]) {
    throw new Error("Invalid private object storage path");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

export async function createPrivateUploadUrl(
  relativeObjectPath: string,
): Promise<{ uploadURL: string; objectPath: string }> {
  const normalizedRelativePath = relativeObjectPath.replace(/^\/+/, "");
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDirectory()}/${normalizedRelativePath}`,
  );
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method: "PUT",
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to sign object upload URL (${response.status})`);
  }
  const data = await response.json() as { signed_url?: unknown };
  if (typeof data.signed_url !== "string") {
    throw new Error("Object storage returned an invalid signed URL");
  }
  return {
    uploadURL: data.signed_url,
    objectPath: `/objects/${normalizedRelativePath}`,
  };
}