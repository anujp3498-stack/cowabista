// Standalone entry point for campaign-worker-os-crash-recovery.test.ts.
//
// This boots ONLY the campaign runtime (claim + process + housekeeping
// loops) as its own OS process, with no HTTP server -- so the test can
// `spawn()` it, `kill(pid, "SIGKILL")` it while a send is genuinely
// in-flight, and later spawn a fresh instance to stand in for a real
// restarted worker process. This is deliberately NOT reachable from the
// production `dev`/`start` scripts; it exists only for this test.
import { CampaignRuntime } from "../src/services/campaign-runtime";

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? "50");
const leaseMsRaw = process.env.WORKER_LEASE_MS;
const leaseMs = leaseMsRaw === undefined ? undefined : Number(leaseMsRaw);
const brokerAbandonedDeliveryMsRaw = process.env.BROKER_ABANDONED_DELIVERY_MS;
const brokerAbandonedDeliveryMs = brokerAbandonedDeliveryMsRaw === undefined
  ? undefined
  : Number(brokerAbandonedDeliveryMsRaw);

// V2-372 test seam: shorter automatic-assignment timings, as JSON (the mode itself comes from the environment).
const assignmentTimings = process.env.WORKER_ASSIGNMENT_TIMINGS ? JSON.parse(process.env.WORKER_ASSIGNMENT_TIMINGS) : undefined;

const runtime = new CampaignRuntime(undefined, leaseMs, { brokerAbandonedDeliveryMs, assignmentTimings });
runtime.start(intervalMs);

// Printed once the claim/housekeeping timers are live, so the parent
// process can synchronize on real readiness instead of guessing a delay.
console.log(`WORKER_HARNESS_READY pid=${process.pid} intervalMs=${intervalMs} leaseMs=${leaseMs ?? "default"}`);

// Never exits on its own -- the test kills it (SIGKILL to simulate a real
// crash, or SIGTERM for a clean shutdown of the replacement instance).
process.on("SIGTERM", () => {
  void runtime.stop().finally(() => process.exit(0));
});
