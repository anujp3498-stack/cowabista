-- Wabista Nexus P6 user inventory (READ ONLY; safe on production at any time; changes nothing).
-- Decides Path A / Path B for existing Clerk users. Prints COUNTS ONLY: never an email, name, Clerk id, token,
-- credential or message content (duplicate emails are counted, never shown). Works before and after 02_migrate.
--   psql -X -v ON_ERROR_STOP=1 -L logs/11_user_inventory_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -f inventory/11_user_inventory_readonly.sql; echo "exit=$?"
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
\echo '== P6 user inventory (read only, counts only) =='
\echo '-- 1. users by identity shape (Clerk ids look like user_<base62>; better-auth:<id> rows are created by the release)'
SELECT count(*) AS users_total,
       count(*) FILTER (WHERE clerk_id ~ '^user_[A-Za-z0-9]{10,}$') AS clerk_shaped,
       count(*) FILTER (WHERE clerk_id LIKE 'better-auth:%') AS better_auth_local,
       count(*) FILTER (WHERE clerk_id !~ '^user_[A-Za-z0-9]{10,}$' AND clerk_id NOT LIKE 'better-auth:%') AS other_shape,
       count(*) FILTER (WHERE is_platform_admin) AS platform_admins,
       to_char(min(created_at), 'YYYY-MM') AS first_user_month, to_char(max(created_at), 'YYYY-MM') AS last_user_month
FROM users;
\echo '-- 2. users by number of memberships'
SELECT CASE WHEN n = 0 THEN '0' WHEN n = 1 THEN '1' WHEN n <= 5 THEN '2-5' ELSE '6+' END AS memberships, count(*) AS users
FROM (SELECT u.id, count(m.id) AS n FROM users u LEFT JOIN organization_members m ON m.user_id = u.id GROUP BY u.id) x
GROUP BY 1 ORDER BY 1;
\echo '-- 3. memberships by role'
SELECT role, count(*) AS memberships FROM organization_members GROUP BY role ORDER BY role;
\echo '-- 4. organizations'
SELECT count(*) AS organizations_total,
       count(*) FILTER (WHERE members = 0) AS without_members,
       count(*) FILTER (WHERE members = 1) AS single_member,
       count(*) FILTER (WHERE members > 1) AS multi_member,
       count(*) FILTER (WHERE members > 0 AND owners = 0) AS without_owner
FROM (SELECT o.id, count(m.id) AS members, count(m.id) FILTER (WHERE m.role = 'owner') AS owners
      FROM organizations o LEFT JOIN organization_members m ON m.organization_id = o.id GROUP BY o.id) x;
\echo '-- 5. activity (no login time is stored; Clerk holds it. Proxy = non-sample work data per organization)'
WITH org_activity AS (
  SELECT o.id,
         EXISTS (SELECT 1 FROM campaigns c WHERE c.organization_id = o.id AND NOT c.is_sample) AS has_real_campaigns,
         EXISTS (SELECT 1 FROM campaigns c WHERE c.organization_id = o.id AND NOT c.is_sample AND c.updated_at > now() - interval '90 days') AS campaigns_90d,
         EXISTS (SELECT 1 FROM provider_messages p WHERE p.organization_id = o.id AND p.created_at > now() - interval '90 days') AS messages_90d,
         EXISTS (SELECT 1 FROM phone_numbers p WHERE p.organization_id = o.id AND NOT p.is_sample) AS has_real_numbers,
         EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.organization_id = o.id AND pc.mode <> 'mock') AS live_mode
  FROM organizations o)
SELECT count(*) FILTER (WHERE has_real_campaigns) AS orgs_with_real_campaigns,
       count(*) FILTER (WHERE campaigns_90d) AS orgs_campaign_activity_90d,
       count(*) FILTER (WHERE messages_90d) AS orgs_messages_90d,
       count(*) FILTER (WHERE has_real_numbers) AS orgs_with_real_numbers,
       count(*) FILTER (WHERE live_mode) AS orgs_live_mode,
       count(*) FILTER (WHERE NOT (has_real_campaigns OR has_real_numbers OR live_mode)) AS orgs_sample_only
FROM org_activity;
WITH active_orgs AS (
  SELECT o.id FROM organizations o
  WHERE EXISTS (SELECT 1 FROM campaigns c WHERE c.organization_id = o.id AND NOT c.is_sample AND c.updated_at > now() - interval '90 days')
     OR EXISTS (SELECT 1 FROM provider_messages p WHERE p.organization_id = o.id AND p.created_at > now() - interval '90 days')
     OR EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.organization_id = o.id AND pc.mode <> 'mock'))
SELECT count(DISTINCT m.user_id) AS users_in_active_or_live_orgs,
       count(DISTINCT m.user_id) FILTER (WHERE m.role = 'owner') AS owners_in_active_or_live_orgs,
       (SELECT count(*) FROM active_orgs) AS active_or_live_orgs
FROM organization_members m JOIN active_orgs a ON a.id = m.organization_id;
\echo '-- 6. Better Auth link state (before 02_migrate the tables do not exist: every user is unlinked)'
SELECT to_regclass('public.auth_user_links') IS NOT NULL AS has_auth_tables \gset
\if :has_auth_tables
SELECT count(*) FILTER (WHERE l.user_id IS NULL) AS users_without_better_auth_link,
       count(*) FILTER (WHERE l.user_id IS NULL AND u.clerk_id ~ '^user_[A-Za-z0-9]{10,}$') AS clerk_users_without_link,
       count(*) FILTER (WHERE l.user_id IS NOT NULL) AS linked_users,
       (SELECT count(*) FROM auth_users) AS auth_users,
       (SELECT count(*) FROM auth_sessions WHERE expires_at > now()) AS live_auth_sessions
FROM users u LEFT JOIN auth_user_links l ON l.user_id = u.id;
\else
SELECT count(*) AS users_without_better_auth_link, 0 AS linked_users FROM users;
\endif
\echo '-- 7. conditions that matter for Path B (counts only; <clerk id>@unknown.local is the d22a8e43 fallback for a Clerk user without email)'
SELECT (SELECT count(*) FROM (SELECT lower(trim(email)) FROM users GROUP BY 1 HAVING count(*) > 1) d) AS duplicate_email_groups,
       (SELECT coalesce(sum(n), 0) FROM (SELECT count(*) AS n FROM users GROUP BY lower(trim(email)) HAVING count(*) > 1) d) AS users_sharing_an_email,
       (SELECT count(*) FROM users WHERE trim(email) = '' OR email !~ '^[^@[:space:]]+@[^@[:space:]]+$'
                                      OR lower(email) LIKE '%@unknown.local') AS users_without_usable_email,
       (SELECT count(*) FROM organization_invitations WHERE status = 'Pending') AS pending_invitations,
       (SELECT count(*) FROM organization_invitations WHERE status = 'Pending' AND created_at < now() - interval '30 days') AS pending_invitations_older_30d;
\echo '-- 8. organizations none of whose owners can sign in yet (no Better Auth user, no auth_user_links link): each needs'
\echo '   one owner re-attached in Path B'
\if :has_auth_tables
SELECT count(*) AS orgs_needing_owner_reattach FROM organizations o
WHERE EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner')
  AND NOT EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
                  WHERE m.organization_id = o.id AND m.role = 'owner'
                    AND (u.clerk_id LIKE 'better-auth:%' OR EXISTS (SELECT 1 FROM auth_user_links l WHERE l.user_id = u.id)));
\else
SELECT count(*) AS orgs_needing_owner_reattach FROM organizations o
WHERE EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner');
\endif
ROLLBACK;
\echo 'USER INVENTORY DONE (read only; nothing changed)'
