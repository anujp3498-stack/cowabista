-- Part 50: end of the campaign_contacts transition. Run ONLY through 03_finalize.psql, inside the cutover window,
-- after the GO decision and BEFORE users are let in (the new app's "replace audience" import that reuses a phone
-- fails while the old index exists: proven in the lab with test:audience, 12/13 transitional vs 13/13 finalized).
-- Drops one INDEX only (no table, column or row is touched) and renames the generation-aware index to the name the
-- Drizzle schema uses. Reversible with 61_unfinalize.psql while no campaign has two generations sharing a phone.
DROP INDEX "campaign_contact_idempotency_uq";

ALTER INDEX "campaign_contact_idempotency_gen_uq" RENAME TO "campaign_contact_idempotency_uq";
