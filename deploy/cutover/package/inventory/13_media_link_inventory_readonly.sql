-- Wabista Nexus P6 media-link inventory (READ ONLY; safe on production at any time; changes nothing).
-- Production (d22a8e43) has no managed media: header images/videos/documents are links in campaign_template_mappings.
-- The release still sends those links, but links that point at Replit-hosted objects break once Replit is retired.
-- Prints counts, internal campaign ids and link HOST names only (never full URLs: signed URLs carry signatures).
--   psql -X -v ON_ERROR_STOP=1 -L logs/13_media_link_inventory_readonly-$(date -u +%Y%m%dT%H%M%SZ).log -f inventory/13_media_link_inventory_readonly.sql; echo "exit=$?"
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
\echo '== P6 media-link inventory (read only) =='
SELECT m.source, count(*) AS mappings, count(DISTINCT m.campaign_id) AS campaigns,
  count(*) FILTER (WHERE m.source = 'static' AND m.source_value LIKE '/objects/%') AS static_relative_objects,
  count(*) FILTER (WHERE m.source = 'static' AND m.source_value ~* '^https?://[^/]+/objects/') AS static_abs_objects,
  count(*) FILTER (WHERE m.source = 'static' AND m.source_value ~* '^https?://[^/]*(replit|repl\.co|storage\.googleapis\.com)') AS static_replit_or_gcs,
  count(*) FILTER (WHERE m.fallback_value ~* '(/objects/|replit|repl\.co|storage\.googleapis\.com)') AS fallback_matches
FROM campaign_template_mappings m
WHERE m.component = 'header' AND m.variable = 'media'
GROUP BY m.source ORDER BY m.source;
\echo '-- campaigns whose static media link points at Replit-hosted objects (switch to an uploaded file while Draft/Ready)'
SELECT m.campaign_id, c.status, substring(lower(m.source_value) from '^https?://(?:[^/?#@]*@)?([^/?#:]+)') AS url_host, count(*) AS mappings
FROM campaign_template_mappings m JOIN campaigns c ON c.id = m.campaign_id
WHERE m.component = 'header' AND m.variable = 'media' AND m.source = 'static'
  AND (m.source_value LIKE '/objects/%' OR m.source_value ~* '^https?://[^/]+/objects/'
       OR m.source_value ~* '^https?://[^/]*(replit|repl\.co|storage\.googleapis\.com)')
GROUP BY m.campaign_id, c.status, url_host ORDER BY m.campaign_id;
\echo '-- frozen plans of campaigns that can still send (jobs resolve from the plan snapshot, not the live mapping)'
SELECT p.campaign_id, c.status AS campaign_status, p.id AS plan_id, p.status AS plan_status, e->>'source' AS source,
  substring(lower(e->>'sourceValue') from '^https?://(?:[^/?#@]*@)?([^/?#:]+)') AS url_host,
  (e->>'sourceValue') LIKE '/objects/%' AS relative_objects_path, count(*) AS mappings
FROM campaign_plans p
JOIN campaigns c ON c.id = p.campaign_id
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.mappings_snapshot) = 'array' THEN p.mappings_snapshot ELSE '[]'::jsonb END) AS e
WHERE c.status IN ('Ready', 'Scheduled', 'Running', 'Paused')
  AND e->>'component' = 'header' AND e->>'variable' = 'media'
GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 3;
\echo '-- csv-sourced media headers take URLs from campaign_contacts.data (not scanned here: a large table; a non-zero csv count needs a manual look on a restored copy)'
SELECT to_regclass('public.campaign_media_assets') IS NOT NULL AS migrated \gset
\if :migrated
SELECT count(*) AS managed_media_assets FROM campaign_media_assets;
\endif
ROLLBACK;
\echo 'MEDIA-LINK INVENTORY DONE (read only; nothing changed)'
