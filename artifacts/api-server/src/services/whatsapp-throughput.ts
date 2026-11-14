import type { MetaPhoneNumber } from "./whatsapp-provider";

// This is NOT a blanket 1,000 TPS default. Meta reports each number's own
// Cloud API tier: STANDARD 80 mps, HIGH 1,000 mps. Missing/unrecognized
// evidence retains the legacy conservative cap until observed explicitly.
export const UNVERIFIED_PHONE_TPS_LIMIT = 50;

export function observedProviderThroughput(phone: Pick<MetaPhoneNumber, "throughput">): {
  throughputLevel: string;
  approvedTpsLimit: number | null;
} {
  const level = phone.throughput?.level;
  if (level === "STANDARD") return { throughputLevel: level, approvedTpsLimit: 80 };
  if (level === "HIGH") return { throughputLevel: level, approvedTpsLimit: 1000 };
  return { throughputLevel: level ?? "UNKNOWN", approvedTpsLimit: null };
}

// `tpsLimit` doubles as an editable per-phone cap. When it was implicitly
// set to the previous Meta ceiling, move it with the new tier. Preserve an
// explicitly lower operator cap but clamp it on a downgrade.
export function refreshedTpsLimit(current: number, previousApproved: unknown, latestApproved: number | null): number {
  if (latestApproved === null) return current;
  // No previous Meta evidence: only the untouched legacy 50 TPS default
  // auto-upgrades. A manually configured lower rate must remain lower.
  const followedPreviousCap = typeof previousApproved === "number" && Number.isInteger(previousApproved)
    ? current === previousApproved
    : current === UNVERIFIED_PHONE_TPS_LIMIT;
  return followedPreviousCap ? latestApproved : Math.min(current, latestApproved);
}
