-- Wabista Nexus P6 credential-key inventory (READ ONLY). Decides whether WHATSAPP_CREDENTIAL_ENCRYPTION_KEY may be
-- generated new or must be preserved byte-for-byte (environment section, "Encryption key rule").
--   psql -X -v ON_ERROR_STOP=1 -L logs/15_credential_key_inventory-$(date -u +%Y%m%dT%H%M%SZ).log -f inventory/15_credential_key_inventory_readonly.sql; echo "exit=$?"
-- Prints counts, statuses and key versions only. It never selects token_ciphertext, token_iv, token_auth_tag,
-- token_fingerprint or provider_identity, and it never decrypts anything.
-- Verdicts (last line):
--   KEY RULE: NEW KEY PERMITTED      no whatsapp_credentials table, or the table holds no row at all.
--   KEY RULE: PRESERVE EXISTING KEY  at least one stored credential (any status) was encrypted with an existing key:
--                                    copy the current WHATSAPP_CREDENTIAL_ENCRYPTION_KEY byte-for-byte to both cells
--                                    and never generate a replacement.
--   STOP (exit 3)                    a key_version other than 1 exists (the release decrypts version 1 only).
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '600s';
BEGIN TRANSACTION READ ONLY;
SET search_path = public;
SELECT to_regclass('public.whatsapp_credentials') IS NOT NULL AS has_credentials \gset
\echo '== P6 credential-key inventory: database' :'DBNAME' ' whatsapp_credentials table present:' :has_credentials '=='
\if :has_credentials
SELECT count(*) AS credentials_total,
       count(*) FILTER (WHERE key_version <> 1) AS credentials_other_key_version,
       count(DISTINCT organization_id) AS organizations_with_credentials
FROM whatsapp_credentials \gset
\echo '-- stored credentials by key version, status and kind (counts only)'
SELECT key_version, status, kind, count(*) AS credentials FROM whatsapp_credentials GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'phone_numbers'
               AND column_name = 'sending_credential_id') AS has_binding \gset
\if :has_binding
\echo '-- phone numbers that send with a stored credential (counts only)'
SELECT count(*) AS phones_bound_to_a_credential FROM phone_numbers WHERE sending_credential_id IS NOT NULL;
\endif
\else
SELECT 0 AS credentials_total, 0 AS credentials_other_key_version, 0 AS organizations_with_credentials \gset
\endif
ROLLBACK;
\echo '   credentials_total=' :credentials_total ' organizations_with_credentials=' :organizations_with_credentials ' other_key_versions=' :credentials_other_key_version
SELECT :credentials_other_key_version > 0 AS key_version_stop, :credentials_total > 0 AS preserve_key \gset
\if :key_version_stop
\echo 'STOP: credentials encrypted with a key_version other than 1 exist; the release decrypts key version 1 only. Do not cut over until this is explained.'
DO $$ BEGIN RAISE EXCEPTION 'P6 credential-key inventory: unsupported key_version'; END $$;
\endif
\if :preserve_key
\echo 'KEY RULE: PRESERVE EXISTING KEY. Stored credentials need the current WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: copy it byte-for-byte to both cells (salted-fingerprint match with its current source); never generate a new one.'
\else
\echo 'KEY RULE: NEW KEY PERMITTED. No stored credential needs an existing key: generate WHATSAPP_CREDENTIAL_ENCRYPTION_KEY once and stage the same value on both cells.'
\endif
