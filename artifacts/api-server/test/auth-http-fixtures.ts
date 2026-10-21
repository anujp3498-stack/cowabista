// Shared HTTP helpers for the Better Auth suites (not a suite itself): a raw node:http client (fetch adds its
// own Sec-Fetch-* headers, which would change what Better Auth's CSRF checks see) and a browser-like client
// with a cookie jar and its own X-Forwarded-For address.
import http, { type IncomingHttpHeaders } from "node:http";

export const TEST_ORIGIN = "http://localhost:24902";

/** Distinct client addresses under one /16 per test process, so rate-limit buckets never collide. */
export function ipAllocator() {
  const block = `10.${100 + (process.pid % 100)}`;
  let counter = 0;
  return { block, next: () => { counter += 1; return `${block}.${Math.floor(counter / 250)}.${(counter % 250) + 1}`; } };
}

export type Reply = { status: number; headers: IncomingHttpHeaders; setCookies: string[]; text: string; json: any };

export function call(base: string, method: string, urlPath: string, options: { headers?: Record<string, string>; body?: unknown; raw?: string | Buffer; contentType?: string } = {}): Promise<Reply> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = { ...(payload !== undefined ? { "content-type": options.contentType ?? "application/json" } : {}), ...options.headers };
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${urlPath}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, setCookies: res.headers["set-cookie"] ?? [], text, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function cookieAttributes(setCookie: string) {
  const [pair, ...attributes] = setCookie.split(";").map((part) => part.trim());
  const index = pair!.indexOf("=");
  const map = new Map<string, string>();
  for (const attribute of attributes) {
    const [key, ...value] = attribute.split("=");
    map.set(key!.toLowerCase(), value.join("="));
  }
  return { name: pair!.slice(0, index), value: pair!.slice(index + 1), attributes: map };
}

/** A browser-like cookie jar for one client (one IP address). */
export class Client {
  cookies = new Map<string, string>();
  constructor(readonly base: () => string, readonly ip: string, readonly password: string, readonly origin = TEST_ORIGIN) {}
  absorb(reply: Reply) {
    for (const setCookie of reply.setCookies) {
      const { name, value, attributes } = cookieAttributes(setCookie);
      if (attributes.get("max-age") === "0" || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return reply;
  }
  get session() { return this.cookies.get("wabista.session_token"); }
  async send(method: string, urlPath: string, options: { body?: unknown; headers?: Record<string, string>; raw?: string | Buffer; contentType?: string; origin?: string | null } = {}) {
    const headers: Record<string, string> = { "x-forwarded-for": this.ip, ...options.headers };
    if (options.origin !== null) headers.origin = options.origin ?? this.origin;
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    return this.absorb(await call(this.base(), method, urlPath, { ...options, headers }));
  }
  signUp(email: string, extra: Record<string, unknown> = {}) {
    return this.send("POST", "/api/auth/sign-up/email", { body: { name: "Test User", email, password: this.password, ...extra } });
  }
  signIn(email: string, password = this.password) {
    return this.send("POST", "/api/auth/sign-in/email", { body: { email, password } });
  }
}

