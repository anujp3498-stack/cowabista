import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { eq, inArray } from 'drizzle-orm';
import { db, organizationMembersTable, organizationsTable, usersTable } from '@workspace/db';
import { authUserLinksTable, authUsersTable } from '@workspace/db/auth';

// Shared Better Auth helpers for the E2E specs (not a spec itself). Accounts are created with a random
// per-run password that is never printed. Every browser request reaches the API from the same address (the
// Vite proxy appends the real one, and the API trusts exactly that hop), and Better Auth allows 3 sign-ups
// and 3 sign-ins per 10 s per address: keep the specs within that.

export function unique(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

export const E2E_PASSWORD = `e2e-${randomBytes(12).toString('base64url')}`;

/** Signs up through the API from the page's own context, so the session cookie lands in the browser. */
export async function signUpViaApi(page: Page, baseURL: string, name: string, email: string): Promise<string> {
  const response = await page.request.post('/api/auth/sign-up/email', {
    data: { name, email, password: E2E_PASSWORD },
    headers: { Origin: new URL(baseURL).origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
}

/** The local users row linked to a Better Auth user, polled while the first request provisions it. */
export async function localUserFor(page: Page, authUserId: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [row] = await db
      .select({ user: usersTable })
      .from(authUserLinksTable)
      .innerJoin(usersTable, eq(usersTable.id, authUserLinksTable.userId))
      .where(eq(authUserLinksTable.authUserId, authUserId));
    if (row) return row.user;
    await page.waitForTimeout(500);
  }
  throw new Error('The local user was never provisioned for the Better Auth test user');
}

/** Removes Better Auth users (by email) with their local rows and the workspaces they own. */
export async function deleteAuthUsers(emails: string[]): Promise<void> {
  if (!emails.length) return;
  const authUsers = await db.select({ id: authUsersTable.id }).from(authUsersTable).where(inArray(authUsersTable.email, emails.map((e) => e.toLowerCase())));
  if (!authUsers.length) return;
  const links = await db.select().from(authUserLinksTable).where(inArray(authUserLinksTable.authUserId, authUsers.map((u) => u.id)));
  const userIds = links.map((link) => link.userId);
  if (userIds.length) {
    const owned = await db.select({ id: organizationMembersTable.organizationId }).from(organizationMembersTable)
      .where(inArray(organizationMembersTable.userId, userIds));
    const ownedIds = owned.map((o) => o.id);
    for (const id of ownedIds) {
      const members = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.organizationId, id));
      // Only workspaces with no other member are removed (a personal workspace).
      if (members.every((m) => userIds.includes(m.userId))) await db.delete(organizationsTable).where(eq(organizationsTable.id, id)).catch(() => {});
    }
    await db.delete(usersTable).where(inArray(usersTable.id, userIds)).catch(() => {});
  }
  await db.delete(authUsersTable).where(inArray(authUsersTable.id, authUsers.map((u) => u.id))).catch(() => {});
}
