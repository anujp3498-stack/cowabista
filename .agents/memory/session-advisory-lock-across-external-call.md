---
name: Session-scoped advisory lock spanning a DB decision and an external call
description: How to close a race window between "reservation transaction commits" and "external API call is made" when a transaction-scoped advisory lock isn't enough.
---

## The problem

A reservation transaction takes `pg_advisory_xact_lock(key)`, rechecks a
condition, writes a row, and commits. A concurrent writer (e.g. a webhook)
blocked on the same lock key gets unblocked the instant that transaction
commits on the Postgres server -- which can be before the original
process's own client has even received the commit acknowledgment and
resumed execution. If the original process's next step (e.g. calling an
external API) depends on "nothing changed the condition after my recheck",
this is a real, exploitable gap: the concurrent writer can commit its
change in the interval between the server-side commit and the original
process's JS resuming.

## The fix

Take the lock at **session level** (`pg_advisory_lock` / `pg_advisory_unlock`
on a dedicated connection checked out from the pool), not transaction level.
Run the recheck + reservation-insert as a transaction on that SAME
connection (wrap the checked-out `PoolClient` with `drizzle(client)`), then
explicitly issue the unlock only once the process has decided to proceed
(right before initiating the external call). Always release both the lock
and the connection in `finally` blocks.

This makes the concurrent writer's own lock acquisition block until the
original process's own code -- not Postgres's automatic commit-triggered
release -- says it is safe to proceed. The residual gap shrinks to
synchronous JS between "unlock acknowledged" and "external call invoked",
which is not exploitable in practice.

**Why this doesn't hurt connection-pool scale:** only hold the connection
for the reservation transaction + one fast local unlock query, then
`client.release()` *before* awaiting the external call. Do NOT hold the
connection/lock across the network call itself -- once the decision to
proceed is committed and the lock is released, nothing further can be done
about the external call anyway (it can't be un-sent), so there's no
correctness reason to keep the connection tied up for the network round
trip, and doing so would exhaust the pool under concurrent load.

**How to apply:** any "check condition, then call an irreversible external
API, with a concurrent writer that could invalidate the condition"
pattern -- not just WhatsApp sends. If both sides (the reservation and the
concurrent writer) already share the same `pg_advisory_xact_lock` key,
converting only the reservation side to session-scoped lock + explicit
unlock is sufficient; the concurrent writer's xact-lock acquisition
automatically respects a session-held lock on the same key since both
share Postgres's advisory lock namespace.
