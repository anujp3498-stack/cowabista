import { createClient, type RedisClientType } from "redis";

/** The largest TPS that may be scheduled, even if an upstream setting is wrong. */
export const CAMPAIGN_PLATFORM_MAX_TPS = boundedEnvTps(process.env.CAMPAIGN_PLATFORM_MAX_TPS, 1_000);
export const MAX_PACING_REQUESTED = 256;
const MAX_INPUT_TPS = 10_000;
const DEFAULT_PREPARE_MS = 250;
const DEFAULT_LOOKAHEAD_MS = 1_000;

export type PacingReservationInput = {
  organizationId: number;
  phoneNumberId: number;
  routeId: number;
  /** Provider-approved per-phone limit. */
  phoneTps: number;
  /** Frozen/configured route limit. */
  routeTps: number;
  requested: number;
  prepareMs?: number;
  maxLookaheadMs?: number;
};

export type PacingReservation = {
  slots: number[];
  effectivePhoneTps: number;
  effectiveRouteTps: number;
  effectiveLimits: { phoneTps: number; routeTps: number };
};
export type PhoneOwnershipLease = {
  owned: boolean;
  fencingToken: number;
  validUntilMs: number;
  coordinationLatencyMs: number;
};

export interface AtomicPacingCoordinator {
  reserveBatch(input: PacingReservationInput): Promise<PacingReservation>;
  ensurePhoneOwnership(input: {
    organizationId: number;
    phoneNumberId: number;
    ownerId: string;
    ttlMs: number;
  }): Promise<PhoneOwnershipLease>;
  releasePhoneOwnership(input: {
    organizationId: number;
    phoneNumberId: number;
    ownerId: string;
  }): Promise<void>;
  close(): Promise<void>;
}

/** A phone as the ownership keys name it. */
export type PhoneOwnershipRef = { organizationId: number; phoneNumberId: number };
/** One membership heartbeat's view of the transport fleet. */
export type CampaignCellMembership = {
  /** Names of the cells whose membership has not expired, sorted, including the caller. */
  cells: string[];
  /** The owner id that last heartbeated under the caller's cell name, or null (duplicate-name detection). */
  previousOwnerId: string | null;
};

/**
 * Automatic phone-to-cell assignment (campaign-phone-assignment.ts). These operations only steer which runtime
 * *asks* for a phone. They never grant or revoke ownership: ensurePhoneOwnership's fenced lease stays the only
 * authority over who may send, so a wrong or stale answer here can cost a handoff, never a duplicate send.
 */
export interface PhoneAssignmentStore {
  /** Registers or refreshes this cell for ttlMs (on the coordinator's clock) and returns the live cells. */
  heartbeatCell(input: { cell: string; ownerId: string; ttlMs: number }): Promise<CampaignCellMembership>;
  /** Removes this cell at once if ownerId still holds its name (graceful stop). */
  leaveCell(input: { cell: string; ownerId: string }): Promise<void>;
  /** The current owner id of each phone's ownership lease, or null when no runtime holds it. Read only. */
  peekPhoneOwners(phones: ReadonlyArray<PhoneOwnershipRef>): Promise<Array<string | null>>;
  /** Asks the phone's current owner to hand it to `cell`; the request expires after ttlMs unless renewed. */
  requestPhoneHandoff(input: PhoneOwnershipRef & { cell: string; ttlMs: number }): Promise<void>;
  /** The cell that asked for each phone, or null. Read only. */
  readPhoneHandoffRequests(phones: ReadonlyArray<PhoneOwnershipRef>): Promise<Array<string | null>>;
}

export function isPhoneAssignmentStore(value: unknown): value is PhoneAssignmentStore {
  const store = value as Partial<PhoneAssignmentStore> | null | undefined;
  return typeof store?.heartbeatCell === "function"
    && typeof store.leaveCell === "function"
    && typeof store.peekPhoneOwners === "function"
    && typeof store.requestPhoneHandoff === "function"
    && typeof store.readPhoneHandoffRequests === "function";
}

function ownershipTag(phone: PhoneOwnershipRef): string {
  return `{campaign-owner:${phone.organizationId}:${phone.phoneNumberId}}`;
}
const CELL_MEMBERS_KEY = "campaign:cells:{campaign-cells}:members";
const CELL_OWNERS_KEY = "campaign:cells:{campaign-cells}:owners";

type Normalized = Required<PacingReservationInput> & {
  effectivePhoneTps: number;
  effectiveRouteTps: number;
};

function boundedEnvTps(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_INPUT_TPS, Math.floor(parsed)));
}

function requirePositiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalize(input: PacingReservationInput): Normalized {
  requirePositiveInteger("organizationId", input.organizationId, Number.MAX_SAFE_INTEGER);
  requirePositiveInteger("phoneNumberId", input.phoneNumberId, Number.MAX_SAFE_INTEGER);
  requirePositiveInteger("routeId", input.routeId, Number.MAX_SAFE_INTEGER);
  const requested = requirePositiveInteger("requested", input.requested, MAX_PACING_REQUESTED);
  const phoneTps = requirePositiveInteger("phoneTps", input.phoneTps, MAX_INPUT_TPS);
  const routeTps = requirePositiveInteger("routeTps", input.routeTps, MAX_INPUT_TPS);
  const prepareMs = input.prepareMs ?? DEFAULT_PREPARE_MS;
  const maxLookaheadMs = input.maxLookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
  if (!Number.isInteger(prepareMs) || prepareMs < 0 || prepareMs > 60_000) {
    throw new RangeError("prepareMs must be an integer between 0 and 60000");
  }
  if (!Number.isInteger(maxLookaheadMs) || maxLookaheadMs < 0 || maxLookaheadMs > 60_000) {
    throw new RangeError("maxLookaheadMs must be an integer between 0 and 60000");
  }
  const effectivePhoneTps = Math.min(phoneTps, CAMPAIGN_PLATFORM_MAX_TPS);
  // A route is always a child ceiling, including when an old configuration is
  // higher than the current provider-approved phone limit.
  const effectiveRouteTps = Math.min(routeTps, effectivePhoneTps, CAMPAIGN_PLATFORM_MAX_TPS);
  return {
    ...input,
    requested,
    phoneTps,
    routeTps,
    prepareMs,
    maxLookaheadMs,
    effectivePhoneTps,
    effectiveRouteTps,
  };
}

function reservation(slots: number[], input: Normalized): PacingReservation {
  return {
    slots,
    effectivePhoneTps: input.effectivePhoneTps,
    effectiveRouteTps: input.effectiveRouteTps,
    effectiveLimits: { phoneTps: input.effectivePhoneTps, routeTps: input.effectiveRouteTps },
  };
}

/**
 * Development/test implementation.  The phone key is deliberately the mutex
 * key: routes on one number must serialize, while other numbers do not wait.
 */
export class InMemoryPacingCoordinator implements AtomicPacingCoordinator, PhoneAssignmentStore {
  private readonly cursors = new Map<string, number>();
  private readonly cells = new Map<string, { ownerId: string; expiresAtMs: number }>();
  private readonly handoffRequests = new Map<string, { cell: string; expiresAtMs: number }>();
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;
  private readonly owners = new Map<string, { ownerId: string; fencingToken: number; validUntilMs: number }>();
  private nextFence = 1;

  constructor(private readonly now: () => number = Date.now) {}

  async reserveBatch(raw: PacingReservationInput): Promise<PacingReservation> {
    if (this.closed) throw new Error("Campaign pacing coordinator is closed");
    const input = normalize(raw);
    const phoneKey = `phone:${input.organizationId}:${input.phoneNumberId}`;
    const previous = this.tails.get(phoneKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.tails.set(phoneKey, queued);
    await previous;
    try {
      const floor = Math.floor(this.now()) + input.prepareMs;
      const horizon = floor + input.maxLookaheadMs;
      const routeKey = `${phoneKey}:route:${input.routeId}`;
      let phoneNext = Math.max(floor, this.cursors.get(phoneKey) ?? floor);
      let routeNext = Math.max(floor, this.cursors.get(routeKey) ?? floor);
      const slots: number[] = [];
      while (slots.length < input.requested) {
        const at = Math.max(phoneNext, routeNext);
        if (at > horizon) break;
        slots.push(at);
        phoneNext = at + (1_000 / input.effectivePhoneTps);
        routeNext = at + (1_000 / input.effectiveRouteTps);
      }
      if (slots.length) {
        this.cursors.set(phoneKey, phoneNext);
        this.cursors.set(routeKey, routeNext);
      }
      return reservation(slots, input);
    } finally {
      release();
      if (this.tails.get(phoneKey) === queued) this.tails.delete(phoneKey);
    }
  }
  async ensurePhoneOwnership(input: {
    organizationId: number; phoneNumberId: number; ownerId: string; ttlMs: number;
  }): Promise<PhoneOwnershipLease> {
    const started = performance.now();
    const key = `${input.organizationId}:${input.phoneNumberId}`;
    const now = this.now();
    const current = this.owners.get(key);
    if (current && current.validUntilMs > now && current.ownerId !== input.ownerId) {
      return { owned: false, fencingToken: current.fencingToken, validUntilMs: current.validUntilMs, coordinationLatencyMs: performance.now() - started };
    }
    const fencingToken = current?.ownerId === input.ownerId && current.validUntilMs > now
      ? current.fencingToken
      : this.nextFence++;
    const validUntilMs = now + input.ttlMs;
    this.owners.set(key, { ownerId: input.ownerId, fencingToken, validUntilMs });
    return { owned: true, fencingToken, validUntilMs, coordinationLatencyMs: performance.now() - started };
  }
  async releasePhoneOwnership(input: {
    organizationId: number; phoneNumberId: number; ownerId: string;
  }): Promise<void> {
    const key = `${input.organizationId}:${input.phoneNumberId}`;
    if (this.owners.get(key)?.ownerId === input.ownerId) this.owners.delete(key);
  }

  async heartbeatCell(input: { cell: string; ownerId: string; ttlMs: number }): Promise<CampaignCellMembership> {
    const now = this.now();
    for (const [cell, member] of this.cells) if (member.expiresAtMs <= now) this.cells.delete(cell);
    const previousOwnerId = this.cells.get(input.cell)?.ownerId ?? null;
    this.cells.set(input.cell, { ownerId: input.ownerId, expiresAtMs: now + input.ttlMs });
    return { cells: [...this.cells.keys()].sort(), previousOwnerId };
  }
  async leaveCell(input: { cell: string; ownerId: string }): Promise<void> {
    if (this.cells.get(input.cell)?.ownerId === input.ownerId) this.cells.delete(input.cell);
  }
  async peekPhoneOwners(phones: ReadonlyArray<PhoneOwnershipRef>): Promise<Array<string | null>> {
    const now = this.now();
    return phones.map((phone) => {
      const owner = this.owners.get(`${phone.organizationId}:${phone.phoneNumberId}`);
      return owner && owner.validUntilMs > now ? owner.ownerId : null;
    });
  }
  async requestPhoneHandoff(input: PhoneOwnershipRef & { cell: string; ttlMs: number }): Promise<void> {
    this.handoffRequests.set(`${input.organizationId}:${input.phoneNumberId}`, { cell: input.cell, expiresAtMs: this.now() + input.ttlMs });
  }
  async readPhoneHandoffRequests(phones: ReadonlyArray<PhoneOwnershipRef>): Promise<Array<string | null>> {
    const now = this.now();
    return phones.map((phone) => {
      const request = this.handoffRequests.get(`${phone.organizationId}:${phone.phoneNumberId}`);
      return request && request.expiresAtMs > now ? request.cell : null;
    });
  }

  async close(): Promise<void> { this.closed = true; }
}

const RESERVE_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local floor = now + tonumber(ARGV[1])
local horizon = floor + tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local phoneRate = tonumber(ARGV[4])
local routeRate = tonumber(ARGV[5])
local phoneNext = math.max(floor, tonumber(redis.call('GET', KEYS[1])) or floor)
local routeNext = math.max(floor, tonumber(redis.call('GET', KEYS[2])) or floor)
local slots = {}
for i = 1, requested do
  local at = math.max(phoneNext, routeNext)
  if at > horizon then break end
  slots[#slots + 1] = string.format('%.6f', at)
  phoneNext = at + 1000 / phoneRate
  routeNext = at + 1000 / routeRate
end
if #slots > 0 then
  redis.call('SET', KEYS[1], string.format('%.6f', phoneNext), 'PX', ARGV[6])
  redis.call('SET', KEYS[2], string.format('%.6f', routeNext), 'PX', ARGV[6])
end
return slots`;
const OWNERSHIP_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then
  return {0, tonumber(redis.call('GET', KEYS[2])) or 0, now + redis.call('PTTL', KEYS[1])}
end
local token = tonumber(redis.call('GET', KEYS[2])) or 0
if not current then
  token = redis.call('INCR', KEYS[2])
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('PERSIST', KEYS[2])
return {1, token, now + tonumber(ARGV[2])}`;
const RELEASE_OWNERSHIP_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

// KEYS[1] members zset (score = expiry on Redis TIME), KEYS[2] cell -> owner id hash. ARGV: cell, ownerId, ttlMs.
// Returns {previous owner id or '', live cell...}. Expired cells are pruned from both keys.
const CELL_HEARTBEAT_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local previous = false
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then previous = redis.call('HGET', KEYS[2], ARGV[1]) end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
local live = redis.call('ZRANGE', KEYS[1], 0, -1)
local keep = {}
for _, cell in ipairs(live) do keep[cell] = true end
for _, cell in ipairs(redis.call('HKEYS', KEYS[2])) do
  if not keep[cell] then redis.call('HDEL', KEYS[2], cell) end
end
redis.call('PEXPIRE', KEYS[1], math.max(ttl * 20, 60000))
redis.call('PEXPIRE', KEYS[2], math.max(ttl * 20, 60000))
local reply = {previous or ''}
for _, cell in ipairs(live) do reply[#reply + 1] = cell end
return reply`;
const CELL_LEAVE_LUA = `
if redis.call('HGET', KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 1
end
return 0`;

export class RedisPacingCoordinator implements AtomicPacingCoordinator, PhoneAssignmentStore {
  private readonly client: RedisClientType;
  private connecting?: Promise<void>;
  private closed = false;
  private lastError?: Error;

  constructor(redisUrl: string) {
    const parsed = new URL(redisUrl);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("Campaign Redis URL must use redis:// or rediss://");
    }
    // node-redis parses redis/rediss URLs, including ACL username/password
    // credentials and TLS settings, itself.
    this.client = createClient({ url: redisUrl, disableOfflineQueue: true });
    // An error listener is mandatory for node-redis. Retaining the most recent
    // error also ensures requests made while it reconnects fail closed instead
    // of being accepted into an offline command queue.
    this.client.on("error", (error: Error) => { this.lastError = error; });
  }

  get healthy(): boolean {
    return !this.closed && this.client.isReady;
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error("Campaign pacing coordinator is closed");
    if (this.client.isReady) return;
    if (this.connecting) {
      await this.connecting;
      if (!this.client.isReady) throw this.lastError ?? new Error("Campaign Redis client is not ready");
      return;
    }
    if (this.client.isOpen) {
      throw this.lastError ?? new Error("Campaign Redis client is reconnecting");
    }
    this.connecting ??= this.client.connect()
      .then(() => undefined)
      .finally(() => { this.connecting = undefined; });
    await this.connecting;
    if (!this.client.isReady) {
      throw this.lastError ?? new Error("Campaign Redis client is not ready");
    }
  }

  async reserveBatch(raw: PacingReservationInput): Promise<PacingReservation> {
    const input = normalize(raw);
    const tag = `{campaign-pacing:${input.organizationId}:${input.phoneNumberId}}`;
    const phoneKey = `campaign:pacing:${tag}:phone`;
    const routeKey = `campaign:pacing:${tag}:route:${input.routeId}`;
    // Preserve a future cursor across a short worker outage, but expire idle
    // keys so deleted tenants/numbers do not leave unbounded Redis state.
    const ttl = Math.max(60_000, input.prepareMs + input.maxLookaheadMs + 60_000);
    await this.ensureConnected();
    let reply: unknown;
    try {
      reply = await this.client.eval(RESERVE_LUA, {
        keys: [phoneKey, routeKey],
        arguments: [
          String(input.prepareMs), String(input.maxLookaheadMs), String(input.requested),
          String(input.effectivePhoneTps), String(input.effectiveRouteTps), String(ttl),
        ],
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    if (!Array.isArray(reply) || !reply.every((slot) => typeof slot === "string" || typeof slot === "number")) {
      throw new Error("Invalid Redis pacing response");
    }
    const slots = reply.map((slot) => Number(slot));
    if (slots.some((slot, index) => !Number.isFinite(slot) || (index > 0 && slot <= slots[index - 1]!))) {
      throw new Error("Invalid Redis pacing slots");
    }
    return reservation(slots, input);
  }
  async ensurePhoneOwnership(input: {
    organizationId: number; phoneNumberId: number; ownerId: string; ttlMs: number;
  }): Promise<PhoneOwnershipLease> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 60_000) {
      throw new RangeError("Phone ownership ttlMs must be between 1000 and 60000");
    }
    const started = performance.now();
    // V2-372: validity is measured on this process's clock from before the request. The lease was set no earlier
    // than this instant and lives ttlMs, so this bound is never later than the real expiry, whatever the skew
    // between this host and Redis. It was Redis TIME + ttl compared against the local clock: a cell running ahead
    // of Redis by the TTL saw every lease as already expired and refused every send, and one running behind held a
    // lease past its real expiry.
    const requestedAt = Date.now();
    const tag = `{campaign-owner:${input.organizationId}:${input.phoneNumberId}}`;
    const ownerKey = `campaign:ownership:${tag}:owner`;
    const fenceKey = `campaign:ownership:${tag}:fence`;
    await this.ensureConnected();
    const reply = await this.client.eval(OWNERSHIP_LUA, {
      keys: [ownerKey, fenceKey],
      arguments: [input.ownerId, String(input.ttlMs)],
    });
    if (!Array.isArray(reply) || reply.length !== 3) throw new Error("Invalid Redis ownership response");
    const owned = Number(reply[0]) === 1;
    return {
      owned,
      fencingToken: Number(reply[1]),
      // A denial reports the holder's expiry on the coordinator's clock (diagnostic only).
      validUntilMs: owned ? requestedAt + input.ttlMs : Number(reply[2]),
      coordinationLatencyMs: performance.now() - started,
    };
  }
  async releasePhoneOwnership(input: {
    organizationId: number; phoneNumberId: number; ownerId: string;
  }): Promise<void> {
    const tag = `{campaign-owner:${input.organizationId}:${input.phoneNumberId}}`;
    await this.ensureConnected();
    await this.client.eval(RELEASE_OWNERSHIP_LUA, {
      keys: [`campaign:ownership:${tag}:owner`],
      arguments: [input.ownerId],
    });
  }

  async heartbeatCell(input: { cell: string; ownerId: string; ttlMs: number }): Promise<CampaignCellMembership> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 60_000) {
      throw new RangeError("Cell membership ttlMs must be between 1000 and 60000");
    }
    await this.ensureConnected();
    const reply = await this.client.eval(CELL_HEARTBEAT_LUA, {
      keys: [CELL_MEMBERS_KEY, CELL_OWNERS_KEY],
      arguments: [input.cell, input.ownerId, String(input.ttlMs)],
    });
    if (!Array.isArray(reply) || reply.length < 1 || !reply.every((value) => typeof value === "string")) {
      throw new Error("Invalid Redis cell membership response");
    }
    const [previous, ...cells] = reply as string[];
    return { cells: [...cells].sort(), previousOwnerId: previous ? previous : null };
  }
  async leaveCell(input: { cell: string; ownerId: string }): Promise<void> {
    await this.ensureConnected();
    await this.client.eval(CELL_LEAVE_LUA, {
      keys: [CELL_MEMBERS_KEY, CELL_OWNERS_KEY],
      arguments: [input.cell, input.ownerId],
    });
  }
  async peekPhoneOwners(phones: ReadonlyArray<PhoneOwnershipRef>): Promise<Array<string | null>> {
    if (!phones.length) return [];
    await this.ensureConnected();
    // One GET per phone, issued together (node-redis pipelines them): each phone's keys live in their own hash
    // slot, so a multi-key MGET would not be valid against a Redis Cluster.
    return Promise.all(phones.map((phone) => this.client.get(`campaign:ownership:${ownershipTag(phone)}:owner`)));
  }
  async requestPhoneHandoff(input: PhoneOwnershipRef & { cell: string; ttlMs: number }): Promise<void> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 60_000) {
      throw new RangeError("Handoff request ttlMs must be between 1000 and 60000");
    }
    await this.ensureConnected();
    await this.client.set(`campaign:ownership:${ownershipTag(input)}:handoff`, input.cell, { expiration: { type: "PX", value: input.ttlMs } });
  }
  async readPhoneHandoffRequests(phones: ReadonlyArray<PhoneOwnershipRef>): Promise<Array<string | null>> {
    if (!phones.length) return [];
    await this.ensureConnected();
    return Promise.all(phones.map((phone) => this.client.get(`campaign:ownership:${ownershipTag(phone)}:handoff`)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.client.isOpen) return;
    try {
      await this.client.quit();
    } catch {
      // quit can fail while a socket is reconnecting. Destroying guarantees no
      // command is left queued and does not turn the failure into memory mode.
      this.client.destroy();
    }
  }
}

export function createCampaignPacingCoordinator(): AtomicPacingCoordinator {
  const redisUrl = process.env.CAMPAIGN_REDIS_URL || process.env.REDIS_URL;
  const mode = process.env.CAMPAIGN_COORDINATOR_MODE;
  if (mode && mode !== "memory" && mode !== "redis") throw new Error("Invalid CAMPAIGN_COORDINATOR_MODE");
  if (process.env.NODE_ENV === "production") {
    if (!redisUrl) throw new Error("CAMPAIGN_REDIS_URL or REDIS_URL is required in production");
    if (mode !== "redis") throw new Error("CAMPAIGN_COORDINATOR_MODE=redis is required in production");
  }
  if (mode === "redis" && !redisUrl) throw new Error("CAMPAIGN_REDIS_URL or REDIS_URL is required for Redis mode");
  if (mode === "memory") {
    if (process.env.NODE_ENV === "production") throw new Error("Memory campaign coordinator is not allowed in production");
    return new InMemoryPacingCoordinator();
  }
  return redisUrl ? new RedisPacingCoordinator(redisUrl) : new InMemoryPacingCoordinator();
}