// V2-372 automatic phone-to-cell assignment: the pure plan, the environment contract, and two cells' controllers
// sharing one in-memory coordinator on a fake clock (membership, preference, fallback, handoff requests, expiry,
// unowned reporting). The end-to-end behaviour with real processes, PostgreSQL and Redis is in
// campaign-auto-assignment.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryPacingCoordinator } from "../src/services/campaign-pacing-coordinator";
import {
  PhoneAssignmentController,
  UnownedPhoneTracker,
  planPhoneAssignment,
  rendezvousOrder,
  type AssignmentPhone,
} from "../src/services/campaign-phone-assignment";
import { transportAssignmentFromEnv } from "../src/services/campaign-phone-scope";

const phones = (count: number, weight = 30, organizationId = 1): AssignmentPhone[] =>
  Array.from({ length: count }, (_, index) => ({ organizationId, phoneNumberId: index + 1, weight }));
const keyed = (list: AssignmentPhone[]) => list.map((phone) => ({ key: `${phone.organizationId}:${phone.phoneNumberId}`, weight: phone.weight }));
const loads = (plan: Map<string, string[]>) => {
  const counts = new Map<string, number>();
  for (const order of plan.values()) counts.set(order[0]!, (counts.get(order[0]!) ?? 0) + 1);
  return counts;
};

test("rendezvous order is deterministic, total, and independent of the cell list's order", () => {
  const a = rendezvousOrder(["cell-1", "cell-2", "cell-3"], "1:9");
  const b = rendezvousOrder(["cell-3", "cell-1", "cell-2"], "1:9");
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), ["cell-1", "cell-2", "cell-3"]);
});

test("the plan gives every sendable phone a cell, balances equal phones within the load bound, and is order independent", () => {
  for (const count of [1, 2, 3, 4, 5, 8, 9, 10, 17]) {
    const list = keyed(phones(count));
    const plan = planPhoneAssignment({ cells: ["cell-1", "cell-2"], phones: list, cellCapacity: 16_384, loadSlack: 1.25 });
    assert.equal(plan.size, count, "every phone is planned");
    const bound = Math.max(1, Math.ceil((count / 2) * 1.25));
    for (const [cell, load] of loads(plan)) assert.ok(load <= bound, `${count} phones: ${cell} has ${load} > ${bound}`);
    if (count >= 2) assert.equal(loads(plan).size, 2, `${count} phones use both cells`);
    const reversed = planPhoneAssignment({ cells: ["cell-2", "cell-1"], phones: [...list].reverse(), cellCapacity: 16_384, loadSlack: 1.25 });
    assert.deepEqual([...reversed.entries()].sort(), [...plan.entries()].sort(), "the same inputs give the same plan on every cell");
    for (const order of plan.values()) assert.deepEqual([...order].sort(), ["cell-1", "cell-2"], "each phone lists every cell once");
  }
});

test("the production defect: phone 9 is planned onto a live cell, with no scope to edit", () => {
  const eight = keyed(phones(8));
  const nine = keyed(phones(9));
  const before = planPhoneAssignment({ cells: ["cell-1", "cell-2"], phones: eight, cellCapacity: 16_384, loadSlack: 1.25 });
  const after = planPhoneAssignment({ cells: ["cell-1", "cell-2"], phones: nine, cellCapacity: 16_384, loadSlack: 1.25 });
  assert.ok(["cell-1", "cell-2"].includes(after.get("1:9")![0]!), "phone 9 has an assigned cell");
  const moved = eight.filter(({ key }) => before.get(key)![0] !== after.get(key)![0]).length;
  assert.ok(moved <= 2, `adding one phone moves at most two others (moved ${moved})`);
});

test("when a cell leaves, every phone is planned onto the survivors; phones already there stay", () => {
  const list = keyed(phones(9));
  const three = planPhoneAssignment({ cells: ["cell-1", "cell-2", "cell-3"], phones: list, cellCapacity: 16_384, loadSlack: 1.25 });
  const two = planPhoneAssignment({ cells: ["cell-1", "cell-3"], phones: list, cellCapacity: 16_384, loadSlack: 1.25 });
  for (const order of two.values()) assert.notEqual(order[0], "cell-2");
  const one = planPhoneAssignment({ cells: ["cell-3"], phones: list, cellCapacity: 16_384, loadSlack: 1.25 });
  for (const order of one.values()) assert.deepEqual(order, ["cell-3"]);
  assert.ok(three.size === 9 && two.size === 9);
});

test("heavy phones are spread by lane weight and the per-cell capacity is respected while the fleet has room", () => {
  // Five 1,000-TPS phones (lane weight 3,000) and a cell capacity of 16,384: never more than five on one cell.
  const heavy = keyed(phones(10, 3_000));
  const plan = planPhoneAssignment({ cells: ["cell-1", "cell-2"], phones: heavy, cellCapacity: 16_384, loadSlack: 1.25 });
  for (const [cell, load] of loads(plan)) assert.ok(load * 3_000 <= 16_384, `${cell}: ${load} heavy phones`);
  // Mixed weights: one 1,000-TPS phone and eight 80-TPS phones stay balanced by weight, not by count.
  const mixed = keyed([{ organizationId: 1, phoneNumberId: 1, weight: 3_000 }, ...phones(8, 240).map((phone) => ({ ...phone, phoneNumberId: phone.phoneNumberId + 1 }))]);
  const mixedPlan = planPhoneAssignment({ cells: ["cell-1", "cell-2"], phones: mixed, cellCapacity: 16_384, loadSlack: 1.25 });
  const weight = new Map<string, number>();
  for (const { key, weight: w } of mixed) weight.set(mixedPlan.get(key)![0]!, (weight.get(mixedPlan.get(key)![0]!) ?? 0) + w);
  assert.ok(Math.max(...weight.values()) <= 3_000 + 240, `weights per cell: ${JSON.stringify([...weight])}`);
});

test("the environment selects static, unscoped or automatic assignment and refuses mixtures", () => {
  assert.deepEqual(transportAssignmentFromEnv({}), { mode: "unscoped" });
  const fixed = transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_PHONE_IDS: "5-9" });
  assert.equal(fixed.mode, "static");
  assert.deepEqual(fixed.mode === "static" ? [...fixed.scope] : [], [5, 6, 7, 8, 9]);
  assert.deepEqual(transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto", CAMPAIGN_CELL: "cell-2" }), { mode: "auto", cell: "cell-2" });
  assert.deepEqual(transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_ASSIGNMENT: " AUTO " }, () => "host-d"), { mode: "auto", cell: "host-d" });
  assert.throws(() => transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto", CAMPAIGN_TRANSPORT_PHONE_IDS: "1-4", CAMPAIGN_CELL: "c" }), /cannot be combined/);
  assert.throws(() => transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_ASSIGNMENT: "auto" }), /needs CAMPAIGN_CELL/);
  assert.throws(() => transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_ASSIGNMENT: "static" }), /needs CAMPAIGN_TRANSPORT_PHONE_IDS/);
  assert.throws(() => transportAssignmentFromEnv({ CAMPAIGN_TRANSPORT_ASSIGNMENT: "round-robin" }), /must be "auto" or "static"/);
  assert.throws(() => new PhoneAssignmentController(new InMemoryPacingCoordinator(), "bad name!", "owner", 100), /cell name/);
});

/** Two cells on one shared in-memory coordinator and a fake clock. */
function fleet(timings: Record<string, number> = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const store = new InMemoryPacingCoordinator(clock);
  const t = { heartbeatIntervalMs: 1_000, membershipTtlMs: 5_000, evaluationIntervalMs: 500, fallbackGraceMs: 2_000, joinStableMs: 5_000, unownedAlertMs: 20_000, ...timings };
  const a = new PhoneAssignmentController(store, "cell-a", "owner-a", 16_384, t, clock);
  const b = new PhoneAssignmentController(store, "cell-b", "owner-b", 16_384, t, clock);
  const held = { a: new Set<number>(), b: new Set<number>() };
  const context = (cell: "a" | "b") => ({ holds: (phone: { phoneNumberId: number }) => held[cell].has(phone.phoneNumberId), canRequest: () => true });
  /** What a reservoir does with shouldAcquire: ask the coordinator, keep the lane when owned. */
  async function pass(cell: "a" | "b", list: AssignmentPhone[], live = true) {
    const controller = cell === "a" ? a : b;
    const ownerId = cell === "a" ? "owner-a" : "owner-b";
    await controller.refresh(list, context(cell));
    for (const phone of list) {
      if (!held[cell].has(phone.phoneNumberId) && !controller.shouldAcquire(phone)) continue;
      if (!live) continue;
      const lease = await store.ensurePhoneOwnership({ organizationId: phone.organizationId, phoneNumberId: phone.phoneNumberId, ownerId, ttlMs: 5_000 });
      if (lease.owned) held[cell].add(phone.phoneNumberId);
      else held[cell].delete(phone.phoneNumberId);
    }
  }
  /** Both cells register before either takes a phone (otherwise the first one alone is planned everything). */
  async function warm(list: AssignmentPhone[]) {
    await a.refresh(list, context("a"));
    await b.refresh(list, context("b"));
    now += 1_001;
    await a.refresh(list, context("a"));
    await b.refresh(list, context("b"));
  }
  return { store, a, b, held, pass, warm, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("two cells: each takes exactly the phones planned for it, and a phone planned for the other is not taken while it is held", async () => {
  const f = fleet();
  const list = phones(6);
  await f.warm(list);
  for (let round = 0; round < 4; round += 1) {
    await f.pass("a", list);
    await f.pass("b", list);
    f.advance(600);
  }
  assert.equal(f.held.a.size + f.held.b.size, 6, "every phone owned");
  for (const id of f.held.a) assert.ok(!f.held.b.has(id), `phone ${id} owned once`);
  for (const phone of list) {
    const assigned = f.a.assignedCell(phone);
    assert.equal(assigned, f.b.assignedCell(phone), "both cells agree on the plan");
    assert.ok((assigned === "cell-a" ? f.held.a : f.held.b).has(phone.phoneNumberId), `phone ${phone.phoneNumberId} is on its assigned cell`);
  }
  assert.ok(f.held.a.size >= 2 && f.held.b.size >= 2, "both cells send");
});

test("cold start: a cell that starts alone takes every phone, then the plan assigns some to the second cell, which asks for them", async () => {
  const f = fleet({ joinStableMs: 1_000 });
  const list = phones(6);
  await f.pass("a", list);
  assert.equal(f.held.a.size, 6, "alone, cell-a sends every phone at once (no grace period at cold start)");
  for (let round = 0; round < 4; round += 1) { f.advance(600); await f.pass("b", list); await f.pass("a", list); }
  const forB = list.filter((phone) => f.b.assignedCell(phone) === "cell-b");
  assert.ok(forB.length >= 2, "the plan gives cell-b a share");
  assert.ok(forB.every((phone) => f.a.handoffRequested(phone)), "cell-a is asked to hand cell-b's share over");
  assert.equal(f.held.b.size, 0, "cell-b never takes a held phone itself: the move is the holder's graceful handoff");
});

test("fallback: a phone its assigned cell does not take is taken by the next cell only after the grace period", async () => {
  const f = fleet();
  const list = phones(4);
  // Both cells join; cell-a then refuses to take anything (live = false: no capacity, credential failing, wedged).
  const firstSeenUnowned = f.now(); // cell-b's first owner read happens in warm()
  await f.warm(list);
  await f.pass("a", list, false);
  await f.pass("b", list);
  const forA = list.filter((phone) => f.a.assignedCell(phone) === "cell-a");
  assert.ok(forA.length >= 1);
  assert.ok(forA.every((phone) => !f.held.b.has(phone.phoneNumberId)), "not taken at once");
  while (f.now() + 500 < firstSeenUnowned + 2_000) {
    f.advance(500);
    await f.pass("a", list, false);
    await f.pass("b", list);
  }
  assert.ok(forA.every((phone) => !f.held.b.has(phone.phoneNumberId)), "not taken within the grace period");
  for (let round = 0; round < 3; round += 1) {
    f.advance(500);
    await f.pass("a", list, false);
    await f.pass("b", list);
  }
  assert.ok(forA.every((phone) => f.held.b.has(phone.phoneNumberId)), "taken by the fallback cell after the grace period");
});

test("rebalance: the assigned cell asks the holder for its phones once it has settled in; the holder sees the request", async () => {
  const f = fleet({ joinStableMs: 2_000 });
  const list = phones(4);
  // cell-b runs alone first and takes everything.
  for (let round = 0; round < 3; round += 1) { await f.pass("b", list); f.advance(600); }
  assert.equal(f.held.b.size, 4);
  // cell-a joins. It is assigned some phones that cell-b holds.
  await f.pass("a", list);
  await f.pass("b", list);
  const wanted = list.filter((phone) => f.a.assignedCell(phone) === "cell-a");
  assert.ok(wanted.length >= 1);
  assert.ok(wanted.every((phone) => !f.b.handoffRequested(phone)), "no request while cell-a is joining");
  for (let round = 0; round < 5; round += 1) {
    f.advance(600);
    await f.pass("a", list);
    await f.pass("b", list);
  }
  assert.ok(wanted.every((phone) => f.b.handoffRequested(phone)), "cell-b sees cell-a's requests");
  assert.ok(list.filter((phone) => !wanted.includes(phone)).every((phone) => !f.b.handoffRequested(phone)), "and only for cell-a's phones");
  assert.ok(f.b.mayStartHandoff());
  f.b.handoffStarted(wanted[0]!);
  assert.equal(f.b.mayStartHandoff(), false, "one handoff at a time");
  // The holder releases; the assigned cell takes the phone on its next pass (no grace period for rank 0).
  await f.store.releasePhoneOwnership({ organizationId: 1, phoneNumberId: wanted[0]!.phoneNumberId, ownerId: "owner-b" });
  f.held.b.delete(wanted[0]!.phoneNumberId);
  f.b.handoffEnded(wanted[0]!);
  f.advance(600);
  await f.pass("a", list);
  assert.ok(f.held.a.has(wanted[0]!.phoneNumberId), "the assigned cell acquired the handed-off phone");
});

test("a cell that stops heartbeating drops out after the membership TTL and the survivor is planned every phone", async () => {
  const f = fleet();
  const list = phones(6);
  await f.warm(list);
  for (let round = 0; round < 3; round += 1) { await f.pass("a", list); await f.pass("b", list); f.advance(600); }
  assert.deepEqual(f.b.status().cells, ["cell-a", "cell-b"]);
  assert.ok(f.held.a.size >= 1, "cell-a held phones before it died");
  // cell-a dies: no more passes from it. Its leases expire after 5 s, its membership after 5 s.
  for (let round = 0; round < 12; round += 1) { f.advance(600); await f.pass("b", list); }
  assert.deepEqual(f.b.status().cells, ["cell-b"]);
  assert.equal(f.held.b.size, 6, "the survivor owns every phone");
  assert.deepEqual(f.b.status().assignedPhoneIds, [1, 2, 3, 4, 5, 6]);
});

test("a graceful leave removes the cell at once", async () => {
  const f = fleet();
  const list = phones(2);
  await f.pass("a", list);
  await f.pass("b", list);
  await f.a.leave();
  f.advance(1_100);
  await f.pass("b", list);
  assert.deepEqual(f.b.status().cells, ["cell-b"]);
  assert.equal(f.a.shouldAcquire(list[0]!), false, "a cell that left asks for nothing");
});

test("a sendable phone nobody owns is reported after the alert threshold, once, and cleared when owned", () => {
  const tracker = new UnownedPhoneTracker(20_000, () => ({}));
  const list = [{ organizationId: 1, phoneNumberId: 9 }, { organizationId: 1, phoneNumberId: 1 }];
  tracker.observe(list, [false, true], 0);
  tracker.observe(list, [false, true], 19_999);
  assert.deepEqual(tracker.unownedPhoneIds(), []);
  tracker.observe(list, [false, true], 20_000);
  assert.deepEqual(tracker.unownedPhoneIds(), [9]);
  tracker.observe(list, [true, true], 25_000);
  assert.deepEqual(tracker.unownedPhoneIds(), []);
  tracker.observe(list, [false, true], 26_000);
  tracker.observe([], [], 60_000);
  assert.deepEqual(tracker.unownedPhoneIds(), [], "a phone that is no longer sendable is forgotten");
});

test("the in-memory store's membership, owner reads and handoff requests follow its clock", async () => {
  let now = 0;
  const store = new InMemoryPacingCoordinator(() => now);
  assert.deepEqual(await store.heartbeatCell({ cell: "cell-a", ownerId: "a1", ttlMs: 1_000 }), { cells: ["cell-a"], previousOwnerId: null });
  assert.deepEqual(await store.heartbeatCell({ cell: "cell-b", ownerId: "b1", ttlMs: 1_000 }), { cells: ["cell-a", "cell-b"], previousOwnerId: null });
  assert.equal((await store.heartbeatCell({ cell: "cell-a", ownerId: "a2", ttlMs: 1_000 })).previousOwnerId, "a1");
  now = 1_000;
  assert.deepEqual((await store.heartbeatCell({ cell: "cell-b", ownerId: "b1", ttlMs: 1_000 })).cells, ["cell-b"]);
  await store.leaveCell({ cell: "cell-b", ownerId: "someone-else" });
  assert.deepEqual((await store.heartbeatCell({ cell: "cell-c", ownerId: "c1", ttlMs: 1_000 })).cells, ["cell-b", "cell-c"]);
  await store.ensurePhoneOwnership({ organizationId: 1, phoneNumberId: 9, ownerId: "b1", ttlMs: 1_000 });
  assert.deepEqual(await store.peekPhoneOwners([{ organizationId: 1, phoneNumberId: 9 }, { organizationId: 1, phoneNumberId: 8 }]), ["b1", null]);
  await store.requestPhoneHandoff({ organizationId: 1, phoneNumberId: 9, cell: "cell-c", ttlMs: 1_000 });
  assert.deepEqual(await store.readPhoneHandoffRequests([{ organizationId: 1, phoneNumberId: 9 }]), ["cell-c"]);
  now = 2_000;
  assert.deepEqual(await store.readPhoneHandoffRequests([{ organizationId: 1, phoneNumberId: 9 }]), [null]);
  assert.deepEqual(await store.peekPhoneOwners([{ organizationId: 1, phoneNumberId: 9 }]), [null]);
});
