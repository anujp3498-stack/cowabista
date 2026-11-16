/**
 * Automatic phone-to-cell assignment (V2-372).
 *
 * The defect class this removes: with static per-cell scopes (CAMPAIGN_TRANSPORT_PHONE_IDS) a phone whose id is in
 * no cell's scope is never discovered, never owned and never sent, and nothing says so (production: phone 9 outside
 * "1-4" and "5-8"). In automatic mode every cell sees every sendable phone and the cells agree, without a central
 * allocator, on which cell should own each one:
 *
 * - Membership. Each cell heartbeats its name into Redis (coordinator clock, short TTL). The live cells are the
 *   members whose heartbeat has not expired, so a killed cell drops out by itself.
 * - Preference. Every cell computes the same plan from the same inputs (live cells, sendable phones and their lane
 *   weight): rendezvous hashing per phone, bounded by a per-cell load limit, so phones spread evenly and a change
 *   in membership moves as few phones as possible. The plan gives each phone an ordered list of cells.
 * - Acquisition. The first cell in a phone's list asks for it as soon as nobody holds it. The others ask only after
 *   it has been seen unowned for a grace period that grows with their rank, so a cell that cannot take a phone (no
 *   capacity, its credential does not bind, it is wedged) is covered by the next one.
 * - Rebalance. A phone held by another cell is requested by its first-choice cell (a short-lived handoff request).
 *   The holder hands it over gracefully: it stops claiming new work for that phone, sends what it already
 *   prepared, then releases the lease, and the requester acquires it. Handoffs are rate limited and a fresh lane is
 *   held for a minimum time, so membership flaps cannot make phones bounce.
 *
 * Safety is not delegated to any of this. Ownership is still the coordinator's fenced lease
 * (ensurePhoneOwnership): one owner at a time, a new fencing token on every change of owner, the transport fenced
 * to the token, and recovery of a previous owner's work exactly as before (Decision 8). A stale membership view
 * or a disagreement between cells can delay a phone by a grace period or cost an extra handoff; it cannot make two
 * runtimes send for the same phone. Pacing is a shared per-phone Redis cursor, so the provider-approved TPS holds
 * across a handoff as it does within one cell.
 */
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import type { PhoneAssignmentStore, PhoneOwnershipRef } from "./campaign-pacing-coordinator";

export type PhoneAssignmentTimings = {
  /** How often a cell refreshes its membership. */
  heartbeatIntervalMs: number;
  /** How long a membership lives without a refresh (coordinator clock). */
  membershipTtlMs: number;
  /** How often owners are read, handoff requests written and read, and unowned phones checked. */
  evaluationIntervalMs: number;
  /** A lower-ranked cell waits rank × this after a phone was first seen unowned before it asks for it. */
  fallbackGraceMs: number;
  /** Lifetime of one handoff request; the requester renews it while it still wants the phone. */
  handoffRequestTtlMs: number;
  /** A cell asks other cells for phones only after it has been a member this long (no requests while joining). */
  joinStableMs: number;
  /** A lane is never handed off before it has been held this long. */
  minHoldMs: number;
  /** Minimum time between the starts of two handoffs by one cell. */
  handoffIntervalMs: number;
  /** Handoffs one cell runs at the same time. */
  maxConcurrentHandoffs: number;
  /** A handoff that has not drained after this long releases anyway (what is left is settled not-started). */
  handoffMaxMs: number;
  /** A sendable phone with no owner for this long is reported as an error. */
  unownedAlertMs: number;
  /** The per-cell load bound is this multiple of an even share (never below the heaviest phone). */
  loadSlack: number;
};

export const DEFAULT_PHONE_ASSIGNMENT_TIMINGS: Readonly<PhoneAssignmentTimings> = Object.freeze({
  heartbeatIntervalMs: 1_000,
  membershipTtlMs: 5_000,
  evaluationIntervalMs: 500,
  fallbackGraceMs: 2_000,
  handoffRequestTtlMs: 3_000,
  joinStableMs: 5_000,
  minHoldMs: 15_000,
  handoffIntervalMs: 2_000,
  maxConcurrentHandoffs: 1,
  handoffMaxMs: 15_000,
  unownedAlertMs: 20_000,
  loadSlack: 1.25,
});

const CELL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Longest a graceful stop waits to leave the membership. */
const LEAVE_TIMEOUT_MS = 1_000;

export function validateCellName(name: string): string {
  if (!CELL_NAME.test(name)) {
    throw new RangeError(`Campaign cell name "${name}" must be 1-64 characters of letters, digits, '.', '_' or '-'`);
  }
  return name;
}

export function phoneAssignmentKey(phone: PhoneOwnershipRef): string {
  return `${phone.organizationId}:${phone.phoneNumberId}`;
}

function rendezvousScore(cell: string, phoneKey: string): bigint {
  return createHash("sha256").update(cell).update("\0").update(phoneKey).digest().readBigUInt64BE(0);
}

/** Cells in rendezvous (highest random weight) order for one phone: deterministic, the same on every cell. */
export function rendezvousOrder(cells: readonly string[], phoneKey: string): string[] {
  return cells
    .map((cell) => ({ cell, score: rendezvousScore(cell, phoneKey) }))
    .sort((a, b) => (a.score === b.score ? (a.cell < b.cell ? -1 : 1) : a.score > b.score ? -1 : 1))
    .map(({ cell }) => cell);
}

export type AssignmentPhoneWeight = { key: string; weight: number };

/**
 * The fleet plan: for each phone, its cells in order of preference (the first is the assigned cell). A pure
 * function of its inputs, so every cell computes the same plan from the same view. Heavier phones are placed
 * first; each goes to the first cell in its rendezvous order whose load stays within the bound, else to the first
 * that stays within cellCapacity, else to its rendezvous first (a fleet without room: that cell refuses it for
 * capacity and the phone is reported unowned).
 */
export function planPhoneAssignment(input: {
  cells: readonly string[];
  phones: ReadonlyArray<AssignmentPhoneWeight>;
  cellCapacity: number;
  loadSlack: number;
}): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  const cells = [...new Set(input.cells)].sort();
  if (!cells.length || !input.phones.length) return plan;
  const total = input.phones.reduce((sum, phone) => sum + phone.weight, 0);
  const heaviest = input.phones.reduce((max, phone) => Math.max(max, phone.weight), 0);
  const bound = Math.min(input.cellCapacity, Math.max(heaviest, Math.ceil((total / cells.length) * input.loadSlack)));
  const load = new Map(cells.map((cell) => [cell, 0]));
  const ordered = [...input.phones].sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const phone of ordered) {
    const order = rendezvousOrder(cells, phone.key);
    const pick = order.find((cell) => load.get(cell)! + phone.weight <= bound)
      ?? order.find((cell) => load.get(cell)! + phone.weight <= input.cellCapacity)
      ?? order[0]!;
    load.set(pick, load.get(pick)! + phone.weight);
    plan.set(phone.key, [pick, ...order.filter((cell) => cell !== pick)]);
  }
  return plan;
}

/**
 * Reports a sendable phone that no runtime has owned for `alertAfterMs`, once per episode, and when it is owned
 * again. Shared by automatic mode and by static scopes, where it is the only signal that a phone is in no cell's
 * scope.
 */
export class UnownedPhoneTracker {
  private readonly since = new Map<string, { phone: PhoneOwnershipRef; since: number }>();
  private readonly alerted = new Set<string>();

  constructor(
    private readonly alertAfterMs: number,
    private readonly context: () => Record<string, unknown>,
  ) {}

  /** Records one observation: `owned[i]` says whether phones[i] currently has any owner. Phones not listed are forgotten. */
  observe(phones: ReadonlyArray<PhoneOwnershipRef>, owned: ReadonlyArray<boolean>, now: number): void {
    const seen = new Set<string>();
    phones.forEach((phone, index) => {
      const key = phoneAssignmentKey(phone);
      seen.add(key);
      if (owned[index]) {
        this.since.delete(key);
        return;
      }
      if (!this.since.has(key)) this.since.set(key, { phone, since: now });
    });
    for (const key of [...this.since.keys()]) if (!seen.has(key)) this.since.delete(key);
    for (const [key, { phone, since }] of this.since) {
      if (this.alerted.has(key) || now - since < this.alertAfterMs) continue;
      this.alerted.add(key);
      logger.error({
        organizationId: phone.organizationId,
        phoneNumberId: phone.phoneNumberId,
        unownedForMs: now - since,
        ...this.context(),
      }, "Sendable phone has no transport owner; its campaigns are not sending");
    }
    for (const key of [...this.alerted]) {
      if (this.since.has(key)) continue;
      this.alerted.delete(key);
      if (seen.has(key)) {
        const [organizationId, phoneNumberId] = key.split(":").map(Number);
        logger.info({ organizationId, phoneNumberId, ...this.context() }, "Sendable phone has a transport owner again");
      }
    }
  }

  /** Phones currently reported unowned (past the alert threshold). */
  unownedPhoneIds(): number[] {
    return [...this.alerted].map((key) => Number(key.split(":")[1])).sort((a, b) => a - b);
  }
}

export type AssignmentPhone = PhoneOwnershipRef & { weight: number };

export type PhoneAssignmentStatus = {
  mode: "auto";
  cell: string;
  cells: string[];
  /** Phones this cell's plan assigns to itself. */
  assignedPhoneIds: number[];
  /** Sendable phones no runtime has owned for longer than the alert threshold. */
  unownedPhoneIds: number[];
  /** Phones this cell is handing to their assigned cell. */
  handoffPhoneIds: number[];
};

/**
 * One cell's view of the automatic assignment. The reservoir calls refresh() once per discovery pass, then asks
 * shouldAcquire() for each sendable phone it has no lane for, and handoffRequested() for each lane it holds.
 */
export class PhoneAssignmentController {
  private cells: string[] = [];
  private joinedAt: number | undefined;
  private heartbeats = 0;
  private nextHeartbeatAt = 0;
  private nextEvaluationAt = 0;
  private planSignature = "";
  private plan = new Map<string, string[]>();
  /** Last observed owner of each sendable phone this cell holds no lane for (null: unowned). */
  private readonly owners = new Map<string, string | null>();
  /** When each of those phones was first seen unowned in its current episode. */
  private readonly freeSince = new Map<string, number>();
  /** Held phones whose assigned cell asked for them at the last evaluation. */
  private requested = new Set<string>();
  private readonly handoffs = new Set<string>();
  private lastHandoffStartedAt = Number.NEGATIVE_INFINITY;
  private lastDuplicateWarningAt = Number.NEGATIVE_INFINITY;
  private left = false;
  readonly timings: Readonly<PhoneAssignmentTimings>;
  private readonly unowned: UnownedPhoneTracker;

  constructor(
    private readonly store: PhoneAssignmentStore,
    readonly cell: string,
    private readonly ownerId: string,
    private readonly cellCapacity: number,
    timings: Partial<PhoneAssignmentTimings> = {},
    private readonly now: () => number = Date.now,
  ) {
    validateCellName(cell);
    this.timings = Object.freeze({ ...DEFAULT_PHONE_ASSIGNMENT_TIMINGS, ...timings });
    this.unowned = new UnownedPhoneTracker(this.timings.unownedAlertMs, () => ({ cell: this.cell, cells: this.cells }));
  }

  /**
   * Refreshes membership (when due) and the plan (when its inputs changed); on the evaluation cadence also reads
   * the owners of phones this cell does not hold, renews this cell's handoff requests and reads the requests made
   * for phones it holds. `holds` says whether this cell has a lane for a phone; `canRequest` whether it could take
   * one now (capacity, credential not failing).
   */
  async refresh(
    phones: ReadonlyArray<AssignmentPhone>,
    context: { holds(phone: PhoneOwnershipRef): boolean; canRequest(phone: PhoneOwnershipRef): boolean },
  ): Promise<void> {
    if (this.left) return;
    let now = this.now();
    if (now >= this.nextHeartbeatAt) {
      const membership = await this.store.heartbeatCell({ cell: this.cell, ownerId: this.ownerId, ttlMs: this.timings.membershipTtlMs });
      now = this.now();
      this.heartbeats += 1;
      if (
        this.heartbeats > 1
        && membership.previousOwnerId !== null
        && membership.previousOwnerId !== this.ownerId
        && now - this.lastDuplicateWarningAt >= 60_000
      ) {
        this.lastDuplicateWarningAt = now;
        logger.warn({ cell: this.cell }, "Another runtime is heartbeating under this campaign cell name; give every cell a distinct CAMPAIGN_CELL");
      }
      this.joinedAt ??= now;
      const cells = [...new Set([...membership.cells, this.cell])].sort();
      if (cells.join(",") !== this.cells.join(",")) {
        logger.info({ cell: this.cell, cells, previousCells: this.cells }, "Campaign transport cells changed");
        this.cells = cells;
      }
      this.nextHeartbeatAt = now + this.timings.heartbeatIntervalMs;
    }

    const weights = phones.map((phone) => ({ key: phoneAssignmentKey(phone), weight: phone.weight }));
    const signature = `${this.cells.join(",")}|${weights.map(({ key, weight }) => `${key}=${weight}`).join(",")}`;
    if (signature !== this.planSignature) {
      this.plan = planPhoneAssignment({
        cells: this.cells,
        phones: weights,
        cellCapacity: this.cellCapacity,
        loadSlack: this.timings.loadSlack,
      });
      this.planSignature = signature;
    }
    const active = new Set(weights.map(({ key }) => key));
    for (const key of [...this.owners.keys()]) if (!active.has(key)) this.owners.delete(key);
    for (const key of [...this.freeSince.keys()]) if (!active.has(key)) this.freeSince.delete(key);

    if (now < this.nextEvaluationAt) return;
    this.nextEvaluationAt = now + this.timings.evaluationIntervalMs;

    const held = phones.filter((phone) => context.holds(phone));
    const notHeld = phones.filter((phone) => !context.holds(phone));
    for (const phone of held) {
      this.owners.delete(phoneAssignmentKey(phone));
      this.freeSince.delete(phoneAssignmentKey(phone));
    }
    const owners = await this.store.peekPhoneOwners(notHeld);
    now = this.now();
    notHeld.forEach((phone, index) => {
      const key = phoneAssignmentKey(phone);
      const owner = owners[index] ?? null;
      this.owners.set(key, owner);
      if (owner === null) {
        if (!this.freeSince.has(key)) this.freeSince.set(key, now);
      } else {
        this.freeSince.delete(key);
      }
    });
    this.unowned.observe(
      [...held, ...notHeld],
      [...held.map(() => true), ...notHeld.map((_, index) => (owners[index] ?? null) !== null)],
      now,
    );

    // As requester: ask the holder of each phone assigned here to hand it over, once this cell has settled in.
    if (this.joinedAt !== undefined && now - this.joinedAt >= this.timings.joinStableMs) {
      const wanted = notHeld.filter((phone) => {
        const owner = this.owners.get(phoneAssignmentKey(phone));
        return this.assignedCell(phone) === this.cell
          && owner !== null && owner !== undefined && owner !== this.ownerId
          && context.canRequest(phone);
      });
      await Promise.all(wanted.map((phone) => this.store.requestPhoneHandoff({
        organizationId: phone.organizationId,
        phoneNumberId: phone.phoneNumberId,
        cell: this.cell,
        ttlMs: this.timings.handoffRequestTtlMs,
      })));
    }

    // As holder: which held phones did their assigned (and live) cell ask for?
    const foreign = held.filter((phone) => this.assignedCell(phone) !== this.cell);
    const requests = await this.store.readPhoneHandoffRequests(foreign);
    this.requested = new Set(foreign
      .filter((phone, index) => {
        const requester = requests[index];
        return requester !== null && requester !== undefined
          && requester === this.assignedCell(phone)
          && this.cells.includes(requester);
      })
      .map(phoneAssignmentKey));
  }

  /** The cell the current plan assigns this phone to, or undefined before the first plan. */
  assignedCell(phone: PhoneOwnershipRef): string | undefined {
    return this.plan.get(phoneAssignmentKey(phone))?.[0];
  }

  /** Whether this cell should ask the coordinator for a phone it holds no lane for, on this pass. */
  shouldAcquire(phone: PhoneOwnershipRef): boolean {
    if (this.left) return false;
    const key = phoneAssignmentKey(phone);
    const order = this.plan.get(key);
    if (!order) return false;
    const owner = this.owners.get(key);
    // Our own lease without a lane (a pass that failed between acquiring and building the lane): renew and rebuild.
    if (owner === this.ownerId) return true;
    const rank = order.indexOf(this.cell);
    if (rank < 0) return false;
    // The assigned cell asks whenever nobody is known to hold the phone (and once before its first owner read).
    if (rank === 0) return owner === undefined || owner === null;
    const since = this.freeSince.get(key);
    return owner === null && since !== undefined && this.now() - since >= this.timings.fallbackGraceMs * rank;
  }

  /** Whether the phone's assigned cell asked this cell, which holds it, to hand it over. */
  handoffRequested(phone: PhoneOwnershipRef): boolean {
    return this.requested.has(phoneAssignmentKey(phone)) && this.assignedCell(phone) !== this.cell;
  }

  /** Rate limit for starting a handoff. */
  mayStartHandoff(): boolean {
    return !this.left
      && this.handoffs.size < this.timings.maxConcurrentHandoffs
      && this.now() - this.lastHandoffStartedAt >= this.timings.handoffIntervalMs;
  }

  handoffStarted(phone: PhoneOwnershipRef): void {
    this.handoffs.add(phoneAssignmentKey(phone));
    this.lastHandoffStartedAt = this.now();
    this.requested.delete(phoneAssignmentKey(phone));
  }

  handoffEnded(phone: PhoneOwnershipRef): void {
    this.handoffs.delete(phoneAssignmentKey(phone));
  }

  /**
   * Graceful stop: leave the membership so the other cells re-plan at once. Never throws and never waits more than
   * LEAVE_TIMEOUT_MS: a Redis that hangs must not hold up the stop (the membership then expires on its own).
   */
  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.store.leaveCell({ cell: this.cell, ownerId: this.ownerId }),
        new Promise<never>((_, reject) => {
          // Not unref'd: during shutdown this timer may be what keeps the process alive until stop() finishes.
          timer = setTimeout(() => reject(new Error(`leaving the membership took more than ${LEAVE_TIMEOUT_MS} ms`)), LEAVE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      logger.warn({ cell: this.cell, error: error instanceof Error ? error.message : String(error) }, "Campaign cell could not leave the membership; it expires on its own");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status(): PhoneAssignmentStatus {
    const assigned = [...this.plan.entries()]
      .filter(([, order]) => order[0] === this.cell)
      .map(([key]) => Number(key.split(":")[1]))
      .sort((a, b) => a - b);
    return {
      mode: "auto",
      cell: this.cell,
      cells: [...this.cells],
      assignedPhoneIds: assigned,
      unownedPhoneIds: this.unowned.unownedPhoneIds(),
      handoffPhoneIds: [...this.handoffs].map((key) => Number(key.split(":")[1])).sort((a, b) => a - b),
    };
  }
}
