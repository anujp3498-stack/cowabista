/**
 * Phone scope: the deterministic set of phone numbers one transport runtime
 * process is allowed to discover, fence and process.
 *
 * Horizontal transport is a set of runtime processes ("cells"), each owning a
 * disjoint slice of the phones. Without a scope every runtime discovers every
 * Running phone and competes for ownership, so the first process to fence a
 * phone takes it regardless of the operator's intent. With a scope a runtime
 * never even attempts ownership outside its slice.
 *
 * Ownership itself is unchanged: inside the scope the coordinator's Redis
 * lease (fencing token + TTL) still decides who owns a phone, still rejects a
 * stale process, and still lets a phone move to another runtime once the
 * previous owner releases it or its lease expires. The scope only bounds
 * which phones a runtime asks for.
 *
 * Configuration: CAMPAIGN_TRANSPORT_PHONE_IDS="1,2,3,4" or "1-4,9" (phone
 * number ids, ranges inclusive). Unset or empty keeps the single-runtime
 * behaviour: the runtime owns everything it discovers.
 */
export const CAMPAIGN_TRANSPORT_PHONE_IDS_ENV = "CAMPAIGN_TRANSPORT_PHONE_IDS";

const MAX_SCOPE_SIZE = 65_536;

/** Parses "1,2,3" / "1-4,9" into a set of phone ids; undefined when the value is unset or blank. */
export function parsePhoneScope(value: string | undefined | null): ReadonlySet<number> | undefined {
  if (value === undefined || value === null) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const ids = new Set<number>();
  for (const rawPart of text.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const single = /^\d+$/.test(part);
    if (!range && !single) {
      throw new RangeError(`${CAMPAIGN_TRANSPORT_PHONE_IDS_ENV}: "${part}" is not a phone id or an inclusive range like 1-4`);
    }
    const from = Number(range ? range[1] : part);
    const to = Number(range ? range[2] : part);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      throw new RangeError(`${CAMPAIGN_TRANSPORT_PHONE_IDS_ENV}: "${part}" must name positive phone ids in ascending order`);
    }
    if (to - from + 1 + ids.size > MAX_SCOPE_SIZE) {
      throw new RangeError(`${CAMPAIGN_TRANSPORT_PHONE_IDS_ENV}: scope larger than ${MAX_SCOPE_SIZE} phones`);
    }
    for (let id = from; id <= to; id += 1) ids.add(id);
  }
  return ids.size ? ids : undefined;
}

/** The process-level scope from the environment; undefined means unscoped (own everything discovered). */
export function phoneScopeFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<number> | undefined {
  return parsePhoneScope(env[CAMPAIGN_TRANSPORT_PHONE_IDS_ENV]);
}

/** Stable, compact rendering for logs and metrics: "1-4,9" style. */
export function describePhoneScope(scope: ReadonlySet<number> | undefined): string {
  if (!scope || scope.size === 0) return "all";
  const sorted = [...scope].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (const id of sorted.slice(1)) {
    if (id === previous + 1) {
      previous = id;
      continue;
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
    start = id;
    previous = id;
  }
  parts.push(start === previous ? String(start) : `${start}-${previous}`);
  return parts.join(",");
}
