import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

export const INVITATION_STATUSES = ["Pending", "Accepted", "Revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

// A pending invitation lets an admin add someone to their organization by
// email before that person has an account. `email` is always stored
// lowercased (Clerk preserves user-typed casing on sign-up, so matching an
// invite to a new signup must compare case-insensitively -- see
// attachOrgContext / acceptPendingInvitations). Accepted/revoked rows are
// kept (not deleted) as an audit trail; the partial unique index only
// constrains one Pending invite per organization+email at a time, so
// re-inviting after a revoke or accepting-then-leaving works cleanly.
export const organizationInvitationsTable = pgTable(
  "organization_invitations",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("agent"),
    status: text("status").notNull().default("Pending"),
    // Opaque random token used to build a shareable invite link
    // (`/invite/:token`) that the inviter can hand to the invitee directly,
    // instead of relying solely on them organically signing up with a
    // matching email. Acceptance itself still happens via the existing
    // email-match logic in attachOrgContext -- the token only powers the
    // informational landing page, so it never widens who can join.
    // DB-level default so any insert (including test fixtures) that omits
    // it still gets a usable, unique token -- app code always supplies its
    // own via randomUUID() so this default is a safety net, not the norm.
    token: text("token")
      .notNull()
      .default(sql`md5(random()::text || clock_timestamp()::text)`),
    invitedByUserId: integer("invited_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    acceptedByUserId: integer("accepted_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("organization_invitations_pending_uq")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'Pending'`),
    index("organization_invitations_email_idx").on(t.email),
    uniqueIndex("organization_invitations_token_uq").on(t.token),
  ],
);

export const insertOrganizationInvitationSchema = createInsertSchema(
  organizationInvitationsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrganizationInvitation = z.infer<
  typeof insertOrganizationInvitationSchema
>;
export type OrganizationInvitation =
  typeof organizationInvitationsTable.$inferSelect;
