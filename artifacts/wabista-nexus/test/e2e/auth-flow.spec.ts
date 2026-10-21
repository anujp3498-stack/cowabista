import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { db, organizationInvitationsTable, organizationMembersTable, organizationsTable, usersTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { deleteAuthUsers, E2E_PASSWORD, localUserFor, unique } from './auth-helpers';
import { authUsersTable } from '@workspace/db/auth';

// Better Auth in the real browser (Gate A): sign-up, sign-out and sign-in through the app's own forms, the
// signed-out redirect, a wrong password, and an invitation joined through the invite link (token + the
// invited email; signing up alone never joins).

test.describe('authentication', () => {
  const emails: string[] = [];
  const orgIds: number[] = [];
  const userIds: number[] = [];

  test.afterAll(async () => {
    await deleteAuthUsers(emails);
    for (const id of orgIds) await db.delete(organizationsTable).where(eq(organizationsTable.id, id)).catch(() => {});
    for (const id of userIds) await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  });

  test('sign up, sign out and sign in through the forms; a wrong password is refused; signed-out pages ask for sign-in', async ({ page }) => {
    const email = `${unique('auth-flow')}@example.com`;
    emails.push(email);

    await page.goto('/overview');
    await page.waitForURL(/\/sign-in\?next=%2Foverview$/);

    await page.getByTestId('link-to-sign-up').click();
    await page.waitForURL(/\/sign-up/);
    await page.getByTestId('input-sign-up-name').fill('Flow Tester');
    await page.getByTestId('input-sign-up-email').fill(email);
    await page.getByTestId('input-sign-up-password').fill('too-short');
    await page.getByTestId('button-sign-up-submit').click();
    await expect(page.getByTestId('auth-error')).toContainText('at least 12 characters');
    await page.getByTestId('input-sign-up-password').fill(E2E_PASSWORD);
    await page.getByTestId('button-sign-up-submit').click();
    await page.waitForURL('**/overview');
    await expect(page.getByTestId('button-user-menu')).toContainText('Flow Tester');

    await page.getByTestId('button-user-menu').click();
    await page.getByTestId('button-sign-out').click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.goto('/overview');
    await page.waitForURL(/\/sign-in/);

    await page.getByTestId('input-sign-in-email').fill(email);
    await page.getByTestId('input-sign-in-password').fill(`${E2E_PASSWORD}-wrong`);
    await page.getByTestId('button-sign-in-submit').click();
    await expect(page.getByTestId('auth-error')).toHaveText('Email or password is incorrect.');

    await page.getByTestId('input-sign-in-password').fill(E2E_PASSWORD);
    await page.getByTestId('button-sign-in-submit').click();
    await page.waitForURL('**/overview');
    await expect(page.getByTestId('button-user-menu')).toContainText('Flow Tester');

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'wabista.session_token');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
  });

  test('an invited person signs up from the invite link, then joins with the invited role', async ({ page }) => {
    const email = `${unique('invitee')}@example.com`;
    emails.push(email);
    const teamName = unique('Invite Team');
    const [org] = await db.insert(organizationsTable).values({ name: teamName, slug: unique('invite-team') }).returning();
    orgIds.push(org.id);
    const [owner] = await db.insert(usersTable).values({ clerkId: unique('invite-owner'), email: `${unique('owner')}@example.com`, name: 'Team Owner' }).returning();
    userIds.push(owner.id);
    await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: owner.id, role: 'owner' });
    const token = randomUUID();
    await db.insert(organizationInvitationsTable).values({ organizationId: org.id, email, role: 'manager', invitedByUserId: owner.id, token });

    await page.goto(`/invite/${token}`);
    await expect(page.getByTestId('invite-preview')).toContainText(teamName);
    await page.getByTestId('button-invite-sign-up').click();
    await page.waitForURL(/\/sign-up\?/);
    await expect(page.getByTestId('input-sign-up-email')).toHaveValue(email);
    await page.getByTestId('input-sign-up-name').fill('Invited Person');
    await page.getByTestId('input-sign-up-password').fill(E2E_PASSWORD);
    await page.getByTestId('button-sign-up-submit').click();

    // Back on the invite page, signed in with the invited email: not a member until they accept.
    await page.waitForURL(`**/invite/${token}`);
    const [authUser] = await db.select().from(authUsersTable).where(eq(authUsersTable.email, email));
    expect(authUser).toBeTruthy();
    const [invitationBefore] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.token, token));
    expect(invitationBefore.status).toBe('Pending');

    await page.getByTestId('button-invite-accept').click();
    await page.waitForURL('**/overview');
    await expect(page.getByTestId('button-user-menu')).toContainText('Manager');
    await expect(page.getByTestId('button-user-menu')).toContainText(teamName);

    const user = await localUserFor(page, authUser.id);
    const memberships = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, user.id));
    expect(memberships.map((m) => [m.organizationId, m.role])).toEqual([[org.id, 'manager']]);
    const [invitationAfter] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.token, token));
    expect(invitationAfter.status).toBe('Accepted');
  });
});
