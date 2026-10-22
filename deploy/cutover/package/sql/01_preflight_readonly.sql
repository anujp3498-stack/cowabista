-- Wabista Nexus P6 preflight (READ ONLY; safe on production at any time; changes nothing).
-- Usage, from the package directory (connection and password setup: README "How to connect"):
--   psql -X -v ON_ERROR_STOP=1 -L logs/01_preflight_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -f sql/01_preflight_readonly.sql; echo "exit=$?"
-- Exit status 0 = ready for 02_migrate.psql; any other status = STOP (the output says why).
-- Prints only counts, object names/definitions and hashes: never emails, names, Clerk ids, tokens or content.
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '600s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
\echo '== P6 preflight (read only) =='
SELECT current_database() AS database, current_user AS role, split_part(version(), ' ', 2) AS server_version,
       current_setting('server_version_num')::int >= 110000 AS fast_default_supported,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS pg_trgm_installed;
SELECT (current_setting('server_version_num')::int >= 110000 AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')) AS server_ok \gset
\echo '-- 1. schema is the production-branch schema (d22a8e43)'
\ir lib/check_base_schema.sql
\echo '-- 2. nothing the migration creates exists yet'
\ir lib/check_new_objects_absent.sql
\echo '-- 3. campaign_contacts idempotency index (the release keeps it and adds a generation-aware one)'
SELECT indexname, regexp_replace(indexdef, ' ON public\.', ' ON ') AS definition FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'campaign_contact_idempotency%';
\echo '-- 4. sizes (index builds in the window scale with campaign_contacts; the lab built 309k rows in ~3 s)'
SELECT relname AS table_name, n_live_tup AS approx_rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables WHERE relname IN ('campaign_contacts', 'campaign_jobs', 'provider_messages', 'contacts', 'campaigns', 'users', 'organization_members')
ORDER BY n_live_tup DESC;
\echo '-- 5. other client sessions on this database (must be 0 inside the cutover window; informational now)'
\echo '   (sessions of other roles show NULL details unless this role is superuser or in pg_read_all_stats; they are counted)'
SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS sees_all_sessions;
SELECT coalesce(application_name, '') AS application_name, coalesce(usename, '?') AS role, coalesce(state, '?') AS state, count(*) AS sessions
FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND (backend_type = 'client backend' OR (backend_type IS NULL AND usesysid IS NOT NULL))
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
\echo '-- 6. campaign jobs holding a live lease (must be 0 inside the window: runtime stopped)'
SELECT count(*) AS live_leases FROM campaign_jobs WHERE status = 'Processing' AND lease_expires_at > now();
\echo '-- 7. baseline facts for the change record (cutover P8 / W4): base tables, highest phone id, database size, imports in progress'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS baseline_tables,
       (SELECT max(id) FROM phone_numbers) AS max_phone_id,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT count(*) FROM contact_import_sessions WHERE status = 'Processing') AS imports_processing;
\echo '-- 8. data fingerprint (keep this output; 40_postcheck prints the same lines and they must be identical)'
\ir lib/fingerprint_print.sql
SELECT (:'base_ok'::boolean AND :'absent_ok'::boolean AND :'server_ok'::boolean) AS preflight_ok \gset
ROLLBACK;
\if :preflight_ok
\echo 'PREFLIGHT OK: schema matches d22a8e43, nothing to be created exists, server ready.'
\else
\echo 'PREFLIGHT FAILED: STOP. Read the missing/extra lists above; do not run 02_migrate.psql.'
DO $$ BEGIN RAISE EXCEPTION 'P6 preflight failed'; END $$;
\endif
