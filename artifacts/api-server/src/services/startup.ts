import type { Logger } from "pino";

// Startup orchestration (V2-04 acceptance correction).
//
// The sender refuses a provider-backed template without an evidence row
// (`evidence_missing`), so on the first start after an upgrade the
// eligibility backfill is a PREREQUISITE for consuming campaign work, not
// a background chore: queued jobs for valid synced templates must never be
// rejected merely because the backfill had not finished yet. The sender is
// not softened for this; the process simply does not start consuming
// until initialization has completed.
//
// Ordering guaranteed by `start()`:
//   1. HTTP listener is up (liveness: /healthz) -- the caller does that.
//   2. required initialization runs to completion (the backfill);
//   3. only then, and only if no shutdown was requested meanwhile and the
//      initialization succeeded, the campaign runtime is started, exactly
//      once;
//   4. readiness (/readyz, and the `initialization` block of /healthz)
//      reports "ready" only after step 3.
// A failed initialization never starts the runtime: the state becomes
// "failed" and `onInitializationFailed` lets the entry point exit cleanly.
// A shutdown requested while initialization is in flight waits for it to
// settle and then skips the runtime start.

export type StartupPhase = "pending" | "initializing" | "ready" | "failed" | "stopped";

export type StartupState = {
  phase: StartupPhase;
  /** True once the campaign runtime was started by this orchestrator. */
  runtimeStarted: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type StartupOrchestrator = {
  /** Runs initialization, then starts the runtime unless failed/shut down. Resolves when settled. */
  start(): Promise<StartupState>;
  /** Requests shutdown; waits for in-flight initialization to settle; stops the runtime if it was started. */
  shutdown(): Promise<void>;
  state(): StartupState;
};

export function createStartupOrchestrator(deps: {
  initialize: () => Promise<unknown>;
  startRuntime: () => unknown;
  stopRuntime: () => Promise<void>;
  logger: Pick<Logger, "info" | "error">;
  onInitializationFailed?: (error: unknown) => void;
}): StartupOrchestrator {
  const state: StartupState = { phase: "pending", runtimeStarted: false, startedAt: null, completedAt: null, error: null };
  let shutdownRequested = false;
  let inFlight: Promise<StartupState> | null = null;
  let runtimeStarts = 0;

  const start = (): Promise<StartupState> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      state.phase = "initializing";
      state.startedAt = new Date().toISOString();
      try {
        const result = await deps.initialize();
        deps.logger.info({ result }, "campaign startup initialization completed");
      } catch (error) {
        state.phase = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        state.completedAt = new Date().toISOString();
        deps.logger.error({ err: error }, "campaign startup initialization failed; campaign runtime NOT started");
        deps.onInitializationFailed?.(error);
        return { ...state };
      }
      state.completedAt = new Date().toISOString();
      if (shutdownRequested) {
        state.phase = "stopped";
        deps.logger.info("shutdown requested during initialization; campaign runtime not started");
        return { ...state };
      }
      runtimeStarts += 1;
      if (runtimeStarts !== 1) throw new Error("campaign runtime start attempted more than once");
      deps.startRuntime();
      state.runtimeStarted = true;
      state.phase = "ready";
      deps.logger.info("campaign runtime started after initialization");
      return { ...state };
    })();
    return inFlight;
  };

  const shutdown = async (): Promise<void> => {
    shutdownRequested = true;
    if (inFlight) {
      try { await inFlight; } catch { /* reported by start() */ }
    }
    if (state.runtimeStarted) await deps.stopRuntime();
    if (state.phase !== "failed") state.phase = "stopped";
  };

  return { start, shutdown, state: () => ({ ...state }) };
}

// Process-wide state for the health routes. Set by the entry point; stays
// "pending" in processes that never run the orchestrator (tests importing
// the app, tools), which readiness reports as not ready.
let current: StartupOrchestrator | null = null;
export function registerStartupOrchestrator(orchestrator: StartupOrchestrator): void {
  current = orchestrator;
}
export function getStartupState(): StartupState {
  return current ? current.state() : { phase: "pending", runtimeStarted: false, startedAt: null, completedAt: null, error: null };
}
export function isCampaignOperationsReady(): boolean {
  return getStartupState().phase === "ready";
}
