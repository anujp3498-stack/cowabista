-- Part 30: Better Auth schema (ADDITIVE ONLY), lib/db/auth/src/index.ts at e37ab27e085c.
-- Six new tables: auth_users, auth_sessions, auth_accounts, auth_verifications, auth_rate_limits and
-- auth_user_links (1:1 link from a Better Auth user to an existing integer users.id). users is not altered:
-- users.id, users.clerk_id (NOT NULL UNIQUE) and every membership, role, ownership and history row stay as
-- they are. No existing user is linked, changed or deleted here.

CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "auth_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);

CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);

CREATE TABLE "auth_user_links" (
	"auth_user_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "auth_user_links" ADD CONSTRAINT "auth_user_links_auth_user_id_auth_users_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "auth_user_links" ADD CONSTRAINT "auth_user_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" USING btree ("user_id");

CREATE UNIQUE INDEX "auth_accounts_provider_account_uq" ON "auth_accounts" USING btree ("provider_id","account_id");

CREATE UNIQUE INDEX "auth_rate_limits_key_uq" ON "auth_rate_limits" USING btree ("key");

CREATE INDEX "auth_rate_limits_last_request_idx" ON "auth_rate_limits" USING btree ("last_request");

CREATE UNIQUE INDEX "auth_sessions_token_uq" ON "auth_sessions" USING btree ("token");

CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");

CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");

CREATE UNIQUE INDEX "auth_user_links_user_id_uq" ON "auth_user_links" USING btree ("user_id");

CREATE UNIQUE INDEX "auth_users_email_uq" ON "auth_users" USING btree ("email");

CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");
