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
}

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

function parseEntries(reply: RedisReply, expectedPhoneNumberId: number): BrokerDelivery[] {
  const streams: Array<[string, Array<[string, string[]]>]> = Array.isArray(reply)
    ? reply as Array<[string, Array<[string, string[]]>]>
    : reply && typeof reply === "object"
      ? Object.entries(reply as Record<string, Array<[string, string[]]>>)
      : [];
  const deliveries: BrokerDelivery[] = [];
  for (const [, entries] of streams) {
    for (const [id, fields] of entries) {
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
    try {
      await this.client.sendCommand(["XGROUP", "CREATE", streamKey(phoneNumberId), GROUP, "0", "MKSTREAM"]);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
    }
    this.groups.add(phoneNumberId);
  }

  async publish(phoneNumberId: number, fencingToken: number, envelopes: BrokerEnvelope[]): Promise<void> {
    if (!envelopes.length) return;
    await this.ensureGroup(phoneNumberId);
    const entries = envelopes.map((envelope) => ({
      dedupe: `${envelope.job.id}:${envelope.job.leaseToken}`,
      payload: JSON.stringify(envelope),
    }));
    await this.client.eval(PUBLISH_LUA, {
      keys: [streamKey(phoneNumberId), `${streamKey(phoneNumberId)}:published`],
      arguments: [JSON.stringify(entries), String(phoneNumberId), String(fencingToken)],
    });
  }

  async consume(phoneNumberId: number, consumerId: string, count: number): Promise<BrokerDelivery[]> {
    await this.ensureGroup(phoneNumberId);
    const reply = await this.client.sendCommand([
      "XREADGROUP", "GROUP", GROUP, consumerId,
      "COUNT", String(Math.max(1, count)),
      "STREAMS", streamKey(phoneNumberId), ">",
    ]);
    return parseEntries(reply, phoneNumberId);
  }

  async reclaimAbandoned(
    phoneNumberId: number,
    consumerId: string,
    minIdleMs: number,
    count: number,
    cursor = RECLAIM_CURSOR_START,
  ): Promise<BrokerReclaim> {
    await this.ensureGroup(phoneNumberId);
    // XAUTOCLAIM scans the pending list from `cursor`, transfers up to `count`
    // entries idle for at least minIdleMs to this consumer, and returns the
    // cursor to continue from ("0-0" once the whole list has been scanned).
    const reply = await this.client.sendCommand([
      "XAUTOCLAIM", streamKey(phoneNumberId), GROUP, consumerId,
      String(Math.max(0, minIdleMs)), cursor, "COUNT", String(Math.max(1, count)),
    ]);
    if (!Array.isArray(reply) || !Array.isArray(reply[1])) return { deliveries: [], cursor: RECLAIM_CURSOR_START };
    return {
      deliveries: parseEntries([[streamKey(phoneNumberId), reply[1]]], phoneNumberId),
      cursor: typeof reply[0] === "string" && reply[0] ? reply[0] : RECLAIM_CURSOR_START,
    };
  }

  async acknowledge(phoneNumberId: number, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.ensureGroup(phoneNumberId);
    const key = streamKey(phoneNumberId);
    const multi = this.client.multi();
    multi.sendCommand(["XACK", key, GROUP, ...ids]);
    multi.sendCommand(["XDEL", key, ...ids]);
    await multi.exec();
  }

  async metrics(phoneNumberId: number): Promise<BrokerPartitionMetrics> {
    await this.ensureGroup(phoneNumberId);
    const key = streamKey(phoneNumberId);
    const [depthReply, pendingReply, groupsReply] = await Promise.all([
      this.client.sendCommand(["XLEN", key]),
      this.client.sendCommand(["XPENDING", key, GROUP]),
      this.client.sendCommand(["XINFO", "GROUPS", key]),
    ]);
    const depth = Number(depthReply) || 0;
    const pending = Array.isArray(pendingReply) ? Number(pendingReply[0]) || 0 : 0;
    let consumerLag = Math.max(0, depth - pending);
    if (Array.isArray(groupsReply)) {
      for (const group of groupsReply as string[][]) {
        const values = new Map<string, string>();
        for (let index = 0; index < group.length; index += 2) values.set(group[index]!, group[index + 1]!);
        if (values.get("name") === GROUP && values.has("lag")) consumerLag = Number(values.get("lag")) || 0;
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