import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { CampaignRuntime } from "../src/services/campaign-runtime";
import { RedisPacingCoordinator } from "../src/services/campaign-pacing-coordinator";

const redisUrl = process.env.CAMPAIGN_TEST_REDIS_URL!;
const runtime = new CampaignRuntime(undefined, undefined, {
  pacingCoordinator: new RedisPacingCoordinator(redisUrl),
});
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let previousCpu = process.cpuUsage();
let previousAt = performance.now();

process.on("message", async (message: any) => {
  try {
    let result: unknown;
    if (message.command === "acquire") {
      result = await runtime.acquireArchitecturePhones(message.organizationId, message.phoneNumberIds, message.ttlMs);
    } else if (message.command === "release") {
      result = await runtime.releaseArchitecturePhone(message.organizationId, message.phoneNumberId, message.fencingToken);
    } else if (message.command === "dispatch") {
      result = await runtime.architectureTransportProbe(message.phoneNumberId);
    } else if (message.command === "metrics") {
      const now = performance.now();
      const cpu = process.cpuUsage(previousCpu);
      const elapsedMs = Math.max(1, now - previousAt);
      previousCpu = process.cpuUsage();
      previousAt = now;
      result = {
        pid: process.pid,
        cpuUtilizationPercent: (cpu.user + cpu.system) / (elapsedMs * 10),
        eventLoopDelayMs: { mean: loop.mean / 1e6, max: loop.max / 1e6, p99: loop.percentile(99) / 1e6 },
        dispatch: runtime.architectureDispatchMetrics(),
      };
      loop.reset();
    } else if (message.command === "stop") {
      await runtime.stop();
      process.send?.({ id: message.id, ok: true });
      process.exit(0);
      return;
    }
    process.send?.({ id: message.id, ok: true, result });
  } catch (error) {
    process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
process.send?.({ ready: true, pid: process.pid });