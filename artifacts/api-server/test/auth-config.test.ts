// Better Auth configuration (lib/auth-config.ts, lib/auth.ts): the server refuses to start on a missing, short,
// placeholder or low-entropy BETTER_AUTH_SECRET, on a malformed BETTER_AUTH_URL, on http in production, and on
// the Better Auth environment overrides that would bypass this check (BETTER_AUTH_SECRETS,
// BETTER_AUTH_TRUSTED_ORIGINS, BETTER_AUTH_TELEMETRY), in EVERY environment. No error message or process
// output carries the secret. No database: DATABASE_URL points at a closed port, and creating the Better Auth
// instance opens no connection.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { parseAuthEnv } from "../src/lib/auth-config";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = randomBytes(32).toString("base64");
const URL_OK = "http://localhost:24902";
const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: URL_OK, ...extra });

function refusal(extra: Record<string, string | undefined>, pattern: RegExp, ...neverEchoed: string[]) {
  assert.throws(() => parseAuthEnv(env(extra)), (error: Error) => {
    assert.match(error.message, pattern);
    for (const value of [SECRET, ...neverEchoed]) assert.ok(!error.message.includes(value), "the message must not echo a secret");
    return true;
  });
}

describe("parseAuthEnv", () => {
  test("a random secret and a full origin are accepted; trusted origins are the app origin plus CORS_ALLOWED_ORIGINS", () => {
    assert.deepEqual(parseAuthEnv(env()), { secret: SECRET, baseURL: URL_OK, secureCookies: false, trustedOrigins: [URL_OK] });
    const https = parseAuthEnv(env({ BETTER_AUTH_URL: "https://app.example.com/", CORS_ALLOWED_ORIGINS: "https://admin.example.com, https://app.example.com", NODE_ENV: "production" }));
    assert.equal(https.baseURL, "https://app.example.com");
    assert.equal(https.secureCookies, true);
    assert.deepEqual(https.trustedOrigins, ["https://app.example.com", "https://admin.example.com"]);
  });

  test("the secret is required, at least 32 characters, not a placeholder and not low-entropy", () => {
    refusal({ BETTER_AUTH_SECRET: undefined }, /BETTER_AUTH_SECRET is required/);
    refusal({ BETTER_AUTH_SECRET: "   " }, /BETTER_AUTH_SECRET is required/);
    const short = randomBytes(15).toString("hex").slice(0, 31);
    refusal({ BETTER_AUTH_SECRET: short }, /too short/, short);
    refusal({ BETTER_AUTH_SECRET: ` ${SECRET}` }, /whitespace/);
    refusal({ BETTER_AUTH_SECRET: "better-auth-secret-12345678901234567890" }, /placeholder/);
    refusal({ BETTER_AUTH_SECRET: `CHANGE_ME-${SECRET}` }, /placeholder/);
    refusal({ BETTER_AUTH_SECRET: "a".repeat(64) }, /low-entropy/);
    refusal({ BETTER_AUTH_SECRET: "abababababababababababababababababababab" }, /low-entropy/);
    for (const nodeEnv of ["development", "test", "production", undefined]) {
      refusal({ BETTER_AUTH_SECRET: undefined, NODE_ENV: nodeEnv }, /BETTER_AUTH_SECRET is required/);
    }
  });

  test("Better Auth's own overrides are refused", () => {
    refusal({ BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64")}` }, /BETTER_AUTH_SECRETS is not supported/);
    refusal({ BETTER_AUTH_TRUSTED_ORIGINS: "https://evil.example" }, /BETTER_AUTH_TRUSTED_ORIGINS is not supported/);
    // Exactly Better Auth's own reading: on unless "", "0" or "false" (any case), untrimmed.
    for (const on of ["1", "true", "yes", " 0", "false ", "off"]) refusal({ BETTER_AUTH_TELEMETRY: on }, /BETTER_AUTH_TELEMETRY must be unset/);
    for (const off of ["", "0", "false", "FALSE"]) assert.doesNotThrow(() => parseAuthEnv(env({ BETTER_AUTH_TELEMETRY: off })), off);
    refusal({ BETTER_AUTH_TELEMETRY_DEBUG: "1" }, /BETTER_AUTH_TELEMETRY_DEBUG must be unset/);
    refusal({ BETTER_AUTH_TELEMETRY_ENDPOINT: "https://telemetry.example" }, /BETTER_AUTH_TELEMETRY_ENDPOINT must be unset/);
  });

  test("BETTER_AUTH_URL must be a full http(s) origin, and https in production", () => {
    refusal({ BETTER_AUTH_URL: undefined }, /BETTER_AUTH_URL is required/);
    for (const bad of ["localhost:24902", "app.example.com", "https://app.example.com/login", "https://app.example.com?x=1", "https://*.example.com", "ftp://app.example.com"]) {
      refusal({ BETTER_AUTH_URL: bad }, /BETTER_AUTH_URL ".*" is not a full origin/);
    }
    refusal({ BETTER_AUTH_URL: "http://app.example.com", NODE_ENV: "production" }, /must be https in production/);
    refusal({ CORS_ALLOWED_ORIGINS: "app.example.com" }, /CORS_ALLOWED_ORIGINS entry "app\.example\.com" is not a full origin/);
  });
});

describe("session cookie", () => {
  // lib/auth.ts validates the process environment when it is first imported.
  before(() => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    process.env.BETTER_AUTH_URL = URL_OK;
  });

  test("https: __Secure-wabista.session_token, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, 7 days", async () => {
    const { createAuth } = await import("../src/lib/auth");
    const auth = createAuth({ secret: SECRET, baseURL: "https://app.example.com", secureCookies: true, trustedOrigins: ["https://app.example.com"] });
    const { sessionToken } = (await auth.$context).authCookies;
    assert.equal(sessionToken.name, "__Secure-wabista.session_token");
    assert.deepEqual(
      { ...sessionToken.attributes },
      { secure: true, sameSite: "lax", path: "/", httpOnly: true, maxAge: 60 * 60 * 24 * 7 },
    );
    const local = createAuth({ secret: SECRET, baseURL: URL_OK, secureCookies: false, trustedOrigins: [URL_OK] });
    assert.equal((await local.$context).authCookies.sessionToken.name, "wabista.session_token");
  });

  test("the Drizzle schema matches what Better Auth expects", async () => {
    const { createAuth } = await import("../src/lib/auth");
    const auth = createAuth({ secret: SECRET, baseURL: URL_OK, secureCookies: false, trustedOrigins: [URL_OK] });
    const context = await auth.$context;
    await context.explicitSchemaCheck?.();
  });
});

describe("startup refusal", () => {
  const harnessDir = path.join(artifactDir, ".test-dist", "auth-startup-harness");
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
      logLevel: "error",
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);",
      },
    });
  });

  after(async () => {
    await rm(harnessDir, { recursive: true, force: true });
  });

  function loadApp(extra: Record<string, string | undefined>): Promise<{ code: number | null; output: string }> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, CORS_ALLOWED_ORIGINS: "", TRUST_PROXY: "", ...env(extra) };
    for (const [name, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[name];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [harnessPath], { cwd: artifactDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, output }));
    });
  }

  test("a well-formed environment loads", async () => {
    const result = await loadApp({});
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /APP_LOADED/);
    assert.ok(!result.output.includes(SECRET));
  });

  const cases: Array<[string, Record<string, string | undefined>, RegExp, string?]> = [
    ["a missing secret", { BETTER_AUTH_SECRET: undefined }, /BETTER_AUTH_SECRET is required/],
    ["a short secret", { BETTER_AUTH_SECRET: "short-secret-value-0123456789" }, /BETTER_AUTH_SECRET is too short/, "short-secret-value-0123456789"],
    ["a missing secret in development", { BETTER_AUTH_SECRET: undefined, NODE_ENV: "development" }, /BETTER_AUTH_SECRET is required/],
    ["a bare host URL", { BETTER_AUTH_URL: "app.example.com" }, /BETTER_AUTH_URL "app\.example\.com" is not a full origin/],
    ["BETTER_AUTH_SECRETS", { BETTER_AUTH_SECRETS: `1:${SECRET}` }, /BETTER_AUTH_SECRETS is not supported/],
  ];
  for (const [label, extra, pattern, value] of cases) {
    test(`${label} stops startup without echoing the value`, async () => {
      const result = await loadApp(extra);
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.output, /APP_LOADED/);
      assert.match(result.output, pattern);
      assert.ok(!result.output.includes(SECRET), "the configured secret never appears in the output");
      if (value) assert.ok(!result.output.includes(value), "the refused value never appears in the output");
    });
  }
});
