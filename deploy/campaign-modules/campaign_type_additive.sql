-- Campaign modules (Normal / Rocket): the only schema change. Additive and metadata-only on PostgreSQL 11+
-- (a nullable column without a default rewrites no row and holds the ACCESS EXCLUSIVE lock only for the catalog
-- update). Every existing campaign keeps campaign_type NULL ("created before campaign types"): the API infers its
-- module from its routes for listing only and applies no module rule to it. NOT applied anywhere from this
-- branch: production schema changes are planned with the owner (see docs/CAMPAIGN-MODULES.md).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type text;
COMMENT ON COLUMN campaigns.campaign_type IS 'Campaign module: standard (Normal) or rocket (Rocket); NULL = created before campaign types. Set once at creation.';
