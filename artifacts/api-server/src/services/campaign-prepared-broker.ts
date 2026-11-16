import { createClient, type RedisClientType } from "redis";
import type { PreparedCampaignEnvelope } from "./campaign-queue";

export type BrokerEnvelope = Omit<PreparedCampaignEnvelope, "registration">;

export type BrokerDelivery = {
  id: string;
  phoneNumberId: number;
  fencingToken: number;
  envelope: BrokerEnvelope;
};

export type BrokerPartitionMetrics = {
  depth: number;
  pending: number;
  consumerLag: number;
};

/** Start-of-scan cursor for reclaimAbandoned; it is also what a completed scan returns. */
export const RECLAIM_CURSOR_START = "0-0";

/**
 * One bounded page of a pending-entries scan. `cursor` is where the next call
 * must continue; RECLAIM_CURSOR_START means the scan reached the end of the
 * pending list. A caller that keeps passing the returned cursor visits every
 * pending entry once per pass without ever holding more than `count` at a time.
 */
export type BrokerReclaim = {
  deliveries: BrokerDelivery[];
  cursor: string;
};

export interface PreparedDispatchBroker {
  publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]): Promise<void>;
  consume(phoneNumberId: number, consumerId: string, count: number): Promise<BrokerDelivery[]>;
  reclaimAbandoned(
    phoneNumberId: number,
    consumerId: string,
    minIdleMs: number,
    count: number,
    cursor?: string,
  ): Promise<BrokerReclaim>;
  acknowledge(phoneNumberId: number, ids: string[]): Promise<void>;
  metrics(phoneNumberId: number): Promise<BrokerPartitionMetrics>;
  close(): Promise<void>;
  /**
   * Redis failure recovery (decision 3). This consumer's own pending entries (delivered to it, not acknowledged) in
   * stream order after `afterId`, at most `count`, and the id to continue from (null once the list is exhausted).
   * Finds entries whose XREADGROUP reply was lost: delivered to the consumer, never seen by its lane.
   */
  pendingOwn?(phoneNumberId: number, consumerId: string, count: number, afterId?: string): Promise<{ deliveries: BrokerDelivery[]; nextId: string | null }>;
  /** For each envelope (in order), whether its published stream entry no longer exists (the stream or group was lost). */
  missingPublished?(phoneNumberId: number, envelopes: BrokerEnvelope[]): Promise<boolean[]>;
}

/**
 * Thrown when a broker command found the phone's consumer group gone (NOGROUP: Redis restarted without persistence,
 * failed over to a replica without the group, or the key was deleted). The group has already been recreated (at the
 * stream's end, with the old entries trimmed), so the next command works; the caller's published-but-unread work is
 * gone from the stream and must be settled as never started (the lane's recovery pass finds it with missingPublished).
 * Before, the broker cached "group exists" forever: every later read, acknowledgement and metrics call failed with
 * NOGROUP, the lane renewed its published jobs' leases indefinitely, and the phone stopped sending.
 */
export class BrokerStreamResetError extends Error {
  constructor(readonly phoneNumberId: number, cause: unknown) {
    super(`Campaign broker stream for phone ${phoneNumberId} lost its consumer group; recreated (old entries trimmed)`);
    this.name = "BrokerStreamResetError";
    this.cause = cause;
  }
}

/** The broker's publish-dedupe key of an envelope (one stream entry per job lease). */
export function brokerDedupeKey(envelope: BrokerEnvelope): string {
  return `${envelope.job.id}:${envelope.job.leaseToken}`;
}

const isNoGroup = (error: unknown) => error instanceof Error && /NOGROUP/.test(error.message);

type RedisReply = unknown;

const GROUP = "campaign-prepared-v1";
const PUBLISH_LUA = `
local entries = cjson.decode(ARGV[1])
local ids = {}
for index, entry in ipairs(entries) do
  local existing = redis.call('HGET', KEYS[2], entry.dedupe)
  if existing then
    ids[index] = existing
  else
    local id = redis.call('XADD', KEYS[1], '*',
      'phone', ARGV[2], 'fence', ARGV[3],
      'dedupe', entry.dedupe, 'payload', entry.payload)
    redis.call('HSET', KEYS[2], entry.dedupe, id)
    ids[index] = id
  end
end
redis.call('EXPIRE', KEYS[2], 86400)
return ids
`;
// V2-372. Acknowledges entries and removes their publish-dedupe fields in one step. Before, XACK+XDEL left every
// `jobId:leaseToken` field in the :published hash, and each publish re-armed the hash's 24 h expiry, so the hash of
// a phone that sent at least once a day only grew (one field per message; Redis runs maxmemory noeviction, so the
// end state was every write failing on every cell). A field is removed only while it still maps to the entry being
// acknowledged. Re-sending stays impossible without it: a re-published (job, lease) whose job was settled fails
// validatePreparedBrokerEnvelopes (status Processing under that exact lease) and is discarded unsent.
// KEYS[1] stream, KEYS[2] dedupe hash; ARGV[1] group, ARGV[2..] entry ids.
const ACKNOWLEDGE_LUA = `
local ids = {}
for index = 2, #ARGV do
  local id = ARGV[index]
  ids[#ids + 1] = id
  local entry = redis.call('XRANGE', KEYS[1], id, id)
  if entry[1] then
    local fields = entry[1][2]
    for field = 1, #fields, 2 do
      if fields[field] == 'dedupe' and redis.call('HGET', KEYS[2], fields[field + 1]) == id then
        redis.call('HDEL', KEYS[2], fields[field + 1])
      end
    end
  end
end
redis.call('XACK', KEYS[1], ARGV[1], unpack(ids))
redis.call('XDEL', KEYS[1], unpack(ids))
return #ids
`;
// Decision 3. Creates the consumer group, or recreates a lost one, atomically: at the stream's end ($), so nothing is
// ever re-delivered (an entry already read and possibly in transport must not be read again), with the old entries
// trimmed and the publish-dedupe hash cleared, so they do not inflate the depth that gates refills (their publishers'
// lanes settle them not started, see missingPublished; a dead owner's leases expire and are reaped). If the group
// exists (BUSYGROUP: another caller created or recreated it first), nothing is touched. KEYS[1] stream, KEYS[2] dedupe
// hash; ARGV[1] group.
const RESET_GROUP_LUA = `
local created = redis.pcall('XGROUP', 'CREATE', KEYS[1], ARGV[1], '$', 'MKSTREAM')
if type(created) == 'table' and created.err then
  if string.find(created.err, 'BUSYGROUP') then return 0 end
  return created
end
redis.call('XTRIM', KEYS[1], 'MAXLEN', '0')
redis.call('DEL', KEYS[2])
return 1
`;
// Decision 3. For each dedupe key, 1 when its entry no longer exists in the stream (no dedupe field, or the field's
// entry is gone), else 0. KEYS[1] stream, KEYS[2] dedupe hash; ARGV dedupe keys. A false 1 (the hash expired after a
// day without any publish while an entry still sat unread) is fail-closed: the job is settled not started and
// requeued, and the entry, when read, fails validation (its lease is gone) and is discarded, never sent.

const MISSING_LUA = `
local missing = {}
for index = 1, #ARGV do
  local id = redis.call('HGET', KEYS[2], ARGV[index])
  if not id then
    missing[index] = 1
  elseif #redis.call('XRANGE', KEYS[1], id, id) == 0 then
    missing[index] = 1
  else
    missing[index] = 0
  end
end
return missing
`;
/** Entry ids per acknowledgement script call (bounds Lua's unpack and each script's run time). */
const ACKNOWLEDGE_CHUNK = 256;
const DATE_FIELDS = new Set([
  "availableAt",
  "lockedAt",
  "leaseExpiresAt",
  "scheduledSendAt",
  "createdAt",
  "updatedAt",
]);

function streamKey(phoneNumberId: number): string {
  return `campaign:prepared:{phone:${phoneNumberId}}`;
}

function reviveDates(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) reviveDates(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    const child = record[key];
    if (typeof child === "string") {
      if (DATE_FIELDS.has(key)) record[key] = new Date(child);
    } else if (child && typeof child === "object") {
      reviveDates(child);
    }
  }
}

/**
 * Parses a published envelope. A JSON.parse reviver callback forces V8 onto
 * its slow parser and re-walks every property through the callback; on a
 * 1,000 TPS phone that was the largest single main-thread cost (26µs per
 * 750-byte envelope against 5.6µs for a plain parse plus this walk). The
 * result is identical: every string held under a date-named key becomes a
 * Date, at any depth, and nothing else changes.
 */
export function reviveEnvelope(payload: string): BrokerEnvelope {
  const envelope = JSON.parse(payload) as BrokerEnvelope;
  reviveDates(envelope);
  return envelope;
}

function streamsOf(reply: RedisReply): Array<[string, Array<[string, string[]]>]> {
  return Array.isArray(reply)
    ? reply as Array<[string, Array<[string, string[]]>]>
    : reply && typeof reply === "object"
      ? Object.entries(reply as Record<string, Array<[string, string[]]>>)
      : [];
}

function parseEntries(reply: RedisReply, expectedPhoneNumberId: number): BrokerDelivery[] {
  const deliveries: BrokerDelivery[] = [];
  for (const [, entries] of streamsOf(reply)) {
    for (const [id, fields] of entries) {
      // A pending entry whose message was deleted comes back with no fields (XREADGROUP with an explicit id).
      if (!Array.isArray(fields)) continue;
      const values = new Map<string, string>();
      for (let index = 0; index < fields.length; index += 2) {
        values.set(fields[index]!, fields[index + 1]!);
      }
      const phoneNumberId = Number(values.get("phone"));
      const fencingToken = Number(values.get("fence"));
      const payload = values.get("payload");
      if (phoneNumberId !== expectedPhoneNumberId || !Number.isFinite(fencingToken) || !payload) continue;
      deliveries.push({
        id,
        phoneNumberId,
        fencingToken,
        envelope: reviveEnvelope(payload),
      });
    }
  }
  return deliveries;
}

export class RedisPreparedDispatchBroker implements PreparedDispatchBroker {
  private readonly client: RedisClientType;
  private connectPromise?: Promise<void>;
  private closed = false;
  private readonly groups = new Set<number>();

  constructor(redisUrl: string) {
    const parsed = new URL(redisUrl);
    if (!["redis:", "rediss:"].includes(parsed.protocol)) {
      throw new Error("Campaign broker URL must use redis:// or rediss://");
    }
    this.client = createClient({ url: redisUrl, disableOfflineQueue: true });
    this.client.on("error", () => undefined);
  }

  private async connected(): Promise<void> {
    if (this.closed) throw new Error("Campaign broker is closed");
    if (this.client.isReady) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => undefined).finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
    if (!this.client.isReady) throw new Error("Campaign broker Redis client is not ready");
  }

  private async ensureGroup(phoneNumberId: number): Promise<void> {
    if (this.groups.has(phoneNumberId)) return;
    await this.connected();
    // Decision 3: created by the same reset as a lost group. Every publish creates the group first, so a stream
    // without one lost it; creating it at "0" (as before) re-delivered entries a dead owner had already read and
    // possibly sent as if unread, and the successor's stale discard then requeued them for a second send.
    await this.resetGroup(phoneNumberId);
    this.groups.add(phoneNumberId);
  }

  private async resetGroup(phoneNumberId: number): Promise<void> {
    const key = streamKey(phoneNumberId);
    await this.client.eval(RESET_GROUP_LUA, { keys: [key, `${key}:published`], arguments: [GROUP] });
  }

  /** Decision 3: a command that finds the group gone recreates it (see RESET_GROUP_LUA) and reports the reset. */
  private async withGroup<T>(phoneNumberId: number, command: () => Promise<T>): Promise<T> {
    await this.ensureGroup(phoneNumberId);
    try {
      return await command();
    } catch (error) {
      if (!isNoGroup(error)) throw error;
      this.groups.delete(phoneNumberId);
      await this.resetGroup(phoneNumberId);
      this.groups.add(phoneNumberId);
      throw new BrokerStreamResetError(phoneNumberId, error);
    }
  }

  async publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]): Promise<void> {
    if (!envelopes.length) return;
    await this.ensureGroup(phoneNumberId);
    const entries = envelopes.map((envelope) => ({
      dedupe: brokerDedupeKey(envelope),
      payload: JSON.stringify(envelope),
    }));
    await this.client.eval(PUBLISH_LUA, {
      keys: [streamKey(phoneNumberId), `${streamKey(phoneNumberId)}:published`],
      arguments: [JSON.stringify(entries), String(phoneNumberId), String(fencingToken)],
    });
  }

  async consume(phoneNumberId: number, consumerId: string, count: number): Promise<BrokerDelivery[]> {
    const reply = await this.withGroup(phoneNumberId, () => this.client.sendCommand([
      "XREADGROUP", "GROUP", GROUP, consumerId,
      "COUNT", String(Math.max(1, count)),
      "STREAMS", streamKey(phoneNumberId), ">",
    ]));
    return parseEntries(reply, phoneNumberId);
  }

  async pendingOwn(phoneNumberId: number, consumerId: string, count: number, afterId = "0"): Promise<{ deliveries: BrokerDelivery[]; nextId: string | null }> {
    // XREADGROUP with an explicit id returns this consumer's own pending entries after it (never new ones).
    const reply = await this.withGroup(phoneNumberId, () => this.client.sendCommand([
      "XREADGROUP", "GROUP", GROUP, consumerId,
      "COUNT", String(Math.max(1, count)),
      "STREAMS", streamKey(phoneNumberId), afterId,
    ]));
    // Paged by the raw reply (an entry without fields is skipped by parseEntries but still advances the page).
    const raw = streamsOf(reply).flatMap(([, entries]) => entries);
    return { deliveries: parseEntries(reply, phoneNumberId), nextId: raw.length >= Math.max(1, count) ? raw.at(-1)![0] : null };
  }

  async missingPublished(phoneNumberId: number, envelopes: BrokerEnvelope[]): Promise<boolean[]> {
    if (!envelopes.length) return [];
    await this.connected();
    const key = streamKey(phoneNumberId);
    const reply = await this.client.eval(MISSING_LUA, {
      keys: [key, `${key}:published`],
      arguments: envelopes.map((envelope) => brokerDedupeKey(envelope)),
    });
    return Array.isArray(reply) ? reply.map((value) => Number(value) === 1) : envelopes.map(() => false);
  }

  async reclaimAbandoned(
    phoneNumberId: number,
    consumerId: string,
    minIdleMs: number,
    count: number,
    cursor = RECLAIM_CURSOR_START,
  ): Promise<BrokerReclaim> {
    // XAUTOCLAIM scans the pending list from `cursor`, transfers up to `count`
    // entries idle for at least minIdleMs to this consumer, and returns the
    // cursor to continue from ("0-0" once the whole list has been scanned).
    const reply = await this.withGroup(phoneNumberId, () => this.client.sendCommand([
      "XAUTOCLAIM", streamKey(phoneNumberId), GROUP, consumerId,
      String(Math.max(0, minIdleMs)), cursor, "COUNT", String(Math.max(1, count)),
    ]));
    if (!Array.isArray(reply) || !Array.isArray(reply[1])) return { deliveries: [], cursor: RECLAIM_CURSOR_START };
    return {
      deliveries: parseEntries([[streamKey(phoneNumberId), reply[1]]], phoneNumberId),
      cursor: typeof reply[0] === "string" && reply[0] ? reply[0] : RECLAIM_CURSOR_START,
    };
  }

  async acknowledge(phoneNumberId: number, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const key = streamKey(phoneNumberId);
    for (let start = 0; start < ids.length; start += ACKNOWLEDGE_CHUNK) {
      await this.withGroup(phoneNumberId, () => this.client.eval(ACKNOWLEDGE_LUA, {
        keys: [key, `${key}:published`],
        arguments: [GROUP, ...ids.slice(start, start + ACKNOWLEDGE_CHUNK)],
      }));
    }
  }

  async metrics(phoneNumberId: number): Promise<BrokerPartitionMetrics> {
    const key = streamKey(phoneNumberId);
    const [depthReply, pendingReply, groupsReply] = await this.withGroup(phoneNumberId, () => Promise.all([
      this.client.sendCommand(["XLEN", key]),
      this.client.sendCommand(["XPENDING", key, GROUP]),
      this.client.sendCommand(["XINFO", "GROUPS", key]),
    ]));
    const depth = Number(depthReply) || 0;
    const pending = Array.isArray(pendingReply) ? Number(pendingReply[0]) || 0 : 0;
    let consumerLag = Math.max(0, depth - pending);
    if (Array.isArray(groupsReply)) {
      for (const group of groupsReply as string[][]) {
        const values = new Map<string, string>();
        for (let index = 0; index < group.length; index += 2) values.set(group[index]!, group[index + 1]!);
        // XINFO reports a nil lag when it cannot compute one (entries deleted after the group's last-delivered id
        // while earlier ones are still pending, which acknowledgement's XDEL causes): keep depth - pending then.
        // Reading nil as 0 hid a dead owner's backlog from the successor's read-ahead (P1).
        const lag = values.get("lag");
        if (values.get("name") === GROUP && lag !== undefined && lag !== null && lag !== "") {
          const parsed = Number(lag);
          if (Number.isFinite(parsed)) consumerLag = Math.max(0, parsed);
        }
      }
    }
    return { depth, pending, consumerLag };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.client.isOpen) return;
    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }
}

type InMemoryEntry = BrokerDelivery & { sequence: number; deliveredAt?: number; consumerId?: string };

export class InMemoryPreparedDispatchBroker implements PreparedDispatchBroker {
  private readonly entries = new Map<number, InMemoryEntry[]>();
  private sequence = 0;

  async publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]): Promise<void> {
    const partition = this.entries.get(phoneNumberId) ?? [];
    for (const envelope of envelopes) {
      const sequence = this.sequence++;
      partition.push({
        id: `${Date.now()}-${sequence}`,
        sequence,
        phoneNumberId,
        fencingToken,
        envelope,
      });
    }
    this.entries.set(phoneNumberId, partition);
  }

  async consume(phoneNumberId: number, consumerId: string, count: number): Promise<BrokerDelivery[]> {
    const partition = this.entries.get(phoneNumberId) ?? [];
    const available = partition.filter((entry) => !entry.consumerId).slice(0, count);
    const deliveredAt = Date.now();
    for (const entry of available) {
      entry.consumerId = consumerId;
      entry.deliveredAt = deliveredAt;
    }
    return available;
  }

  async reclaimAbandoned(
    phoneNumberId: number,
    consumerId: string,
    minIdleMs: number,
    count: number,
    cursor = RECLAIM_CURSOR_START,
  ): Promise<BrokerReclaim> {
    // Mirrors XAUTOCLAIM: scan the pending entries (delivered, unacknowledged)
    // in stream order from the cursor, claim up to `count` idle ones, and hand
    // back the id to continue from, or the start cursor once the scan is over.
    const deadline = Date.now() - minIdleMs;
    const from = cursor === RECLAIM_CURSOR_START ? 0 : Number(cursor.split("-")[1] ?? 0);
    const pending = (this.entries.get(phoneNumberId) ?? []).filter((entry) => entry.consumerId && entry.sequence >= from);
    const stale: BrokerDelivery[] = [];
    let next = RECLAIM_CURSOR_START;
    for (const entry of pending) {
      if (stale.length >= count) {
        next = entry.id;
        break;
      }
      if ((entry.deliveredAt ?? 0) > deadline) continue;
      entry.consumerId = consumerId;
      entry.deliveredAt = Date.now();
      stale.push(entry);
    }
    return { deliveries: stale, cursor: next };
  }

  async acknowledge(phoneNumberId: number, ids: string[]): Promise<void> {
    const removed = new Set(ids);
    this.entries.set(phoneNumberId, (this.entries.get(phoneNumberId) ?? []).filter((entry) => !removed.has(entry.id)));
  }

  async metrics(phoneNumberId: number): Promise<BrokerPartitionMetrics> {
    const partition = this.entries.get(phoneNumberId) ?? [];
    const pending = partition.filter((entry) => entry.consumerId).length;
    return { depth: partition.length, pending, consumerLag: partition.length - pending };
  }

  async pendingOwn(phoneNumberId: number, consumerId: string, count: number, afterId = "0"): Promise<{ deliveries: BrokerDelivery[]; nextId: string | null }> {
    const after = afterId === "0" ? -1 : Number(afterId.split("-")[1] ?? -1);
    const own = (this.entries.get(phoneNumberId) ?? [])
      .filter((entry) => entry.consumerId === consumerId && entry.sequence > after)
      .slice(0, Math.max(1, count));
    return { deliveries: own, nextId: own.length >= Math.max(1, count) ? own.at(-1)!.id : null };
  }

  async missingPublished(phoneNumberId: number, envelopes: BrokerEnvelope[]): Promise<boolean[]> {
    const present = new Set((this.entries.get(phoneNumberId) ?? []).map((entry) => brokerDedupeKey(entry.envelope)));
    return envelopes.map((envelope) => !present.has(brokerDedupeKey(envelope)));
  }

  /** Test hook: the phone's stream is lost (Redis restarted without persistence, failover, flush). */
  loseStream(phoneNumberId: number): void {
    this.entries.delete(phoneNumberId);
  }

  async close(): Promise<void> {}
}

export function createPreparedDispatchBroker(): PreparedDispatchBroker {
  const redisUrl = process.env.CAMPAIGN_REDIS_URL || process.env.REDIS_URL;
  const mode = process.env.CAMPAIGN_COORDINATOR_MODE;
  if (mode === "redis") {
    if (!redisUrl) throw new Error("Redis campaign broker requires CAMPAIGN_REDIS_URL or REDIS_URL");
    return new RedisPreparedDispatchBroker(redisUrl);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Redis campaign broker is required in production");
  }
  return new InMemoryPreparedDispatchBroker();
}