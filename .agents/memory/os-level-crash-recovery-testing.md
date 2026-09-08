---
name: Real OS-process crash recovery testing pattern
description: How to prove worker crash recovery with an actual SIGKILL on a real child process, not just in-process lease-abandon simulation.
---

Existing crash-recovery tests in this repo (e.g. campaign-worker-crash-recovery.test.ts)
only simulate a crash by abandoning an in-process claim and calling a private
reap method directly -- no OS process ever dies. When "the process actually
gets killed" is the requirement, that's a different, stronger test shape:

1. **Boot the runtime as its own standalone entry point** (no HTTP server),
   built with esbuild and spawned via `child_process.spawn`, so the test can
   send it a real `SIGKILL` and later start a second, independent replacement
   process pointed at the same database.

2. **Build the harness INTO the package directory, not /tmp.** Node's ESM
   resolver looks for `node_modules` by walking up from the *importing file's
   own path*, not from `cwd`. If externals (`pino`, `pg-native`, etc. -- the
   same list `build-and-run.mjs` uses) are bundled to an OS tmpdir, the
   spawned process throws `ERR_MODULE_NOT_FOUND` even with the right `cwd`.
   Output under `artifactDir/.test-dist/...` instead, exactly like the
   existing single-file test build script does.

3. **To reliably catch a send actually in flight** (not just claimed), add a
   small, env-var-gated test hook to the mock provider: the FIRST `send()`
   call in a process blocks for several seconds (module-level `let` flag,
   serializes correctly across concurrent async lanes since JS is single-
   threaded up to the first `await`) before "responding". This gives a wide,
   deterministic window to poll the DB for the resulting `provider_messages`
   "pending" row and kill the process while a real send is genuinely
   unresolved -- proving the crash lands exactly where a live provider
   round-trip could leave delivery ambiguous, not merely "before any work
   started".

4. **Prove "at most once" across the process boundary independently of the
   DB unique constraint**: add a second gated hook that appends one line
   (recipient + full payload) to a file path from `env`, only once a send
   actually completes. A file survives process death and is readable by a
   completely separate OS process (the test), giving an authoritative,
   cross-process ledger that the interrupted job's recipient was never
   really dispatched, while jobs that did complete carry their exact
   per-template header/body/button values.

**Why:** an in-process simulation can prove the DB-side lease/reservation
logic is correct, but it can never prove a real dead process (no `finally`,
no signal handler, no in-memory cleanup) is survivable -- and a wrong test
build path (harness in /tmp) fails opaquely with a module-resolution error
that looks unrelated to the actual bug.

**How to apply:** any future "prove X survives a real crash" requirement in
this codebase (not just campaign workers) should reuse this shape: dedicated
standalone entry point, package-local esbuild output, env-gated delay +
audit-log hooks on the relevant external-call mock, real `SIGKILL`.
