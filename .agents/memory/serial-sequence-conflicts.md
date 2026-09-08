---
name: Serial sequence conflicts
description: Prevent silent row loss after legacy data with explicit serial IDs is copied into canonical tables.
---

When legacy or fixture rows are copied with explicit values for a PostgreSQL serial identity, reset the backing sequence to at least the table's maximum ID. On idempotent inserts, target only the intended business-key conflict instead of ignoring every constraint violation.

**Why:** A development migration preserved explicit queue IDs without advancing the sequence. Later batched inserts collided with those primary keys, and broad conflict-ignore silently dropped part of the campaign queue while the import itself appeared successful.

**How to apply:** After any explicit-ID copy or restore, compare each serial sequence with the table maximum and advance it transactionally. Use explicit conflict targets for idempotency so primary-key, foreign-key, and schema failures remain visible.