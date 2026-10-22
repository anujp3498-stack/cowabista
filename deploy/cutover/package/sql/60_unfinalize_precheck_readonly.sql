-- Wabista Nexus P6 rollback precheck (READ ONLY): can the database go back to the transitional idempotency state
-- that the production code (d22a8e43) needs? Only needed when rolling back AFTER 03_finalize.psql ran.
--   psql -X -v ON_ERROR_STOP=1 -L logs/60_unfinalize_precheck_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -f sql/60_unfinalize_precheck_readonly.sql; echo "exit=$?"
-- Exit status 0 = the old 2-column index can exist: if the state is finalized, 61_unfinalize.psql restores it; if it
-- is already transitional, nothing is needed. Prints counts and internal campaign ids only.
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '600s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
\ir lib/check_release_schema.sql
\echo '-- campaigns whose audience generations share a phone (each blocks the old unique index)'
SELECT campaign_id, count(*) AS duplicated_keys FROM (
  SELECT campaign_id, idempotency_key FROM campaign_contacts GROUP BY 1, 2 HAVING count(*) > 1
) d GROUP BY campaign_id ORDER BY campaign_id LIMIT 50;
SELECT count(*) AS cross_generation_duplicate_keys FROM (
  SELECT 1 FROM campaign_contacts GROUP BY campaign_id, idempotency_key HAVING count(*) > 1
) d \gset
\echo '   cross-generation duplicate keys:' :cross_generation_duplicate_keys
\echo '-- campaigns with more than one audience generation (the production code ignores generations and would treat'
\echo '   superseded rows as recipients: keep these campaigns out of any launch under the old code)'
SELECT count(*) AS campaigns_with_superseded_rows FROM (
  SELECT c.id FROM campaigns c JOIN campaign_contacts cc ON cc.campaign_id = c.id
  WHERE cc.audience_generation <> c.audience_generation GROUP BY c.id
) s;
ROLLBACK;
SELECT (:'release_ok'::boolean AND :'idempotency_state' IN ('finalized', 'transitional') AND :cross_generation_duplicate_keys = 0) AS unfinalize_ok \gset
\if :unfinalize_ok
\echo 'UNFINALIZE PRECHECK OK'
\else
\echo 'UNFINALIZE PRECHECK FAILED: the old index cannot be rebuilt (see the campaigns above). Do not roll back the application without a data decision.'
DO $$ BEGIN RAISE EXCEPTION 'P6 unfinalize precheck failed'; END $$;
\endif
