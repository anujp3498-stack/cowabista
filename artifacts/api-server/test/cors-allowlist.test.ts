// CORS_ALLOWED_ORIGINS and TRUST_PROXY contract (lib/http-config.ts, wired in
// app.ts). CORS entries are FULL origins (scheme://host[:port]) matched
// exactly; a malformed entry must stop the server at startup rather than
// silently allow or block callers. TRUST_PROXY is a hop count, default 1.
//
// The allowlist is read when app.ts is first evaluated, so the env is set
// before the dynamic import below. The startup-failure cases run app.ts in
// a child process (built with esbuild, as the OS-crash harness is) because a
// module that already evaluated cannot be re-evaluated with new env.
process.env.CORS_ALLOWED_ORIGINS = " https://app.example.com , http://localhost:24902 ";

// This suite exercises CORS, not Clerk authentication. Syntactically valid,
// non-production test credentials let Clerk middleware pass anonymous
// requests through, as in http-security-hardening.test.ts.
process.env.CLERK_SECRET_KEY = "sk_test_wabista_cors_only";
process.env.CLERK_PUBLISHABLE_KEY = "pk_test_Y2xlcmsudGVzdCQ=";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { pool, settlementPool } from "@workspace/db";
import { isAllowedOrigin, parseAllowedOrigins, parseTrustProxy } from "../src/lib/http-config";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("parseAllowedOrigins", () => {
  test("accepts full http(s) origins, trims entries and normalizes default ports and a trailing slash", () => {
    const origins = parseAllowedOrigins(
      " https://app.example.com , http://localhost:24902,https://secure.example.com:443/, http://127.0.0.1:80 ,",
    );
    assert.deepEqual(
      [...origins].sort(),
      ["http://127.0.0.1", "http://localhost:24902", "https://app.example.com", "https://secure.example.com"],
    );
  });

  test("unset or empty means no cross-origin caller is allowed", () => {
    assert.equal(parseAllowedOrigins(undefined).size, 0);
    assert.equal(parseAllowedOrigins("").size, 0);
    assert.equal(parseAllowedOrigins(" , ").size, 0);
  });

  for (const bad of [
    "app.example.com",
    "localhost:24902",
    "*",
    "https://app.example.com/path",
    "https://app.example.com/?x=1",
    "https://app.example.com?x=1",
    "https://app.example.com#frag",
    "https://user:pass@app.example.com",
    "ftp://app.example.com",
    "https://*.example.com",
    "https://%2A.example.com",
    "*.example.com",
    "https://",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseAllowedOrigins(`https://ok.example.com,${bad}`), /CORS_ALLOWED_ORIGINS entry .* is not a full origin/);
    });
  }
});

describe("isAllowedOrigin", () => {
  const allowed = parseAllowedOrigins("https://app.example.com,http://localhost:24902");

  test("matches scheme, host and port exactly", () => {
    assert.equal(isAllowedOrigin("https://app.example.com", allowed), true);
    assert.equal(isAllowedOrigin("https://app.example.com:443", allowed), true);
    assert.equal(isAllowedOrigin("http://localhost:24902", allowed), true);
  });

  test("rejects a different scheme, port, host, subdomain or a malformed Origin", () => {
    for (const origin of [
      "http://app.example.com",
      "https://app.example.com:8443",
      "https://evil.example.com",
      "https://sub.app.example.com",
      "https://app.example.com.evil.test",
      "http://localhost:24903",
      "null",
      "not a url",
    ]) {
      assert.equal(isAllowedOrigin(origin, allowed), false, origin);
    }
  });
});

describe("parseTrustProxy", () => {
  test("defaults to one hop and accepts non-negative integer hop counts", () => {
    assert.equal(parseTrustProxy(undefined), 1);
    assert.equal(parseTrustProxy(""), 1);
    assert.equal(parseTrustProxy("0"), 0);
    assert.equal(parseTrustProxy(" 2 "), 2);
  });

  for (const bad of ["true", "false", "-1", "1.5", "loopback", "10.0.0.0/8"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY must be a non-negative integer hop count/);
    });
  }
});

describe("app CORS behaviour", () => {
  // CORS runs before the router, so an unrouted path (404) shows the same
  // headers as a real route without depending on a database.
  const probe = "/api/__cors-allowlist-probe";
  let baseUrl: string;
  let server: Server | undefined;

  before(async () => {
    const { default: app } = await import("../src/app");
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", () => resolve());
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await Promise.all([pool.end(), settlementPool.end()]);
  });

  test("an allowed Origin gets its own origin echoed back, with credentials", async () => {
    const res = await fetch(`${baseUrl}${probe}`, { headers: { Origin: "https://app.example.com" } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });

  test("a preflight from an allowed Origin is answered", async () => {
    const res = await fetch(`${baseUrl}${probe}`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:24902",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:24902");
  });

  test("a disallowed Origin gets no CORS grant (the browser then blocks the response)", async () => {
    for (const origin of ["https://evil.example.com", "http://app.example.com", "http://localhost:24903"]) {
      const res = await fetch(`${baseUrl}${probe}`, { headers: { Origin: origin } });
      assert.equal(res.headers.get("access-control-allow-origin"), null, origin);
      assert.equal(res.headers.get("access-control-allow-credentials"), null, origin);
      assert.equal(res.status, 404, origin);
    }
  });

  test("a request without an Origin (same-origin navigation, curl, webhooks) is served", async () => {
    const res = await fetch(`${baseUrl}${probe}`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

describe("startup validation", () => {
  const harnessDir = path.join(artifactDir, ".test-dist", "cors-startup-harness");
  const harnessPath = path.join(harnessDir, "load-app.mjs");

  before(async () => {
    await rm(harnessDir, { recursive: true, force: true });
    await build({
      stdin: {
        contents: 'import "../src/app";\nconsole.log("APP_LOADED");\nprocess.exit(0);\n',
        resolveDir: path.join(artifactDir, "test"),
        sourcefile: "load-app.ts",
        loader: "ts",
      },
      outfile: harnessPath,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);",
      },
    });
  });

  after(async () => {
    await rm(harnessDir, { recursive: true, force: true });
  });

  function loadApp(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [harnessPath], {
        cwd: artifactDir,
        env: { ...process.env, CORS_ALLOWED_ORIGINS: "", TRUST_PROXY: "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }

  test("a well-formed environment loads", async () => {
    const result = await loadApp({ CORS_ALLOWED_ORIGINS: "https://app.example.com", TRUST_PROXY: "1" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /APP_LOADED/);
  });

  test("a bare host name in CORS_ALLOWED_ORIGINS stops startup", async () => {
    const result = await loadApp({ CORS_ALLOWED_ORIGINS: "https://app.example.com,app.example.com" });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /APP_LOADED/);
    assert.match(result.stderr, /CORS_ALLOWED_ORIGINS entry "app\.example\.com" is not a full origin/);
  });

  test("a non-numeric TRUST_PROXY stops startup", async () => {
    const result = await loadApp({ TRUST_PROXY: "true" });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /APP_LOADED/);
    assert.match(result.stderr, /TRUST_PROXY must be a non-negative integer hop count/);
  });
});
