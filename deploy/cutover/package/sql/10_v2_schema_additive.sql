-- Wabista Nexus production migration, part 10: V2 schema delta (ADDITIVE ONLY).
-- From the production branch schema (d22a8e43bf0d, lib/db/src) to the release candidate e37ab27e085c.
-- Generated with drizzle-kit 0.31.10 (guarded dry-run push against a disposable copy of the production schema),
-- then filtered: drizzle's recurring no-op statements (re-created trigram indexes, re-added foreign keys whose
-- names exceed 63 characters, re-set column defaults) are removed because those objects already exist.
-- Contents: 10 new tables, 23 new columns on existing tables (each nullable or NOT NULL with a constant
-- DEFAULT, so existing rows are kept and no table rewrite happens on PostgreSQL >= 11), new foreign keys
-- (all on new tables or new, initially NULL columns) and new indexes.
-- No DROP, TRUNCATE, DELETE, UPDATE, RENAME, type change or row change. Run only through 02_migrate.psql.

CREATE TABLE "whatsapp_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"provider" text DEFAULT 'whatsapp-business' NOT NULL,
	"kind" text DEFAULT 'manual_token' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"token_fingerprint" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"provider_identity" text,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "template_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"waba_id" integer,
	"name" text NOT NULL,
	"language" text DEFAULT 'en_US' NOT NULL,
	"category" text DEFAULT 'MARKETING' NOT NULL,
	"content" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"provider_template_id" text,
	"provider_status" text,
	"provider_status_checked_at" timestamp with time zone,
	"template_id" integer,
	"last_error" text,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "template_media_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"waba_id" integer NOT NULL,
	"credential_id" integer,
	"app_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"kind" text NOT NULL,
	"provider_session_id" text,
	"provider_handle" text,
	"state" text DEFAULT 'ready' NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "template_submission_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"draft_id" integer,
	"draft_revision" integer NOT NULL,
	"waba_id" integer NOT NULL,
	"waba_external_id" text NOT NULL,
	"credential_id" integer,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"provider_template_id" text,
	"provider_status" text,
	"provider_category" text,
	"error" text,
	"error_code" text,
	"reconcile_note" text,
	"late_provider_template_id" text,
	"late_outcome" jsonb,
	"late_outcome_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "template_eligibility" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"template_id" integer NOT NULL,
	"waba_id" integer NOT NULL,
	"provider_template_id" text NOT NULL,
	"provider_status" text,
	"status" text NOT NULL,
	"provider_missing" boolean DEFAULT false NOT NULL,
	"sendable" boolean DEFAULT false NOT NULL,
	"evidence_source" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"sync_generation" integer,
	"credential_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "campaign_media_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"campaign_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "campaign_media_provider_bindings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"media_asset_id" integer NOT NULL,
	"phone_number_id" integer NOT NULL,
	"waba_id" integer,
	"transport" text NOT NULL,
	"provider_media_id" text NOT NULL,
	"credential_id" integer,
	"credential_revision" integer,
	"sha256" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "campaign_message_setups" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"campaign_id" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"sender_phone_number_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mapping_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "contact_import_occurrences" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"campaign_id" integer NOT NULL,
	"import_session_id" integer NOT NULL,
	"row_number" integer NOT NULL,
	"audience_generation" integer DEFAULT 0 NOT NULL,
	"classification" text NOT NULL,
	"raw_phone" text,
	"normalized_phone" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"canonical_contact_id" integer,
	"canonical_status" text,
	"canonical_import_session_id" integer,
	"canonical_row_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "wabas" ADD COLUMN "credential_id" integer;

ALTER TABLE "wabas" ADD COLUMN "template_sync_generation" integer DEFAULT 0 NOT NULL;

ALTER TABLE "wabas" ADD COLUMN "template_sync_applied_generation" integer DEFAULT 0 NOT NULL;

ALTER TABLE "phone_numbers" ADD COLUMN "setup_state" text DEFAULT 'unknown' NOT NULL;

ALTER TABLE "phone_numbers" ADD COLUMN "setup_error" text;

ALTER TABLE "phone_numbers" ADD COLUMN "credential_id" integer;

ALTER TABLE "phone_numbers" ADD COLUMN "sending_credential_id" integer;

ALTER TABLE "campaign_routes" ADD COLUMN "waba_id" integer;

ALTER TABLE "campaign_routes" ADD COLUMN "shared_phone_budget" boolean DEFAULT false NOT NULL;

ALTER TABLE "campaign_contacts" ADD COLUMN "audience_generation" integer DEFAULT 0 NOT NULL;

ALTER TABLE "campaign_plans" ADD COLUMN "distribution_mode" text;

ALTER TABLE "campaign_plans" ADD COLUMN "delivery_mode" text;

ALTER TABLE "campaign_template_mappings" ADD COLUMN "media_asset_id" integer;

ALTER TABLE "contact_import_sessions" ADD COLUMN "operation" text DEFAULT 'append' NOT NULL;

ALTER TABLE "contact_import_sessions" ADD COLUMN "audience_generation" integer DEFAULT 0 NOT NULL;

ALTER TABLE "contact_import_sessions" ADD COLUMN "activated_at" timestamp with time zone;

ALTER TABLE "campaigns" ADD COLUMN "creation_key" text;

ALTER TABLE "campaigns" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;

ALTER TABLE "campaigns" ADD COLUMN "audience_generation" integer DEFAULT 0 NOT NULL;

ALTER TABLE "campaigns" ADD COLUMN "distribution_mode" text;

ALTER TABLE "campaigns" ADD COLUMN "delivery_mode" text;

ALTER TABLE "campaigns" ADD COLUMN "delivery_settings" jsonb;

ALTER TABLE "campaigns" ADD COLUMN "timezone" text;

ALTER TABLE "whatsapp_credentials" ADD CONSTRAINT "whatsapp_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_waba_id_wabas_id_fk" FOREIGN KEY ("waba_id") REFERENCES "public"."wabas"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_media_uploads" ADD CONSTRAINT "template_media_uploads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_media_uploads" ADD CONSTRAINT "template_media_uploads_waba_id_wabas_id_fk" FOREIGN KEY ("waba_id") REFERENCES "public"."wabas"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_media_uploads" ADD CONSTRAINT "template_media_uploads_credential_id_whatsapp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."whatsapp_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_media_uploads" ADD CONSTRAINT "template_media_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_submission_attempts" ADD CONSTRAINT "template_submission_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_submission_attempts" ADD CONSTRAINT "template_submission_attempts_draft_id_template_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."template_drafts"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_submission_attempts" ADD CONSTRAINT "template_submission_attempts_waba_id_wabas_id_fk" FOREIGN KEY ("waba_id") REFERENCES "public"."wabas"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_submission_attempts" ADD CONSTRAINT "template_submission_attempts_credential_id_whatsapp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."whatsapp_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_submission_attempts" ADD CONSTRAINT "template_submission_attempts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "template_eligibility" ADD CONSTRAINT "template_eligibility_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_eligibility" ADD CONSTRAINT "template_eligibility_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_eligibility" ADD CONSTRAINT "template_eligibility_waba_id_wabas_id_fk" FOREIGN KEY ("waba_id") REFERENCES "public"."wabas"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "template_eligibility" ADD CONSTRAINT "template_eligibility_credential_id_whatsapp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."whatsapp_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "campaign_media_assets" ADD CONSTRAINT "campaign_media_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_media_assets" ADD CONSTRAINT "campaign_media_assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_media_assets" ADD CONSTRAINT "campaign_media_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "campaign_media_provider_bindings" ADD CONSTRAINT "campaign_media_provider_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_media_provider_bindings" ADD CONSTRAINT "campaign_media_provider_bindings_media_asset_id_campaign_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."campaign_media_assets"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_media_provider_bindings" ADD CONSTRAINT "campaign_media_provider_bindings_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_message_setups" ADD CONSTRAINT "campaign_message_setups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_message_setups" ADD CONSTRAINT "campaign_message_setups_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "campaign_message_setups" ADD CONSTRAINT "campaign_message_setups_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "mapping_presets" ADD CONSTRAINT "mapping_presets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "mapping_presets" ADD CONSTRAINT "mapping_presets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "contact_import_occurrences" ADD CONSTRAINT "contact_import_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "contact_import_occurrences" ADD CONSTRAINT "contact_import_occurrences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "contact_import_occurrences" ADD CONSTRAINT "contact_import_occurrences_import_session_id_contact_import_sessions_id_fk" FOREIGN KEY ("import_session_id") REFERENCES "public"."contact_import_sessions"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "contact_import_occurrences" ADD CONSTRAINT "contact_import_occurrences_canonical_contact_id_campaign_contacts_id_fk" FOREIGN KEY ("canonical_contact_id") REFERENCES "public"."campaign_contacts"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "whatsapp_credentials_org_idx" ON "whatsapp_credentials" USING btree ("organization_id");

CREATE INDEX "whatsapp_credentials_org_fingerprint_idx" ON "whatsapp_credentials" USING btree ("organization_id","token_fingerprint");

CREATE INDEX "template_drafts_org_idx" ON "template_drafts" USING btree ("organization_id","id");

CREATE UNIQUE INDEX "template_drafts_waba_name_lang_uq" ON "template_drafts" USING btree ("organization_id","waba_id","name","language");

CREATE INDEX "template_media_uploads_org_idx" ON "template_media_uploads" USING btree ("organization_id","id");

CREATE INDEX "template_submission_attempts_draft_idx" ON "template_submission_attempts" USING btree ("draft_id","id");

CREATE UNIQUE INDEX "template_submission_attempts_active_uq" ON "template_submission_attempts" USING btree ("draft_id") WHERE "template_submission_attempts"."state" in ('requested', 'uncertain');

CREATE UNIQUE INDEX "template_eligibility_org_template_uq" ON "template_eligibility" USING btree ("organization_id","template_id");

CREATE INDEX "template_eligibility_org_waba_idx" ON "template_eligibility" USING btree ("organization_id","waba_id","sendable");

CREATE INDEX "campaign_media_asset_campaign_idx" ON "campaign_media_assets" USING btree ("organization_id","campaign_id","status");

CREATE UNIQUE INDEX "campaign_media_asset_storage_key_uq" ON "campaign_media_assets" USING btree ("storage_key");

CREATE UNIQUE INDEX "campaign_media_binding_asset_phone_uq" ON "campaign_media_provider_bindings" USING btree ("media_asset_id","phone_number_id");

CREATE UNIQUE INDEX "campaign_message_setup_campaign_uq" ON "campaign_message_setups" USING btree ("campaign_id");

CREATE UNIQUE INDEX "mapping_preset_org_name_uq" ON "mapping_presets" USING btree ("organization_id","name");

CREATE UNIQUE INDEX "contact_import_occurrence_row_uq" ON "contact_import_occurrences" USING btree ("import_session_id","row_number");

CREATE INDEX "contact_import_occurrence_session_id_idx" ON "contact_import_occurrences" USING btree ("import_session_id","id");

ALTER TABLE "wabas" ADD CONSTRAINT "wabas_credential_id_whatsapp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."whatsapp_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_credential_id_whatsapp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."whatsapp_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_sending_credential_id_whatsapp_credentials_id_fk" FOREIGN KEY ("sending_credential_id") REFERENCES "public"."whatsapp_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "campaign_routes" ADD CONSTRAINT "campaign_routes_waba_id_wabas_id_fk" FOREIGN KEY ("waba_id") REFERENCES "public"."wabas"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "campaign_template_mappings" ADD CONSTRAINT "campaign_template_mappings_media_asset_id_campaign_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."campaign_media_assets"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "campaign_contact_generation_id_idx" ON "campaign_contacts" USING btree ("campaign_id","audience_generation","id");

CREATE INDEX "campaign_contact_generation_status_id_idx" ON "campaign_contacts" USING btree ("campaign_id","audience_generation","status","id");

CREATE INDEX "campaign_contact_import_session_id_idx" ON "campaign_contacts" USING btree ("import_session_id","status","id");

CREATE UNIQUE INDEX "campaign_org_creation_key_uq" ON "campaigns" USING btree ("organization_id","creation_key");
