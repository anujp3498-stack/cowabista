// Fake WhatsApp Graph server for the kill benchmark. It is the ground truth of what reached the "provider".
//
// Every campaign cell process sends to http://127.0.0.1:<port>/<prefix>/v25.0/<providerPhoneId>/messages
// (CAMPAIGN_TEST_GRAPH_BASE_URL with a per-process path prefix), so each request names the process that sent it.
// A request "reached" the provider when its whole body arrived; that is logged even if the sender is killed before
// the response is written. Never logs the bearer token: only whether one was present.
//
// Usage: node fake-graph.mjs --port 0 --log <file.ndjson> --stats <file.jsonl> [--latency-ms 50] [--jitter-ms 0]
// Prints `FAKE_GRAPH_READY port=<port>` once listening. SIGTERM flushes the log and exits.
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const port = Number(arg("port", "0"));
const logPath = arg("log");
const statsPath = arg("stats");
let latencyMs = Number(arg("latency-ms", "50"));
let jitterMs = Number(arg("jitter-ms", "0"));
if (!logPath || !statsPath) throw new Error("--log and --stats are required");

const log = createWriteStream(logPath, { flags: "a", highWaterMark: 1 << 20 });
const stats = createWriteStream(statsPath, { flags: "a" });
const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();

let seq = 0;
let inFlight = 0;
let reachedTotal = 0;
let partialTotal = 0;
/** reached per second, by phone and by prefix (cleared every second) */
let window = { phones: {}, prefixes: {} };
const PATH = /^\/([^/]+)\/v\d+\.\d+\/([^/]+)\/messages$/;

function delay() {
  return latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
}

const server = createServer((req, res) => {
  const tArrive = Date.now();
  if (req.method === "GET" && req.url === "/__health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ seq, inFlight, reachedTotal, partialTotal, latencyMs, jitterMs }));
    return;
  }
  if (req.method === "POST" && req.url === "/__control") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const control = JSON.parse(body || "{}");
      if (Number.isFinite(control.latencyMs)) latencyMs = control.latencyMs;
      if (Number.isFinite(control.jitterMs)) jitterMs = control.jitterMs;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ latencyMs, jitterMs }));
    });
    return;
  }
  const match = PATH.exec(req.url ?? "");
  if (req.method !== "POST" || !match) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unknown fake Graph route", code: 100 } }));
    return;
  }
  const [, prefix, phone] = match;
  const authOk = /^Bearer \S+$/.test(req.headers.authorization ?? "");
  const chunks = [];
  let complete = false;
  inFlight += 1;
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    complete = true;
    const tBodyEnd = Date.now();
    let to = null;
    let template = null;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      to = body.to ?? null;
      template = body.template?.name ?? null;
    } catch { /* logged with to=null */ }
    const id = ++seq;
    reachedTotal += 1;
    window.phones[phone] = (window.phones[phone] ?? 0) + 1;
    window.prefixes[prefix] = (window.prefixes[prefix] ?? 0) + 1;
    const entry = { seq: id, prefix, phone, to, template, authOk, tArrive, tBodyEnd, tResponded: null, outcome: "pending" };
    let logged = false;
    const write = (outcome) => {
      if (logged) return;
      logged = true;
      inFlight -= 1;
      entry.outcome = outcome;
      log.write(`${JSON.stringify(entry)}\n`);
    };
    // The sender may be killed while the response is pending: the request still reached the provider.
    res.on("close", () => write(entry.tResponded ? "responded" : "client-gone"));
    setTimeout(() => {
      if (res.destroyed) return write("client-gone");
      entry.tResponded = Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: `wamid.fake.${prefix}.${id}` }] }));
    }, delay());
  });
  req.on("close", () => {
    if (complete) return;
    inFlight -= 1;
    partialTotal += 1;
    log.write(`${JSON.stringify({ seq: null, prefix, phone, to: null, tArrive, outcome: "partial-body" })}\n`);
  });
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;
server.maxRequestsPerSocket = 0;

const statsTimer = setInterval(() => {
  stats.write(`${JSON.stringify({
    t: Date.now(), reachedTotal, partialTotal, inFlight, phones: window.phones, prefixes: window.prefixes,
    eventLoopP99Ms: Number((eld.percentile(99) / 1e6).toFixed(2)), eventLoopMaxMs: Number((eld.max / 1e6).toFixed(2)),
  })}\n`);
  window = { phones: {}, prefixes: {} };
  eld.reset();
}, 1_000);

server.listen({ port, host: "127.0.0.1", backlog: 4096 }, () => {
  console.log(`FAKE_GRAPH_READY port=${server.address().port}`);
});

function shutdown() {
  clearInterval(statsTimer);
  server.close();
  server.closeAllConnections?.();
  let pending = 2;
  const done = () => { if (--pending === 0) process.exit(0); };
  log.end(done);
  stats.end(done);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
