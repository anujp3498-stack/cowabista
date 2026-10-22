-- Wabista Nexus P6 shared-connector inventory (READ ONLY; safe on production at any time; changes nothing).
-- The release has no shared (Replit) connector: a live ("real") workspace sends only from numbers that carry their own
-- workspace credential, and anything planned or queued without one fails closed before any provider request.
-- Prints counts and INTERNAL ids only: never connector accounts, WABA/phone provider ids, phone numbers, names,
-- tokens or message content. Run before the window (planning) and again at window start (final list).
-- Exit status 0 = the window can start (no live campaign in action A, C or D2, no queued/processing job in a live
-- workspace, no contact import in progress anywhere); 3 = not yet. B and D1 campaigns are allowed.
--   psql -X -v ON_ERROR_STOP=1 -L logs/12_connector_inventory_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -f inventory/12_connector_inventory_readonly.sql; echo "exit=$?"
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
\echo '== P6 shared-connector inventory (read only) =='
\echo '-- 1. workspace connections by mode (real = live through the shared connector today)'
SELECT mode, status, health, count(*) AS workspaces,
       count(*) FILTER (WHERE connector_account_id IS NOT NULL) AS with_connector_account,
       count(*) FILTER (WHERE configured_waba_external_id IS NOT NULL) AS with_configured_waba
FROM provider_connections GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
\echo '-- 2. live workspaces (internal ids)'
SELECT pc.organization_id AS org_id, pc.status, pc.health, to_char(pc.last_sync_at, 'YYYY-MM-DD') AS last_sync,
       (SELECT count(*) FROM wabas w WHERE w.organization_id = pc.organization_id) AS wabas,
       (SELECT count(*) FROM phone_numbers p WHERE p.organization_id = pc.organization_id AND NOT p.is_sample) AS numbers,
       (SELECT count(*) FROM phone_numbers p WHERE p.organization_id = pc.organization_id AND NOT p.is_sample AND p.status = 'Connected') AS numbers_connected,
       (SELECT count(*) FROM templates t WHERE t.organization_id = pc.organization_id AND NOT t.is_sample AND t.status = 'Approved') AS approved_templates,
       (SELECT count(*) FROM campaigns c WHERE c.organization_id = pc.organization_id AND c.status IN ('Scheduled', 'Running', 'Paused', 'Ready')) AS open_campaigns,
       (SELECT count(*) FROM campaign_jobs j WHERE j.organization_id = pc.organization_id AND j.status = 'Queued') AS queued_jobs,
       (SELECT count(*) FROM campaign_jobs j WHERE j.organization_id = pc.organization_id AND j.status = 'Processing') AS processing_jobs,
       (SELECT to_char(max(pm.created_at), 'YYYY-MM-DD') FROM provider_messages pm WHERE pm.organization_id = pc.organization_id) AS last_message
FROM provider_connections pc WHERE pc.mode <> 'mock' ORDER BY pc.organization_id;
\echo '-- 3. numbers in live workspaces: each needs a workspace credential in Number Center before it can send'
SELECT to_regclass('public.whatsapp_credentials') IS NOT NULL AS migrated \gset
SELECT p.id AS phone_id, p.organization_id AS org_id, p.status, p.waba_id,
       p.provider_phone_id IS NOT NULL AS has_provider_id,
       (SELECT count(*) FROM campaign_routes r JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.phone_number_id = p.id AND c.status IN ('Scheduled', 'Running', 'Paused', 'Ready', 'Draft')) AS routes_in_open_or_draft_campaigns
FROM phone_numbers p JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = p.organization_id
WHERE NOT p.is_sample ORDER BY p.organization_id, p.id LIMIT 500;
\if :migrated
SELECT count(*) AS live_numbers, count(*) FILTER (WHERE p.sending_credential_id IS NULL) AS live_numbers_without_sending_credential
FROM phone_numbers p JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = p.organization_id WHERE NOT p.is_sample;
\endif
\echo '-- 4. open campaigns in live workspaces and the action each needs BEFORE / AFTER the cutover'
WITH live_orgs AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock'),
live_campaign_actions AS (
SELECT c.id AS campaign_id, c.organization_id AS org_id, c.status,
       to_char(c.scheduled_at, 'YYYY-MM-DD HH24:MI') AS scheduled_at_utc,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Queued') AS queued_jobs,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Processing') AS processing_jobs,
       (SELECT max(cp.version) FROM campaign_plans cp WHERE cp.campaign_id = c.id AND cp.status = 'Active') AS active_plan_version,
       CASE
         WHEN c.status IN ('Running', 'Paused') AND EXISTS (SELECT 1 FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status IN ('Queued', 'Processing'))
           THEN 'A: let it finish before the window, or cancel it (queued jobs would fail closed under the release)'
         WHEN c.status IN ('Running', 'Paused') THEN 'B: no queued or processing jobs left (jobs are created at launch): nothing will send, no action'
         WHEN c.status = 'Scheduled' THEN 'C: cancel (or let it run and finish) before the window; recreate after the number has a credential'
         WHEN c.status = 'Ready' AND EXISTS (SELECT 1 FROM campaign_jobs j WHERE j.campaign_id = c.id)
           THEN 'D2: cancel before the window (has execution history: the release would resume the old plan and cannot re-plan it)'
         WHEN c.status = 'Ready' THEN 'D1: after the cutover, add the credential, then launch (launch re-runs preflight and re-plans)'
       END AS action
FROM campaigns c JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = c.organization_id
WHERE c.status IN ('Scheduled', 'Running', 'Paused', 'Ready')
)
SELECT * FROM live_campaign_actions ORDER BY action, org_id, campaign_id LIMIT 500;
\echo '-- 5. totals'
WITH live_orgs AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock'),
live_campaign_actions AS (
SELECT c.id AS campaign_id, c.organization_id AS org_id, c.status,
       to_char(c.scheduled_at, 'YYYY-MM-DD HH24:MI') AS scheduled_at_utc,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Queued') AS queued_jobs,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Processing') AS processing_jobs,
       (SELECT max(cp.version) FROM campaign_plans cp WHERE cp.campaign_id = c.id AND cp.status = 'Active') AS active_plan_version,
       CASE
         WHEN c.status IN ('Running', 'Paused') AND EXISTS (SELECT 1 FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status IN ('Queued', 'Processing'))
           THEN 'A: let it finish before the window, or cancel it (queued jobs would fail closed under the release)'
         WHEN c.status IN ('Running', 'Paused') THEN 'B: no queued or processing jobs left (jobs are created at launch): nothing will send, no action'
         WHEN c.status = 'Scheduled' THEN 'C: cancel (or let it run and finish) before the window; recreate after the number has a credential'
         WHEN c.status = 'Ready' AND EXISTS (SELECT 1 FROM campaign_jobs j WHERE j.campaign_id = c.id)
           THEN 'D2: cancel before the window (has execution history: the release would resume the old plan and cannot re-plan it)'
         WHEN c.status = 'Ready' THEN 'D1: after the cutover, add the credential, then launch (launch re-runs preflight and re-plans)'
       END AS action
FROM campaigns c JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = c.organization_id
WHERE c.status IN ('Scheduled', 'Running', 'Paused', 'Ready')
)
SELECT CASE WHEN left(action, 2) IN ('D1', 'D2') THEN left(action, 2) ELSE left(action, 1) END AS action, count(*) AS campaigns, sum(queued_jobs) AS queued_jobs, sum(processing_jobs) AS processing_jobs
FROM live_campaign_actions GROUP BY 1 ORDER BY 1;
SELECT count(*) AS import_sessions_processing_any_workspace FROM contact_import_sessions WHERE status = 'Processing';
SELECT (SELECT count(*) FROM (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') l) AS live_workspaces,
       (SELECT count(*) FROM phone_numbers p JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = p.organization_id WHERE NOT p.is_sample) AS live_numbers,
       (SELECT count(*) FROM campaigns c JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = c.organization_id WHERE c.status = 'Draft') AS live_draft_campaigns,
       (SELECT count(*) FROM campaigns c WHERE c.status IN ('Scheduled', 'Running', 'Paused', 'Ready')
          AND c.organization_id NOT IN (SELECT id FROM (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') l)) AS mock_open_campaigns_unaffected;
WITH live_orgs AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock'),
live_campaign_actions AS (
SELECT c.id AS campaign_id, c.organization_id AS org_id, c.status,
       to_char(c.scheduled_at, 'YYYY-MM-DD HH24:MI') AS scheduled_at_utc,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Queued') AS queued_jobs,
       (SELECT count(*) FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status = 'Processing') AS processing_jobs,
       (SELECT max(cp.version) FROM campaign_plans cp WHERE cp.campaign_id = c.id AND cp.status = 'Active') AS active_plan_version,
       CASE
         WHEN c.status IN ('Running', 'Paused') AND EXISTS (SELECT 1 FROM campaign_jobs j WHERE j.campaign_id = c.id AND j.status IN ('Queued', 'Processing'))
           THEN 'A: let it finish before the window, or cancel it (queued jobs would fail closed under the release)'
         WHEN c.status IN ('Running', 'Paused') THEN 'B: no queued or processing jobs left (jobs are created at launch): nothing will send, no action'
         WHEN c.status = 'Scheduled' THEN 'C: cancel (or let it run and finish) before the window; recreate after the number has a credential'
         WHEN c.status = 'Ready' AND EXISTS (SELECT 1 FROM campaign_jobs j WHERE j.campaign_id = c.id)
           THEN 'D2: cancel before the window (has execution history: the release would resume the old plan and cannot re-plan it)'
         WHEN c.status = 'Ready' THEN 'D1: after the cutover, add the credential, then launch (launch re-runs preflight and re-plans)'
       END AS action
FROM campaigns c JOIN (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock') o ON o.id = c.organization_id
WHERE c.status IN ('Scheduled', 'Running', 'Paused', 'Ready')
)
SELECT count(*) FILTER (WHERE left(action, 1) IN ('A', 'C') OR left(action, 2) = 'D2') = 0
   AND NOT EXISTS (SELECT 1 FROM campaign_jobs j JOIN live_orgs l ON l.id = j.organization_id WHERE j.status IN ('Queued', 'Processing'))
   AND NOT EXISTS (SELECT 1 FROM contact_import_sessions s WHERE s.status = 'Processing')
   AS window_ready FROM live_campaign_actions \gset
ROLLBACK;
\if :window_ready
\echo 'CONNECTOR INVENTORY: the window can start (no live campaign in action A, C or D2, no queued/processing job in a live'
\echo 'workspace, no contact import in progress anywhere).'
\else
\echo 'CONNECTOR INVENTORY: NOT READY: a live campaign in action A, C or D2, a queued/processing job in a live workspace, or'
\echo 'a contact import in progress exists (sections 2, 4 and 5). Resolve them in the app before the window starts.'
DO $$ BEGIN RAISE EXCEPTION 'P6 connector inventory: window not ready'; END $$;
\endif
