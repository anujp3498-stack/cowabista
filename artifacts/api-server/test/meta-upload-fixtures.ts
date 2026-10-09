// Shared fake of Meta's Resumable Upload session ids (not a suite).
//
// Reproduces the behaviour observed against the REAL Graph API (v25.0):
// step 1 (POST /{app-id}/uploads) answers `{"id":"upload:<opaque>?sig=<opaque>"}`.
// Step 2 must be POST /{version}/upload:<opaque>?sig=<opaque> with the id
// used verbatim. When the whole id is percent-encoded (`upload%3A...%3Fsig%3D...`)
// Meta resolves the decoded value `upload:<opaque>?sig=<opaque>` as the object
// id and answers HTTP 400, GraphMethodException code 100, error_subcode 33.

import { randomBytes, randomUUID } from "node:crypto";

export type FakeUploadSession = { id: string; objectId: string; sig: string };

/** A realistic session id: base64 of Meta's attachment descriptor plus a base64url signature. */
export function fakeUploadSession(fileName: string, fileLength: number, fileType: string): FakeUploadSession {
  const descriptor = `1:attachment:${randomUUID()}?file_length=${fileLength}&file_name=${encodeURIComponent(fileName)}&file_type=${encodeURIComponent(fileType)}`;
  const objectId = `upload:${Buffer.from(descriptor).toString("base64")}`;
  const sig = `AR${randomBytes(12).toString("base64url")}`;
  return { id: `${objectId}?sig=${sig}`, objectId, sig };
}

/**
 * Step 2 as Meta resolves it: the path segment after the version, decoded,
 * is the object id, and `sig` must arrive as a query parameter. Returns
 * the matching session, or Meta's error body when the object does not
 * resolve (e.g. the whole id was percent-encoded).
 */
export function resolveUploadStep2(url: string, version: string, sessions: FakeUploadSession[]):
  | { session: FakeUploadSession }
  | { status: 400; body: { error: { message: string; type: string; code: number; error_subcode: number; fbtrace_id: string } } } {
  const parsed = new URL(url);
  const prefix = `/${version}/`;
  const objectId = parsed.pathname.startsWith(prefix) ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : parsed.pathname;
  const session = sessions.find((candidate) => candidate.objectId === objectId && parsed.searchParams.get("sig") === candidate.sig);
  if (session) return { session };
  return {
    status: 400,
    body: {
      error: {
        message: `Unsupported post request. Object with ID '${objectId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
        type: "GraphMethodException",
        code: 100,
        error_subcode: 33,
        fbtrace_id: "AXfakeUploadTrace",
      },
    },
  };
}
