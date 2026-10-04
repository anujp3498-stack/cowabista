import { createHash } from "node:crypto";

// Allocator v2 (V2-06A): a PURE, deterministic decision of (sender lane,
// template) for one recipient, made at planning time and frozen in
// campaign_allocations. No database, provider, credential, clock, random
// source or mutable state: the same frozen input and the same recipient
// identity always give the same answer, in any process, in any page size,
// in any input order. The runtime never calls this; it executes the frozen
// decision (and its live safety checks are permission gates, never a
// second allocator).
//
// Input contract (built by planning from ONE V2-04 compatibility snapshot):
//  - lanes: one per selected number (one campaign_routes row each), with
//    its configured rate (the lane's whole, shared budget) and the selected
//    templates decidePair() found eligible for it. Pairs never come from
//    anywhere else -- the allocator does not compare WABAs or statuses.
//  - templateIds: the selected templates.
//  - mode: "equal_numbers" or "equal_templates".
// Completeness is required: every lane must have >= 1 eligible template and
// every template >= 1 eligible lane; otherwise the input is refused (no
// lane or template is ever dropped or substituted).

export type DistributionMode = "equal_numbers" | "equal_templates";

export type AllocatorLane = {
  routeId: number;
  phoneNumberId: number;
  /** Configured messages/second for this sender lane (integer >= 1). Weight for equal_templates. */
  rate: number;
  /** Selected templates this lane may send (V2-04 eligible at planning). */
  templateIds: number[];
};

export type AllocatorV2Input = {
  mode: DistributionMode;
  lanes: AllocatorLane[];
  templateIds: number[];
};

export type AllocatorV2Decision = { routeId: number; phoneNumberId: number; templateId: number };

export class AllocatorInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "AllocatorInputError";
  }
}

/**
 * Independent hash domains: the sender choice, the template choice and the
 * weighted choice inside a template bucket each hash the recipient with a
 * different prefix, so they are not correlated. 48 bits of SHA-256 give a
 * modulo bias far below the statistical tolerance of any realistic count.
 */
export function domainHash(domain: string, recipientKey: string): number {
  return createHash("sha256").update(`${domain}:${recipientKey}`).digest().readUIntBE(0, 6);
}

const byNumber = (a: number, b: number) => a - b;

/** Validates and canonicalizes the input; the result is independent of the caller's array order. */
export function canonicalAllocatorInput(input: AllocatorV2Input): AllocatorV2Input {
  const problems: string[] = [];
  if (input.mode !== "equal_numbers" && input.mode !== "equal_templates") problems.push(`Unsupported distribution mode ${String(input.mode)}`);
  const templateIds = [...new Set(input.templateIds)].sort(byNumber);
  const selected = new Set(templateIds);
  if (!templateIds.length) problems.push("Select at least one template");
  if (!input.lanes.length) problems.push("Select at least one sending number");
  const phones = new Set<number>();
  const routes = new Set<number>();
  const lanes = input.lanes.map((lane) => ({ ...lane, templateIds: [...new Set(lane.templateIds)].sort(byNumber) }))
    // Canonical order: by sending number (a stable identity across replans), then route.
    .sort((a, b) => a.phoneNumberId - b.phoneNumberId || a.routeId - b.routeId);
  for (const lane of lanes) {
    if (phones.has(lane.phoneNumberId)) problems.push(`Number ${lane.phoneNumberId} has more than one sender lane`);
    if (routes.has(lane.routeId)) problems.push(`Route ${lane.routeId} appears twice`);
    phones.add(lane.phoneNumberId);
    routes.add(lane.routeId);
    if (!Number.isInteger(lane.rate) || lane.rate < 1) problems.push(`Number ${lane.phoneNumberId} needs a positive integer rate`);
    if (!lane.templateIds.length) problems.push(`Number ${lane.phoneNumberId} cannot send any selected template`);
    for (const templateId of lane.templateIds) {
      if (!selected.has(templateId)) problems.push(`Number ${lane.phoneNumberId} lists template ${templateId}, which is not selected`);
    }
  }
  for (const templateId of templateIds) {
    if (!lanes.some((lane) => lane.templateIds.includes(templateId))) problems.push(`Template ${templateId} has no eligible selected number`);
  }
  if (problems.length) throw new AllocatorInputError([...new Set(problems)]);
  return { mode: input.mode, lanes, templateIds };
}

export type AllocatorV2 = {
  input: AllocatorV2Input;
  allocate(recipientKey: string): AllocatorV2Decision;
};

/**
 * Builds the allocator for one frozen input. `allocate` is a pure function
 * of the recipient key (normalized phone): no counters, so page boundaries
 * and processing order cannot change any assignment.
 */
export function createAllocatorV2(rawInput: AllocatorV2Input): AllocatorV2 {
  const input = canonicalAllocatorInput(rawInput);
  const { lanes, templateIds } = input;
  // Per template: its eligible lanes (canonical order) and cumulative integer weights.
  const buckets = new Map(templateIds.map((templateId) => {
    const eligible = lanes.filter((lane) => lane.templateIds.includes(templateId));
    let running = 0;
    const cumulative = eligible.map((lane) => (running += lane.rate));
    return [templateId, { eligible, cumulative, total: running }] as const;
  }));

  const allocate = (recipientKey: string): AllocatorV2Decision => {
    if (input.mode === "equal_numbers") {
      // 1) a number, uniformly; 2) one of ITS eligible templates, uniformly.
      const lane = lanes[domainHash("sender", recipientKey) % lanes.length]!;
      const templateId = lane.templateIds[domainHash("template", recipientKey) % lane.templateIds.length]!;
      return { routeId: lane.routeId, phoneNumberId: lane.phoneNumberId, templateId };
    }
    // equal_templates: 1) a template, uniformly; 2) one of ITS eligible
    // numbers, proportionally to the numbers' configured rates.
    const templateId = templateIds[domainHash("template", recipientKey) % templateIds.length]!;
    const bucket = buckets.get(templateId)!;
    const point = domainHash(`weighted-sender:${templateId}`, recipientKey) % bucket.total;
    let index = 0;
    while (bucket.cumulative[index]! <= point) index++;
    const lane = bucket.eligible[index]!;
    return { routeId: lane.routeId, phoneNumberId: lane.phoneNumberId, templateId };
  };
  return { input, allocate };
}
