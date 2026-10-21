import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "../../src/schema/users";

// Better Auth tables (email/password sign-in, replacing Clerk). They live outside lib/db/src on purpose: that
// directory is part of the Gate B measured-files hash, and none of these tables is used by the measured
// campaign paths. drizzle.config.ts loads this file as a second schema path, so the guarded `push` creates
// and keeps them. The JS property keys are Better Auth's own field names (the Drizzle adapter indexes tables
// by them); the SQL names follow this repository's snake_case convention. Ids are Better Auth's random text
// ids. A local `users` row (the integer id every membership, role and authorship column uses) is linked to
// its Better Auth user through auth_user_links; new rows carry `clerk_id = 'better-auth:<auth user id>'`
// as a transition placeholder because users.clerk_id is still NOT NULL UNIQUE (nothing authenticates by it).

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const authUsersTable = pgTable("auth_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Better Auth lowercases the email on every write.
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("auth_users_email_uq").on(t.email)]);

export const authSessionsTable = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUsersTable.id, { onDelete: "cascade" }),
}, (t) => [
  uniqueIndex("auth_sessions_token_uq").on(t.token),
  index("auth_sessions_user_id_idx").on(t.userId),
  index("auth_sessions_expires_at_idx").on(t.expiresAt),
]);

export const authAccountsTable = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => authUsersTable.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  // scrypt hash for the "credential" provider; never returned by Better Auth.
  password: text("password"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("auth_accounts_user_id_idx").on(t.userId),
  uniqueIndex("auth_accounts_provider_account_uq").on(t.providerId, t.accountId),
]);

export const authVerificationsTable = pgTable("auth_verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("auth_verifications_identifier_idx").on(t.identifier)]);

// Shared sign-in/sign-up rate limiting across API processes (rateLimit.storage = "database"). The unique key
// lets Better Auth detect a concurrent first insert. `last_request` is read in number mode: better-auth
// 1.7.10 converts it only from a JS bigint, and node-postgres returns int8 as a string, which would turn the
// Retry-After arithmetic into string concatenation.
export const authRateLimitsTable = pgTable("auth_rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}, (t) => [
  uniqueIndex("auth_rate_limits_key_uq").on(t.key),
  index("auth_rate_limits_last_request_idx").on(t.lastRequest),
]);

/** One local user per Better Auth user (and the reverse); deleting either side removes the link. */
export const authUserLinksTable = pgTable("auth_user_links", {
  authUserId: text("auth_user_id").primaryKey().references(() => authUsersTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("auth_user_links_user_id_uq").on(t.userId)]);

/** The schema object for Better Auth's Drizzle adapter: keys are Better Auth model names. */
export const betterAuthSchema = {
  user: authUsersTable,
  session: authSessionsTable,
  account: authAccountsTable,
  verification: authVerificationsTable,
  rateLimit: authRateLimitsTable,
};

export type AuthUser = typeof authUsersTable.$inferSelect;
