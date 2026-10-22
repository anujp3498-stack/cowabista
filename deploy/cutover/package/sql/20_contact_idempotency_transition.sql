-- Part 20: V2 audience-generation uniqueness for campaign_contacts, ADDITIVE transition step.
-- The release keys a recipient by (campaign_id, audience_generation, idempotency_key) and its CSV import uses
-- exactly that ON CONFLICT target; the production code (d22a8e43bf0d) uses (campaign_id, idempotency_key) and
-- needs the existing unique index campaign_contact_idempotency_uq. Both indexes are kept during the transition so
-- that BOTH versions work (application rollback needs no database change). Existing rows satisfy the new index
-- by construction (it is less strict than the old one).
-- Known limitation while both exist: a "replace audience" import in the new app that reuses a phone already in
-- the campaign's previous generation fails (session Failed, HTTP 400, nothing activated); so does a later append
-- that repeats a phone of a superseded generation (possible only after a replace). Other appends work.
-- So the transition is short: it ends inside the same window with 03_finalize.psql (part 50), after the GO
-- decision and before users are let in; until then rolling back to the production code needs no database change.

CREATE UNIQUE INDEX "campaign_contact_idempotency_gen_uq" ON "campaign_contacts" USING btree ("campaign_id","audience_generation","idempotency_key");
