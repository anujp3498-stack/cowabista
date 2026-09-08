// Rocket Campaign roadmap requirement: "worker resilience" -- an unexpected
// rejection/exception outside our own try/catch must not silently kill the
// process with zero log trace and zero graceful shutdown of the campaign
// runtime (which would abandon any lease it currently holds).
//
// This exercises the real installCrashHandlers() against a fake event
// target instead of process itself, so the test can assert exactly what
// would happen (log line + shutdown callback invoked with the right signal
// name) without ending the test process or needing a real subprocess.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installCrashHandlers } from "../src/lib/process-crash-handlers";

function fakeLogger() {
  const errors: Array<{ payload: unknown; message: string }> = [];
  return {
    errors,
    error(payload: unknown, message: string) {
      errors.push({ payload, message });
    },
  };
}

test("an unhandled promise rejection is logged and triggers shutdown with the right signal name", () => {
  const target = new EventEmitter();
  const logger = fakeLogger();
  const crashes: string[] = [];
  installCrashHandlers(target, { logger, onCrash: (signal) => crashes.push(signal) });

  const reason = new Error("boom: nobody awaited this promise");
  target.emit("unhandledRejection", reason);

  assert.deepEqual(crashes, ["unhandledRejection"]);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0]?.message, "Unhandled promise rejection; shutting down");
  assert.equal((logger.errors[0]?.payload as { reason: unknown }).reason, reason);
});

test("an uncaught exception is logged and triggers shutdown with the right signal name", () => {
  const target = new EventEmitter();
  const logger = fakeLogger();
  const crashes: string[] = [];
  installCrashHandlers(target, { logger, onCrash: (signal) => crashes.push(signal) });

  const error = new Error("boom: this throw escaped every call frame");
  target.emit("uncaughtException", error);

  assert.deepEqual(crashes, ["uncaughtException"]);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0]?.message, "Uncaught exception; shutting down");
  assert.equal((logger.errors[0]?.payload as { error: unknown }).error, error);
});

test("the two handlers are independent: one firing does not suppress or duplicate the other", () => {
  const target = new EventEmitter();
  const logger = fakeLogger();
  const crashes: string[] = [];
  installCrashHandlers(target, { logger, onCrash: (signal) => crashes.push(signal) });

  target.emit("unhandledRejection", new Error("first"));
  target.emit("uncaughtException", new Error("second"));

  assert.deepEqual(crashes, ["unhandledRejection", "uncaughtException"]);
  assert.equal(logger.errors.length, 2);
});
