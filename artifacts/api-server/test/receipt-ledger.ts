/*
 * B13 R7: provider-receipt reconciliation for duplicate-delivery tests.
 *
 * The receipt is the mock provider's own record (CAMPAIGN_TEST_PROVIDER_LOG, written by the shard thread at the
 * provider call, before the call returns), so it survives a SIGKILL of the sending process and is independent of
 * every database row. Reconciling receipts against job rows and provider intents measures delivery, instead of
 * inferring it from job accounting:
 *
 *   sent_once                  Sent, exactly one receipt
 *   unknown_delivered_once     failed closed as delivery-unknown (manual reconciliation), exactly one receipt:
 *                              delivered once, correctly never re-sent, honestly recorded as unknown
 *   unknown_not_delivered      failed closed as delivery-unknown, no receipt
 *   failed_not_delivered       any other Failed/Cancelled, no receipt
 *   DUPLICATE_DELIVERY         two or more receipts for one job: the failure exactly-once must prevent
 *   SENT_WITHOUT_RECEIPT       Sent, but the provider never received it
 *   FAILED_BUT_DELIVERED       a definite failure (not delivery-unknown) that the provider did receive
 *   OPEN                       not terminal
 * plus receipts that match no job (orphans). `clean` requires no upper-case class and no orphan.
 */
export type ProviderReceipt = { key: string; line: number; pid?: number; at?: number };
export type ReconciledJob = {
  jobId: number;
  /** The recipient the job sends to; receipts are matched on it. */
  key: string;
  status: string;
  attempts: number;
  errorReason: string | null;
  intentStatus: string | null;
};
export type LedgerClass =
  | "sent_once" | "unknown_delivered_once" | "unknown_not_delivered" | "failed_not_delivered"
  | "DUPLICATE_DELIVERY" | "SENT_WITHOUT_RECEIPT" | "FAILED_BUT_DELIVERED" | "OPEN";
export type Reconciliation = {
  receipts: number;
  byClass: Record<LedgerClass, number>;
  duplicates: Array<{ job: ReconciledJob; receipts: ProviderReceipt[] }>;
  anomalies: Array<{ job: ReconciledJob; cls: LedgerClass; receipts: ProviderReceipt[] }>;
  orphanKeys: string[];
  clean: boolean;
};

export function parseProviderLog(text: string): ProviderReceipt[] {
  return text.split("\n").flatMap((raw, index) => {
    if (!raw.trim()) return [];
    const entry = JSON.parse(raw) as { payload?: { to?: string }; pid?: number; at?: number };
    const key = entry.payload?.to;
    // This log is a provider-only receipt stream: every non-empty line represents an actual send.
    // Silently skipping a malformed record could turn a real provider delivery into a false
    // "unknown_not_delivered" and make a duplicate/failover benchmark appear clean. Fail closed.
    if (typeof key !== "string" || !key.trim()) {
      throw new Error(`Provider receipt at line ${index + 1} has no recipient; reconciliation cannot be trusted`);
    }
    return [{ key, line: index + 1, pid: entry.pid, at: entry.at }];
  });
}

const UNKNOWN = /delivery is unknown|manual reconciliation/i;

export function reconcileReceipts(receipts: ProviderReceipt[], jobs: ReconciledJob[]): Reconciliation {
  const byKey = new Map<string, ProviderReceipt[]>();
  for (const receipt of receipts) byKey.set(receipt.key, [...(byKey.get(receipt.key) ?? []), receipt]);
  const byClass = Object.fromEntries(([
    "sent_once", "unknown_delivered_once", "unknown_not_delivered", "failed_not_delivered",
    "DUPLICATE_DELIVERY", "SENT_WITHOUT_RECEIPT", "FAILED_BUT_DELIVERED", "OPEN",
  ] as LedgerClass[]).map((cls) => [cls, 0])) as Record<LedgerClass, number>;
  const duplicates: Reconciliation["duplicates"] = [];
  const anomalies: Reconciliation["anomalies"] = [];
  const jobKeys = new Set<string>();
  for (const job of jobs) {
    jobKeys.add(job.key);
    const got = byKey.get(job.key) ?? [];
    const unknown = UNKNOWN.test(job.errorReason ?? "") || job.intentStatus === "delivery_unknown";
    let cls: LedgerClass;
    if (got.length >= 2) cls = "DUPLICATE_DELIVERY";
    else if (job.status === "Sent") cls = got.length === 1 ? "sent_once" : "SENT_WITHOUT_RECEIPT";
    else if (job.status === "Failed" || job.status === "Cancelled") {
      if (unknown) cls = got.length === 1 ? "unknown_delivered_once" : "unknown_not_delivered";
      else cls = got.length === 1 ? "FAILED_BUT_DELIVERED" : "failed_not_delivered";
    } else cls = "OPEN";
    byClass[cls] += 1;
    if (cls === "DUPLICATE_DELIVERY") duplicates.push({ job, receipts: got });
    if (cls === cls.toUpperCase()) anomalies.push({ job, cls, receipts: got });
  }
  const orphanKeys = [...byKey.keys()].filter((key) => !jobKeys.has(key));
  return { receipts: receipts.length, byClass, duplicates, anomalies, orphanKeys, clean: anomalies.length === 0 && orphanKeys.length === 0 };
}
