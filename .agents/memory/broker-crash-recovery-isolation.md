---
name: Broker crash recovery uncertainty isolation
description: Safety rules for recovering prepared transport work after Redis ambiguity or consumer loss.
---

Reclaim prepared broker work only from a superseded ownership fence; an idle entry from the current fence may belong to a slow live provider call. Validate the exact PostgreSQL lease and lifecycle before adoption. Treat a publish connection error as ambiguous because Redis may have committed the stream append.

**Why:** Clean-shutdown rollback semantics are unsafe for abandoned or ambiguously published work. Revoking and retrying can duplicate a provider call, while failing a mixed preparation batch can incorrectly fail untouched jobs.

**How to apply:** Make stream publication idempotent by job and lease, leave ambiguous writes fail-closed for lease recovery, record consumed work with an uncertain provider boundary as `delivery_unknown`, and represent preparation failures per job rather than throwing for the whole batch.