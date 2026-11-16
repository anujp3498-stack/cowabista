/**
 * STOP fail-closed (opt-out while a message may be in flight). A STOP marks every pending intent of the recipient
 * delivery_unknown with a reason starting with this text: whether the provider received the request is not known
 * at that moment (another cell may be mid-request; this one may be). delivery_unknown is never re-armed (a re-
 * preparation fails it for manual reconciliation), so deleting the suppression later can never re-send it. Two
 * things lift the mark, and only these: a path that proves the work never started, while it still holds the job's
 * lease (it turns the intent into a re-armable 'rejected'), and a definite provider outcome for that request
 * (accepted with an id: 'sent'; refused: 'rejected'). Every other delivery_unknown is untouched by both.
 */
export const OPT_OUT_UNCONFIRMED_REASON = "Recipient opted out while the message was armed; provider outcome unconfirmed";

/** The abort reason of an in-process STOP (abortRecipient), so dispatch can tell it from a kill, pause or lease loss. */
export class RecipientOptOutAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientOptOutAbort";
  }
}

type Entry = {
  campaignId: number;
  controller: AbortController;
  organizationId?: number;
  recipient?: string;
};

export class InFlightRegistry {
  private readonly entries = new Map<string, Entry>();

  register(campaignId: number, jobId: number, leaseToken: string): { key: string; signal: AbortSignal; abort: (reason: string) => void } {
    const key = `${campaignId}:${jobId}:${leaseToken}`;
    const controller = new AbortController();
    this.entries.set(key, { campaignId, controller });
    return { key, signal: controller.signal, abort: (reason) => controller.abort(new Error(reason)) };
  }

  release(key: string): void {
    this.entries.delete(key);
  }

  bindRecipient(key: string, organizationId: number, recipient: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.organizationId = organizationId;
      entry.recipient = recipient;
    }
  }

  abortRecipient(organizationId: number, recipient: string, reason: string): number {
    let aborted = 0;
    for (const entry of this.entries.values()) {
      if (entry.organizationId === organizationId && entry.recipient === recipient) {
        entry.controller.abort(new RecipientOptOutAbort(reason));
        aborted += 1;
      }
    }
    return aborted;
  }

  abortCampaign(campaignId: number, reason: string): void {
    for (const entry of this.entries.values()) {
      if (entry.campaignId === campaignId) entry.controller.abort(new Error(reason));
    }
  }

  abortLease(campaignId: number, jobId: number, leaseToken: string, reason: string): boolean {
    const entry = this.entries.get(`${campaignId}:${jobId}:${leaseToken}`);
    if (!entry) return false;
    entry.controller.abort(new Error(reason));
    return true;
  }

  abortAll(reason: string): void {
    for (const entry of this.entries.values()) entry.controller.abort(new Error(reason));
  }

  get size(): number {
    return this.entries.size;
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.entries.size && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return this.entries.size === 0;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const inFlightRegistry = new InFlightRegistry();