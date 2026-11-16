/*
 * prepareBatch's contract for a job its own checks refuse (route or contact missing, no recipient, template gone or
 * not approved, sending credential, eligibility, WABA mismatch): the refusal is reported for that job in the returned
 * map (PreparedProviderFailure, with the same error as before), never thrown for the whole batch, and nothing is armed
 * for it. Before, the first refused job threw out of prepareBatch and failed every job of the batch.
 */
import assert from "node:assert/strict";
import { PreparedProviderFailure } from "../src/services/campaign-queue";

/** Awaits prepareBatch and returns the error it refused `jobId` with; fails if the job was prepared or is missing. */
export async function preparationRefusal(prepared: Promise<Map<number, unknown>>, jobId: number): Promise<Error> {
  const contexts = await prepared;
  const outcome = contexts.get(jobId);
  assert.ok(outcome instanceof PreparedProviderFailure, `prepareBatch must refuse job ${jobId} (got ${outcome === undefined ? "nothing" : "a prepared context"})`);
  assert.ok(outcome.error instanceof Error, "the refusal carries the job's own error");
  return outcome.error;
}

/** Whether prepareBatch prepared `jobId` (a context, not a refusal). */
export function wasPrepared(contexts: Map<number, unknown>, jobId: number): boolean {
  const outcome = contexts.get(jobId);
  return outcome !== undefined && !(outcome instanceof PreparedProviderFailure);
}
