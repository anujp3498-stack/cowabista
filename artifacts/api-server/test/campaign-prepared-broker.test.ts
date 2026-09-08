import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import {
  RedisPreparedDispatchBroker,
  type BrokerEnvelope,
} from "../src/services/campaign-prepared-broker";

const port = 6395;
const url = `redis://127.0.0.1:${port}`;
let redis: ChildProcess;

function envelope(id: number, phoneNumberId = 101): BrokerEnvelope {
  return {
    job: {
      id,
      organizationId: 1,
      campaignId: 2,
      routeId: 3,
      contactId: 4,
      type: "ResolveTemplateAndSend",
      payload: {},
      status: "Processing",
      attempts: 1,
      maxAttempts: 3,
      availableAt: new Date(),
      lockedAt: new Date(),
      lockedBy: "publisher",
      leaseToken: `lease-${id}`,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      scheduledSendAt: new Date(),
      idempotencyKey: `job-${id}`,
      errorReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      dispatchPhoneNumberId: phoneNumberId,
    },
    preparedContext: { providerMessageRowId: id, payload: { to: String(id) } },
  } as BrokerEnvelope;
}

before(async () => {
  redis = spawn("redis-server", [
    "--port", String(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1",
  ], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const probe = async () => {
      const broker = new RedisPreparedDispatchBroker(url);
      try {
        await broker.metrics(999_999);
        await broker.close();
        resolve();
      } catch {
        await broker.close();
        if (Date.now() >= deadline) reject(new Error("Redis test server did not start"));
        else setTimeout(probe, 25);
      }
    };
    void probe();
  });
});

after(() => {
  redis.kill("SIGTERM");
});

test("Redis Streams partitions prepared leased work by phone and reports depth, pending and lag", async () => {
  const broker = new RedisPreparedDispatchBroker(url);
  try {
    await broker.publish(101, 7, [envelope(1), envelope(2), envelope(3)]);
    await broker.publish(102, 11, [envelope(4, 102)]);
    assert.deepEqual(await broker.metrics(101), { depth: 3, pending: 0, consumerLag: 3 });
    assert.deepEqual(await broker.metrics(102), { depth: 1, pending: 0, consumerLag: 1 });

    const first = await broker.consume(101, "consumer-a", 2);
    assert.deepEqual(first.map((item) => item.envelope.job.id), [1, 2]);
    assert.ok(first.every((item) => item.fencingToken === 7));
    assert.deepEqual(await broker.metrics(101), { depth: 3, pending: 2, consumerLag: 1 });
    await broker.acknowledge(101, [first[0]!.id]);
    assert.deepEqual(await broker.metrics(101), { depth: 2, pending: 1, consumerLag: 1 });
  } finally {
    await broker.close();
  }
});

test("a replacement consumer reclaims an abandoned lease fail-closed without replaying the provider", async () => {
  const broker = new RedisPreparedDispatchBroker(url);
  let providerCalls = 0;
  try {
    await broker.publish(201, 21, [envelope(10, 201)]);
    const [started] = await broker.consume(201, "consumer-before-crash", 1);
    assert.ok(started);
    providerCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    const reclaimed = await broker.reclaimAbandoned(201, "consumer-after-crash", 50, 10);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]!.envelope.job.leaseToken, "lease-10");
    // Recovery deliberately revokes/requeues the exact lease. It never calls
    // the provider because the old consumer may have crossed that boundary.
    await broker.acknowledge(201, reclaimed.map((item) => item.id));
    assert.equal(providerCalls, 1);
    assert.deepEqual(await broker.metrics(201), { depth: 0, pending: 0, consumerLag: 0 });
  } finally {
    await broker.close();
  }
});
