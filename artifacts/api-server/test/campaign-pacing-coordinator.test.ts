import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMPAIGN_PLATFORM_MAX_TPS,
  createCampaignPacingCoordinator,
  InMemoryPacingCoordinator,
  MAX_PACING_REQUESTED,
  RedisPacingCoordinator,
} from "../src/services/campaign-pacing-coordinator";

const base = { organizationId: 1, phoneNumberId: 1, routeId: 1, phoneTps: 1_000, routeTps: 1_000, requested: 4, prepareMs: 0, maxLookaheadMs: 1_000 };

test("1000 TPS has one-ms slots and no burst", async () => {
  const pacing = new InMemoryPacingCoordinator(() => 10_000);
  const result = await pacing.reserveBatch(base);
  assert.deepEqual(result.slots, [10_000, 10_001, 10_002, 10_003]);
});

test("stale cursors do not catch up and phones are isolated", async () => {
  let now = 1_000;
  const pacing = new InMemoryPacingCoordinator(() => now);
  await pacing.reserveBatch({ ...base, phoneTps: 1, routeTps: 1, requested: 1, maxLookaheadMs: 2_000 });
  now = 10_000;
  const [same, other] = await Promise.all([
    pacing.reserveBatch({ ...base, phoneTps: 1, routeTps: 1, requested: 1, maxLookaheadMs: 2_000 }),
    pacing.reserveBatch({ ...base, phoneNumberId: 2, phoneTps: 1, routeTps: 1, requested: 1 }),
  ]);
  assert.deepEqual(same.slots, [10_000]);
  assert.deepEqual(other.slots, [10_000]);
});

test("shared-phone routes coordinate and route ceiling is a child ceiling", async () => {
  const pacing = new InMemoryPacingCoordinator(() => 0);
  const [a, b] = await Promise.all([
    pacing.reserveBatch({ ...base, routeId: 1, phoneTps: 1_000, routeTps: 2, requested: 2, maxLookaheadMs: 2_000 }),
    pacing.reserveBatch({ ...base, routeId: 2, phoneTps: 1_000, routeTps: 2, requested: 2, maxLookaheadMs: 2_000 }),
  ]);
  const all = [...a.slots, ...b.slots].sort((x, y) => x - y);
  assert.equal(new Set(all).size, 4);
  assert.ok(all.every((slot, i) => i === 0 || slot - all[i - 1]! >= 1));
  assert.equal(a.slots[1]! - a.slots[0]!, 500);
});

test("lowest provider, route, and platform ceiling wins", async () => {
  const pacing = new InMemoryPacingCoordinator(() => 0);
  const route = await pacing.reserveBatch({ ...base, phoneTps: 20, routeTps: 5, requested: 2 });
  assert.equal(route.effectiveRouteTps, 5);
  const provider = await pacing.reserveBatch({ ...base, phoneNumberId: 2, phoneTps: 3, routeTps: 50, requested: 1 });
  assert.equal(provider.effectiveRouteTps, 3);
  const platform = await pacing.reserveBatch({ ...base, phoneNumberId: 3, phoneTps: 10_000, routeTps: 10_000, requested: 1 });
  assert.equal(platform.effectiveRouteTps, CAMPAIGN_PLATFORM_MAX_TPS);
});

test("concurrent reservations are atomic and input is bounded", async () => {
  const pacing = new InMemoryPacingCoordinator(() => 0);
  const batches = await Promise.all(Array.from({ length: 20 }, () => pacing.reserveBatch({ ...base, requested: 10 })));
  const slots = batches.flatMap((batch) => batch.slots).sort((a, b) => a - b);
  assert.equal(new Set(slots).size, slots.length);
  assert.ok(slots.every((slot, i) => i === 0 || slot - slots[i - 1]! >= 1));
  await assert.rejects(() => pacing.reserveBatch({ ...base, requested: MAX_PACING_REQUESTED + 1 }), RangeError);
  await assert.rejects(() => pacing.reserveBatch({ ...base, phoneTps: 0 }), RangeError);
});

test("phone ownership is exclusive and reacquisition advances its fencing token", async () => {
  let now = 1_000;
  const coordinator = new InMemoryPacingCoordinator(() => now);
  const input = { organizationId: 1, phoneNumberId: 9, ownerId: "worker-a", ttlMs: 5_000 };
  const first = await coordinator.ensurePhoneOwnership(input);
  assert.equal(first.owned, true);
  const competing = await coordinator.ensurePhoneOwnership({ ...input, ownerId: "worker-b" });
  assert.equal(competing.owned, false);
  await coordinator.releasePhoneOwnership(input);
  const transferred = await coordinator.ensurePhoneOwnership({ ...input, ownerId: "worker-b" });
  assert.equal(transferred.owned, true);
  assert.ok(transferred.fencingToken > first.fencingToken);
  now = transferred.validUntilMs + 1;
  const expiredTransfer = await coordinator.ensurePhoneOwnership(input);
  assert.equal(expiredTransfer.owned, true);
  assert.ok(expiredTransfer.fencingToken > transferred.fencingToken);
});

test("factory requires an explicit Redis coordinator in production", () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    coordinatorMode: process.env.CAMPAIGN_COORDINATOR_MODE,
    campaignRedisUrl: process.env.CAMPAIGN_REDIS_URL,
    redisUrl: process.env.REDIS_URL,
  };
  const restore = () => {
    for (const [key, value] of Object.entries({
      NODE_ENV: original.nodeEnv,
      CAMPAIGN_COORDINATOR_MODE: original.coordinatorMode,
      CAMPAIGN_REDIS_URL: original.campaignRedisUrl,
      REDIS_URL: original.redisUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.CAMPAIGN_REDIS_URL;
    delete process.env.REDIS_URL;
    delete process.env.CAMPAIGN_COORDINATOR_MODE;
    assert.throws(() => createCampaignPacingCoordinator(), /REDIS_URL is required/);

    process.env.CAMPAIGN_REDIS_URL = "redis://127.0.0.1:6379";
    assert.throws(() => createCampaignPacingCoordinator(), /MODE=redis is required/);

    process.env.CAMPAIGN_COORDINATOR_MODE = "memory";
    assert.throws(() => createCampaignPacingCoordinator(), /MODE=redis is required/);

    process.env.CAMPAIGN_COORDINATOR_MODE = "redis";
    const coordinator = createCampaignPacingCoordinator();
    assert.ok(coordinator instanceof RedisPacingCoordinator);
    void coordinator.close();
  } finally {
    restore();
  }
});

test("memory mode is restricted to non-production and Redis close fails closed", async () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    coordinatorMode: process.env.CAMPAIGN_COORDINATOR_MODE,
    campaignRedisUrl: process.env.CAMPAIGN_REDIS_URL,
    redisUrl: process.env.REDIS_URL,
  };
  try {
    process.env.NODE_ENV = "test";
    process.env.CAMPAIGN_COORDINATOR_MODE = "memory";
    delete process.env.CAMPAIGN_REDIS_URL;
    delete process.env.REDIS_URL;
    assert.ok(createCampaignPacingCoordinator() instanceof InMemoryPacingCoordinator);

    const redis = new RedisPacingCoordinator("rediss://acl-user:acl-password@localhost:6379");
    assert.equal(redis.healthy, false);
    await redis.close();
    await assert.rejects(() => redis.reserveBatch(base), /coordinator is closed/);
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: original.nodeEnv,
      CAMPAIGN_COORDINATOR_MODE: original.coordinatorMode,
      CAMPAIGN_REDIS_URL: original.campaignRedisUrl,
      REDIS_URL: original.redisUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Redis Lua reservations are atomic across independent clients", {
  skip: process.env.CAMPAIGN_TEST_REDIS_URL ? false : "CAMPAIGN_TEST_REDIS_URL is not configured",
}, async () => {
  const url = process.env.CAMPAIGN_TEST_REDIS_URL!;
  const clients = Array.from({ length: 8 }, () => new RedisPacingCoordinator(url));
  const uniqueBase = {
    ...base,
    organizationId: Math.floor(Date.now() / 1_000),
    phoneNumberId: process.pid,
    routeId: 1,
    requested: 25,
    prepareMs: 0,
  };
  try {
    const batches = await Promise.all(clients.map((client) => client.reserveBatch(uniqueBase)));
    const slots = batches.flatMap((batch) => batch.slots).sort((a, b) => a - b);
    assert.equal(slots.length, 200);
    assert.equal(new Set(slots).size, slots.length);
    assert.ok(
      slots.every((slot, index) => index === 0 || slot - slots[index - 1]! >= 1),
      "atomic Redis reservations must preserve the per-phone interval across clients",
    );
    const ownershipInput = {
      organizationId: uniqueBase.organizationId,
      phoneNumberId: uniqueBase.phoneNumberId,
      ownerId: "redis-worker-a",
      ttlMs: 5_000,
    };
    const first = await clients[0]!.ensurePhoneOwnership(ownershipInput);
    const competing = await clients[1]!.ensurePhoneOwnership({ ...ownershipInput, ownerId: "redis-worker-b" });
    assert.equal(first.owned, true);
    assert.equal(competing.owned, false);
    await clients[0]!.releasePhoneOwnership(ownershipInput);
    const transferred = await clients[1]!.ensurePhoneOwnership({ ...ownershipInput, ownerId: "redis-worker-b" });
    assert.equal(transferred.owned, true);
    assert.ok(transferred.fencingToken > first.fencingToken);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});
// V2-372, against a real Redis when CAMPAIGN_TEST_REDIS_URL is set (CI sets it).
const testRedisUrl = process.env.CAMPAIGN_TEST_REDIS_URL;
test("Redis: fencing tokens never restart, ownership validity is on the caller's clock, and cell membership expires", { skip: testRedisUrl ? false : "CAMPAIGN_TEST_REDIS_URL is not set" }, async () => {
  const { createClient } = await import("redis");
  const coordinator = new RedisPacingCoordinator(testRedisUrl!);
  const client = createClient({ url: testRedisUrl });
  await client.connect();
  const organizationId = 900_000 + Math.floor(Math.random() * 90_000);
  const phone = { organizationId, phoneNumberId: 9 };
  const fenceKey = `campaign:ownership:{campaign-owner:${organizationId}:9}:fence`;
  try {
    const before = Date.now();
    const lease = await coordinator.ensurePhoneOwnership({ ...phone, ownerId: "owner-a", ttlMs: 5_000 });
    const after = Date.now();
    assert.equal(lease.owned, true);
    assert.ok(lease.validUntilMs >= before + 5_000 && lease.validUntilMs <= after + 5_000, "validity = local time before the request + TTL");
    assert.equal(await client.pTTL(fenceKey), -1, "the fencing counter does not expire, so a token is never reused");
    await coordinator.releasePhoneOwnership({ ...phone, ownerId: "owner-a" });
    const next = await coordinator.ensurePhoneOwnership({ ...phone, ownerId: "owner-b", ttlMs: 5_000 });
    assert.equal(next.fencingToken, lease.fencingToken + 1, "a new owner always gets a higher token");
    assert.deepEqual(await coordinator.peekPhoneOwners([phone, { organizationId, phoneNumberId: 10 }]), ["owner-b", null]);
    await coordinator.requestPhoneHandoff({ ...phone, cell: "cell-a", ttlMs: 1_000 });
    assert.deepEqual(await coordinator.readPhoneHandoffRequests([phone]), ["cell-a"]);

    const cellA = `cell-a-${organizationId}`;
    const cellB = `cell-b-${organizationId}`;
    const first = await coordinator.heartbeatCell({ cell: cellA, ownerId: "a1", ttlMs: 1_000 });
    assert.ok(first.cells.includes(cellA));
    assert.equal(first.previousOwnerId, null);
    const both = await coordinator.heartbeatCell({ cell: cellB, ownerId: "b1", ttlMs: 1_000 });
    assert.ok(both.cells.includes(cellA) && both.cells.includes(cellB));
    assert.equal((await coordinator.heartbeatCell({ cell: cellA, ownerId: "a2", ttlMs: 1_000 })).previousOwnerId, "a1", "a duplicate name is detectable");
    await coordinator.leaveCell({ cell: cellB, ownerId: "b1" });
    assert.ok(!(await coordinator.heartbeatCell({ cell: cellA, ownerId: "a2", ttlMs: 1_000 })).cells.includes(cellB), "a graceful leave is immediate");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const alone = await coordinator.heartbeatCell({ cell: `cell-c-${organizationId}`, ownerId: "c1", ttlMs: 1_000 });
    assert.ok(!alone.cells.includes(cellA), "a cell that stopped heartbeating expires on the coordinator's clock");
    await coordinator.leaveCell({ cell: `cell-c-${organizationId}`, ownerId: "c1" });
  } finally {
    await client.del([fenceKey, `campaign:ownership:{campaign-owner:${organizationId}:9}:owner`, `campaign:ownership:{campaign-owner:${organizationId}:9}:handoff`]);
    await client.quit();
    await coordinator.close();
  }
});
