-- Wabista Nexus P6 post-migration check (READ ONLY; run right after 02_migrate.psql and again after the rollout).
--   psql -X -v ON_ERROR_STOP=1 -L logs/40_postcheck_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -f sql/40_postcheck_readonly.sql; echo "exit=$?"
-- Exit status 0 = schema is the release schema; the fingerprint section must equal the preflight's line by line
-- (as long as no application process has written since; after the rollout, counts may grow, ids never change).
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '600s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
\echo '== P6 postcheck (read only) =='
SELECT CASE WHEN to_regclass('public.auth_user_links') IS NOT NULL THEN obj_description(to_regclass('public.auth_user_links'), 'pg_class') END AS migration_marker;
\echo '-- 1. schema is the release schema (e37ab27e, transitional idempotency index)'
\ir lib/check_release_schema.sql
\echo '-- 2. all indexes valid (an invalid index means a failed concurrent build; none are concurrent here)'
SELECT count(*) AS invalid_indexes FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT i.indisvalid \gset
\echo '   invalid indexes:' :invalid_indexes
\if :release_ok
\echo '-- 3. Better Auth rows (all 0 right after 02_migrate; they grow only as people sign up after the rollout)'
SELECT (SELECT count(*) FROM auth_users) AS auth_users, (SELECT count(*) FROM auth_sessions) AS auth_sessions,
       (SELECT count(*) FROM auth_user_links) AS auth_user_links,
       (SELECT count(*) FROM users WHERE clerk_id LIKE 'better-auth:%') AS better_auth_local_users;
\else
\echo '-- 3. skipped: the release schema is incomplete'
\endif
\echo '-- 4. data fingerprint (compare with the preflight output)'
\ir lib/fingerprint_print.sql
ROLLBACK;
SELECT :'release_ok'::boolean AND :invalid_indexes = 0 AS postcheck_ok \gset
\if :postcheck_ok
\echo 'POSTCHECK OK: release schema present, no invalid index.'
\else
\echo 'POSTCHECK FAILED: release schema incomplete or an index is invalid; see the lists above.'
DO $$ BEGIN RAISE EXCEPTION 'P6 postcheck failed'; END $$;
\endif
