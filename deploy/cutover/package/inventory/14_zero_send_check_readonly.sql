-- Wabista Nexus P6 zero-send check (READ ONLY): proves nothing was sent or claimed for sending since a moment in time.
-- Run with T0 = the t0_utc value printed by 02_migrate.psql (the rollback section calls it T_START; after a
-- roll-forward use T_RF), during and after acceptance:
--   psql -X -v ON_ERROR_STOP=1 -L logs/14_zero_send_check_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -v since='<T0>' [-v approved_campaign_ids='{<L2 campaign id>}'] -f inventory/14_zero_send_check_readonly.sql; echo "exit=$?"
-- A workspace counts as LIVE when its stored mode is not mock OR it holds any workspace credential (the release sends
-- through the real Graph API from any number that has its own credential, whatever the mode).
-- Exit status 0 = since then, in live workspaces: no provider message created and no job claimed or sent outside the
-- campaigns in approved_campaign_ids (the approved L2 send), the approved campaigns reached at most ONE recipient
-- each, and NO test send that was sent or may have been sent, anywhere a credential was used (test sends are never
-- excepted). Pass approved_campaign_ids only once L2 has launched; omit it before that and when there is no L2.
-- Jobs that only became Failed/Cancelled (cancel, kill, reaper, fail-closed refusal) print a WARNING, not a failure.
-- A test send creates no job and no provider message; it is seen through its campaign_audit row (test_send_requested).
-- Prints counts and internal campaign ids only.
\set ON_ERROR_STOP on
\pset pager off
\if :{?since}
\else
\echo 'usage: -v since=<UTC timestamp of the window start> [-v approved_campaign_ids={<id>,...}]'
DO $$ BEGIN RAISE EXCEPTION 'P6 zero-send check needs -v since=...'; END $$;
\endif
\if :{?approved_campaign_ids}
\else
\set approved_campaign_ids '{}'
\endif
SET default_transaction_read_only = on;
SET statement_timeout = '600s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
SELECT to_regclass('public.whatsapp_credentials') IS NOT NULL AS has_credentials \gset
\if :has_credentials
\set live_with_credentials 'UNION SELECT organization_id FROM whatsapp_credentials'
\else
\set live_with_credentials ''
\endif
\echo '== P6 zero-send check since' :'since' ' approved campaigns' :'approved_campaign_ids' '=='
WITH live AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock' :live_with_credentials),
modes AS (SELECT o.id, CASE WHEN o.id IN (SELECT id FROM live) THEN 'live' ELSE 'mock' END AS mode FROM organizations o)
SELECT m.mode AS workspace_mode,
       (SELECT count(*) FROM provider_messages pm WHERE pm.organization_id = ANY (array_agg(m.id)) AND pm.created_at >= :'since'::timestamptz) AS provider_messages_created,
       (SELECT count(*) FROM campaign_jobs j WHERE j.organization_id = ANY (array_agg(m.id)) AND j.updated_at >= :'since'::timestamptz
          AND j.status NOT IN ('Queued', 'Failed', 'Cancelled')) AS jobs_claimed_or_sent,
       (SELECT count(*) FROM campaign_jobs j WHERE j.organization_id = ANY (array_agg(m.id)) AND j.updated_at >= :'since'::timestamptz
          AND j.status IN ('Failed', 'Cancelled')) AS jobs_failed_or_cancelled,
       (SELECT count(*) FROM campaign_audit a WHERE a.organization_id = ANY (array_agg(m.id)) AND a.action = 'test_send_requested'
          AND a.created_at >= :'since'::timestamptz AND a.metadata->>'result' IN ('sent', 'unknown')) AS test_sends,
       (SELECT count(*) FROM campaign_jobs j WHERE j.organization_id = ANY (array_agg(m.id)) AND j.status = 'Processing') AS jobs_processing_now,
       (SELECT count(*) FROM campaigns c WHERE c.organization_id = ANY (array_agg(m.id)) AND c.status = 'Running') AS campaigns_running_now
FROM modes m GROUP BY 1 ORDER BY 1;
\echo '-- live send activity since then, per campaign (approved = covered by approved_campaign_ids; test sends never are)'
WITH live AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock' :live_with_credentials),
activity AS (
  SELECT j.campaign_id, 'provider_message' AS kind FROM provider_messages pm
  JOIN campaign_jobs j ON j.id = pm.campaign_job_id AND j.organization_id = pm.organization_id
  JOIN live l ON l.id = pm.organization_id WHERE pm.created_at >= :'since'::timestamptz
  UNION ALL
  SELECT j.campaign_id, 'job_claimed_or_sent' FROM campaign_jobs j JOIN live l ON l.id = j.organization_id
  WHERE j.updated_at >= :'since'::timestamptz AND j.status NOT IN ('Queued', 'Failed', 'Cancelled')
  UNION ALL
  SELECT a.campaign_id, 'test_send' FROM campaign_audit a
  WHERE a.action = 'test_send_requested' AND a.created_at >= :'since'::timestamptz AND a.metadata->>'result' IN ('sent', 'unknown')
    AND (a.organization_id IN (SELECT id FROM live) OR a.metadata->>'transport' = 'workspace_credential'))
SELECT campaign_id, kind, count(*) AS events,
       kind <> 'test_send' AND campaign_id = ANY (:'approved_campaign_ids'::int[]) AS approved
FROM activity GROUP BY 1, 2 ORDER BY 1, 2;
WITH live AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock' :live_with_credentials)
SELECT (SELECT count(DISTINCT pm.recipient_external_id) FROM provider_messages pm
          JOIN campaign_jobs j ON j.id = pm.campaign_job_id AND j.organization_id = pm.organization_id
        WHERE pm.created_at >= :'since'::timestamptz AND j.campaign_id = ANY (:'approved_campaign_ids'::int[])) AS approved_recipients,
       (SELECT count(DISTINCT coalesce(j.contact_id::text, 'job:' || j.id)) FROM campaign_jobs j WHERE j.updated_at >= :'since'::timestamptz
          AND j.status NOT IN ('Queued', 'Failed', 'Cancelled') AND j.campaign_id = ANY (:'approved_campaign_ids'::int[])) AS approved_contacts_claimed,
       cardinality(:'approved_campaign_ids'::int[]) AS approved_campaigns \gset
\echo '   approved campaigns' :approved_campaigns ' distinct recipients reached' :approved_recipients ' distinct contacts claimed' :approved_contacts_claimed ' (at most one per approved campaign)'
-- FAIL on: live sends outside the approved campaigns, more than one recipient per approved campaign, or any test send.
WITH live AS (SELECT organization_id AS id FROM provider_connections WHERE mode <> 'mock' :live_with_credentials)
SELECT ((SELECT count(*) FROM provider_messages pm JOIN live l ON l.id = pm.organization_id
           LEFT JOIN campaign_jobs j ON j.id = pm.campaign_job_id AND j.organization_id = pm.organization_id
         WHERE pm.created_at >= :'since'::timestamptz AND NOT coalesce(j.campaign_id = ANY (:'approved_campaign_ids'::int[]), false))
      + (SELECT count(*) FROM campaign_jobs j JOIN live l ON l.id = j.organization_id WHERE j.updated_at >= :'since'::timestamptz
           AND j.status NOT IN ('Queued', 'Failed', 'Cancelled') AND NOT (j.campaign_id = ANY (:'approved_campaign_ids'::int[])))
      + (SELECT count(*) FROM campaign_audit a WHERE a.action = 'test_send_requested'
           AND a.created_at >= :'since'::timestamptz AND a.metadata->>'result' IN ('sent', 'unknown')
           AND (a.organization_id IN (SELECT id FROM live) OR a.metadata->>'transport' = 'workspace_credential'))) = 0
   AND :approved_recipients <= :approved_campaigns AND :approved_contacts_claimed <= :approved_campaigns AS zero_live_sends,
       (SELECT count(*) FROM campaign_jobs j JOIN live l ON l.id = j.organization_id WHERE j.updated_at >= :'since'::timestamptz
           AND j.status IN ('Failed', 'Cancelled')) = 0 AS no_live_job_endings \gset
ROLLBACK;
\if :zero_live_sends
\if :no_live_job_endings
\else
\echo 'WARNING: live-workspace jobs became Failed or Cancelled since the given time (cancel, kill, reaper or fail-closed refusal; not a send). Explain them.'
\endif
\echo 'ZERO-SEND CHECK OK: no live send, claim or test send since the given time (approved campaigns: at most one recipient each).'
\else
\echo 'ZERO-SEND CHECK FAILED: live send activity outside the approved campaigns, a test send, or more than one recipient per approved campaign (see the lists above). Investigate before going further.'
DO $$ BEGIN RAISE EXCEPTION 'P6 zero-send check failed'; END $$;
\endif
