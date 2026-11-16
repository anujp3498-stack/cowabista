/*
 * Runs the expired-lease reaper the way production housekeeping runs it, for tests that assert a lease is recovered.
 *
 * The contract (CampaignRuntime, B13 R6): startCampaignRuntime() calls start() with its default 100 ms tick, so the
 * housekeeping timer fires every min(100, HOUSEKEEPING_INTERVAL_MS = 200) = 100 ms and is skipped while a pass still
 * runs. A pass reaps expired leases oldest expiry first (nulls first, then id) in batches of REAP_BATCH_LIMIT and always
 * completes one batch before it checks its REAP_PASS_BUDGET_MS. So a job with `ahead` expired leases ordered before it
 * is reaped by pass floor(ahead / REAP_BATCH_LIMIT) + 1 at the latest, however many campaigns those leases belong to.
 *
 * One pass is not that contract: in the shared test database expired leases other suites left behind are older and
 * come first, so a single pass may not reach the job (CI 43863340429, validate-prepared-batch M; failure-settlement G
 * locally). reapLikeHousekeeping counts the backlog actually ahead of the jobs, runs passes on the production cadence
 * until none of them is 'Processing', and reports the passes it took against that bound (plus one pass of slack);
 * callers assert passes <= bound, so a stuck or unfair reaper still fails.
 */
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { campaignJobsTable, db, pool } from "@workspace/db";
import { CampaignRuntime } from "../src/services/campaign-runtime";

export const HOUSEKEEPING_TIMER_MS = 100;

export async function reapLikeHousekeeping(jobIds: number[]): Promise<{ ahead: number; passes: number; bound: number }> {
  assert.ok(jobIds.length > 0);
  const { rows } = await pool.query<{ id: number; expired: boolean; ahead: number }>(`
    select me.id,
           (me.lease_expires_at is null or me.lease_expires_at <= statement_timestamp()) as expired,
           (select count(*)::int from campaign_jobs j
              join campaigns c on c.id = j.campaign_id and c.organization_id = j.organization_id
             where j.status = 'Processing'
               and (j.lease_expires_at is null or j.lease_expires_at <= statement_timestamp())
               and (j.lease_expires_at is null
                    or (me.lease_expires_at is not null
                        and (j.lease_expires_at < me.lease_expires_at
                             or (j.lease_expires_at = me.lease_expires_at and j.id < me.id))))) as ahead
      from campaign_jobs me where me.id = any($1::int[]) and me.status = 'Processing'`, [jobIds]);
  assert.equal(rows.length, jobIds.length, "every job must still be 'Processing' before the reaper runs");
  for (const row of rows) assert.ok(row.expired, `job ${row.id}'s lease must already have expired`);
  const ahead = Math.max(...rows.map((row) => row.ahead));
  const bound = Math.floor(ahead / CampaignRuntime.REAP_BATCH_LIMIT) + 2;
  const reaper = new CampaignRuntime() as unknown as { reapExpiredLeases(now: Date): Promise<void> };
  for (let pass = 1; pass <= bound; pass += 1) {
    await reaper.reapExpiredLeases(new Date());
    const left = await db.select({ status: campaignJobsTable.status }).from(campaignJobsTable).where(inArray(campaignJobsTable.id, jobIds));
    if (left.every((row) => row.status !== "Processing")) return { ahead, passes: pass, bound };
    await new Promise((resolve) => setTimeout(resolve, HOUSEKEEPING_TIMER_MS));
  }
  return { ahead, passes: bound + 1, bound };
}

/** The assertion every caller makes: the reaper reached the jobs within the bound the contract allows. */
export async function assertReapedLikeHousekeeping(jobIds: number[]): Promise<void> {
  const reaped = await reapLikeHousekeeping(jobIds);
  assert.ok(reaped.passes <= reaped.bound,
    `the reaper must reach the job(s) within ${reaped.bound} housekeeping passes (${reaped.ahead} expired leases ahead); it did not`);
}

/**
 * For a NEGATIVE check (a lease that must not be reaped): runs passes on the production cadence until the reaper has
 * reached every lease that is expired on the database clock (bounded the same way), so "still Processing" afterwards
 * means the reaper reached past the job and left it, not that a backlog kept one pass from reaching it. `now` is
 * passed through to reapExpiredLeases (tests use it to simulate a fast application clock).
 */
export async function drainExpiredLeases(now: () => Date = () => new Date()): Promise<{ expired: number; passes: number; bound: number }> {
  const countExpired = async () => (await pool.query<{ n: number }>(`
    select count(*)::int as n from campaign_jobs j
      join campaigns c on c.id = j.campaign_id and c.organization_id = j.organization_id
     where j.status = 'Processing' and (j.lease_expires_at is null or j.lease_expires_at <= statement_timestamp())`)).rows[0]!.n;
  const expired = await countExpired();
  const bound = Math.floor(expired / CampaignRuntime.REAP_BATCH_LIMIT) + 2;
  const reaper = new CampaignRuntime() as unknown as { reapExpiredLeases(now: Date): Promise<void> };
  for (let pass = 1; pass <= bound; pass += 1) {
    await reaper.reapExpiredLeases(now());
    if (await countExpired() === 0) return { expired, passes: pass, bound };
    await new Promise((resolve) => setTimeout(resolve, HOUSEKEEPING_TIMER_MS));
  }
  assert.fail(`the reaper did not reach every expired lease within ${bound} housekeeping passes (${expired} expired)`);
}

