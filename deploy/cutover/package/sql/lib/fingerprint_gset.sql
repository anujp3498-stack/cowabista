-- Same fingerprint as fingerprint_print.sql, folded into one psql variable named by :fp_var.
SET search_path = public;
SELECT string_agg(t || '=' || n || '/' || fp, ';' ORDER BY t) AS :fp_var FROM (
SELECT 'users' AS t, count(*) AS n, md5(coalesce(string_agg(concat_ws(':', id, md5(clerk_id), is_platform_admin), ',' ORDER BY id), '')) AS fp FROM users
UNION ALL SELECT 'organizations', count(*), md5(coalesce(string_agg(concat_ws(':', id, md5(slug)), ',' ORDER BY id), '')) FROM organizations
UNION ALL SELECT 'organization_members', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id, user_id, role), ',' ORDER BY id), '')) FROM organization_members
UNION ALL SELECT 'organization_invitations', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id, role, status), ',' ORDER BY id), '')) FROM organization_invitations
UNION ALL SELECT 'provider_connections', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id, mode, status), ',' ORDER BY id), '')) FROM provider_connections
UNION ALL SELECT 'wabas', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id), ',' ORDER BY id), '')) FROM wabas
UNION ALL SELECT 'phone_numbers', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id, waba_id, status), ',' ORDER BY id), '')) FROM phone_numbers
UNION ALL SELECT 'templates', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id, status), ',' ORDER BY id), '')) FROM templates
UNION ALL SELECT 'campaigns', count(*), md5(coalesce(string_agg(concat_ws(':', id, organization_id, status), ',' ORDER BY id), '')) FROM campaigns
UNION ALL SELECT 'campaign_routes', count(*), md5(coalesce(string_agg(concat_ws(':', id, campaign_id, phone_number_id, template_id), ',' ORDER BY id), '')) FROM campaign_routes
UNION ALL SELECT 'campaign_plans', count(*), md5(coalesce(string_agg(concat_ws(':', id, campaign_id, version, status), ',' ORDER BY id), '')) FROM campaign_plans
UNION ALL SELECT 'campaign_contacts', count(*), concat_ws(':', coalesce(sum(id::bigint), 0), coalesce(max(id), 0)) FROM campaign_contacts
UNION ALL SELECT 'campaign_jobs', count(*), concat_ws(':', coalesce(sum(id::bigint), 0), count(*) FILTER (WHERE status = 'Queued'), count(*) FILTER (WHERE status = 'Processing')) FROM campaign_jobs
UNION ALL SELECT 'provider_messages', count(*), concat_ws(':', coalesce(sum(id::bigint), 0), coalesce(max(id), 0)) FROM provider_messages
UNION ALL SELECT 'contacts', count(*), concat_ws(':', coalesce(sum(id::bigint), 0), coalesce(max(id), 0)) FROM contacts
UNION ALL SELECT 'suppressions', count(*), concat_ws(':', coalesce(sum(id::bigint), 0), coalesce(max(id), 0)) FROM suppressions
) f \gset
