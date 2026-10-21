// In-process fake of the S3 REST subset the campaign media store uses (path-style addressing): PutObject,
// GetObject, DeleteObject, CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload and
// CreateBucket. Never a real object store; nothing leaves 127.0.0.1. Not a suite itself.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeS3Request = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; bodyBytes: number };

const xmlError = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

export async function startFakeS3(options: { bucket: string; failPutAfterParts?: number } = { bucket: "wabista-test" }) {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const requests: FakeS3Request[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? "", path: decodeURIComponent(url.pathname), query: url.searchParams, headers: req.headers, bodyBytes: body.length });
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      res.setHeader("content-type", "application/xml");
      if (bucket !== options.bucket) {
        res.writeHead(404);
        res.end(xmlError("NoSuchBucket", "The specified bucket does not exist"));
        return;
      }
      if (!key) {
        res.writeHead(200);
        res.end();
        return;
      }
      const uploadId = url.searchParams.get("uploadId");
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const id = randomBytes(8).toString("hex");
        uploads.set(id, { key, parts: new Map() });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        return;
      }
      if (req.method === "PUT" && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload) { res.writeHead(404); res.end(xmlError("NoSuchUpload", "The specified upload does not exist")); return; }
        const partNumber = Number(url.searchParams.get("partNumber"));
        if (options.failPutAfterParts !== undefined && upload.parts.size >= options.failPutAfterParts) {
          res.writeHead(500); res.end(xmlError("InternalError", "injected failure")); return;
        }
        upload.parts.set(partNumber, body);
        res.setHeader("etag", `"etag-${partNumber}"`);
        res.end();
        return;
      }
      if (req.method === "POST" && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload) { res.writeHead(404); res.end(xmlError("NoSuchUpload", "The specified upload does not exist")); return; }
        const ordered = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes);
        objects.set(upload.key, Buffer.concat(ordered));
        uploads.delete(uploadId);
        res.end(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
        return;
      }
      if (req.method === "DELETE" && uploadId) {
        uploads.delete(uploadId);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "PUT") {
        objects.set(key, body);
        res.setHeader("etag", '"single"');
        res.end();
        return;
      }
      if (req.method === "GET") {
        const bytes = objects.get(key);
        if (!bytes) { res.writeHead(404); res.end(xmlError("NoSuchKey", "The specified key does not exist.")); return; }
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", String(bytes.length));
        res.end(bytes);
        return;
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400);
      res.end(xmlError("InvalidRequest", "unsupported"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    objects,
    uploads,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
