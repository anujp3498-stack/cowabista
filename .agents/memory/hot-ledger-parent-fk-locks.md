---
name: Hot-path ledgers must avoid parent foreign-key locks
description: Why append-only counter ledgers on a dispatch path cannot reference lock-heavy parent rows.
---

An append-only metrics/event ledger used inside a hot claim transaction must not carry foreign keys to campaign or tenant parent rows that pause, cancel, or settlement operations lock.

**Why:** PostgreSQL validates each referencing insert with a KEY SHARE lock on the parent tuple. A ledger can therefore remove the obvious aggregate-row update yet still recreate the same claim convoy indirectly through its foreign keys. A blocked-settlement regression exposed this only when the parent campaign row was deliberately held.

**How to apply:** Store validated tenant/resource IDs as ordinary indexed columns in hot ledgers. Consume rows by joining to the authoritative live aggregate/resource table, and periodically delete rows whose parent no longer exists. Test by holding the parent row FOR UPDATE while asserting a claim and ledger insert still complete.