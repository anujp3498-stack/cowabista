import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { db, organizationInvitationsTable, organizationMembersTable, organizationsTable, usersTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { createAccount, deleteAuthUsers, E2E_PASSWORD, localUserFor, unique, waitForSignInWindow } from './auth-helpers';

// Better Auth in the real browser with public sign-up closed (Option 2a, as in production): no sign-up link
// or form anywhere and the sign-up endpoint answers 404; an operator-created account signs in through the
// form (a wrong password is refused), changes its password from the account menu, signs out and back in with
// the new password; the signed-out redirect; and an invitation joined through the invite link by signing in
// (token + the invited email; there is no "create account" path).

/** Opens a page and waits until the SPA has the server's sign-up policy (closed) and has rendered with it: the
 * SPA hides sign-up while the policy is loading too, so assertions must run only after the answer arrived. */
async function gotoWithClosedPolicy(page: Page, url: string) {
  const policy = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth-policy');
  await page.goto(url);
  expect(await (await policy).json()).toEqual({ publicSignUp: false });
  await page.waitForLoadState('networkidle');
}

test.describe('authentication (public sign-up closed)', () => {
  const emails: string[] = [];
  const orgIds: number[] = [];
  const userIds: number[] = [];

  test.afterAll(async () => {
    await deleteAuthUsers(emails);
    for (const id of orgIds) await db.delete(organizationsTable).where(eq(organizationsTable.id, id)).catch(() => {});
    for (const id of userIds) await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  });

  test('no self sign-up; an operator-created account signs in, changes its password, signs out and back in', async ({ page, baseURL }) => {
    const email = `${unique('auth-flow')}@example.com`;
    emails.push(email);
    await createAccount('Flow Tester', email);
    const changed = `e2e-new-${randomBytes(12).toString('base64url')}`;

    await gotoWithClosedPolicy(page, '/');
    await expect(page.getByTestId('link-sign-in')).toBeVisible();
    await expect(page.getByTestId('link-sign-up')).toHaveCount(0);
    await expect(page.getByTestId('link-hero-get-started')).toHaveCount(0);
    await expect(page.getByTestId('link-cta-get-started')).toHaveCount(0);

    const refused = await page.request.post('/api/auth/sign-up/email', {
      data: { name: 'Squatter', email: `${unique('squatter')}@example.com`, password: E2E_PASSWORD },
      headers: { Origin: new URL(baseURL!).origin },
    });
    expect(refused.status()).toBe(404);

    await gotoWithClosedPolicy(page, '/sign-up');
    await expect(page.getByTestId('sign-up-closed')).toBeVisible();
    await expect(page.getByTestId('input-sign-up-email')).toHaveCount(0);

    await gotoWithClosedPolicy(page, '/overview');
    await page.waitForURL(/\/sign-in\?next=%2Foverview$/);
    await expect(page.getByTestId('link-to-sign-up')).toHaveCount(0);
    await expect(page.getByTestId('sign-in-no-account')).toContainText('administrator');

    await waitForSignInWindow(page);
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

    await page.getByTestId('button-user-menu').click();
    await page.getByTestId('button-change-password').click();
    await page.waitForURL('**/account/password');
    await page.getByTestId('input-current-password').fill(`${E2E_PASSWORD}-wrong`);
    await page.getByTestId('input-new-password').fill(changed);
    await page.getByTestId('input-confirm-password').fill(changed);
    await page.getByTestId('button-change-password-submit').click();
    await expect(page.getByTestId('change-password-error')).toHaveText('Your current password is incorrect.');
    await page.getByTestId('input-current-password').fill(E2E_PASSWORD);
    await page.getByTestId('button-change-password-submit').click();
    await expect(page.getByTestId('change-password-success')).toBeVisible();
    await expect(page.getByTestId('input-current-password')).toHaveValue('');

    // Still signed in on the new session the change issued.
    await page.goto('/overview');
    await expect(page.getByTestId('button-user-menu')).toContainText('Flow Tester');
    await page.getByTestId('button-user-menu').click();
    await page.getByTestId('button-sign-out').click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.goto('/overview');
    await page.waitForURL(/\/sign-in/);

    await page.getByTestId('input-sign-in-email').fill(email);
    await page.getByTestId('input-sign-in-password').fill(changed);
    await page.getByTestId('button-sign-in-submit').click();
    await page.waitForURL('**/overview');
    await expect(page.getByTestId('button-user-menu')).toContainText('Flow Tester');
  });

  test('an invited person with an operator-created account signs in from the invite link, then joins with the invited role', async ({ page }) => {
    const email = `${unique('invitee')}@example.com`;
    emails.push(email);
    const authUserId = await createAccount('Invited Person', email);
    const teamName = unique('Invite Team');
    const [org] = await db.insert(organizationsTable).values({ name: teamName, slug: unique('invite-team') }).returning();
    orgIds.push(org.id);
    const [owner] = await db.insert(usersTable).values({ clerkId: unique('invite-owner'), email: `${unique('owner')}@example.com`, name: 'Team Owner' }).returning();
    userIds.push(owner.id);
    await db.insert(organizationMembersTable).values({ organizationId: org.id, userId: owner.id, role: 'owner' });
    const token = randomUUID();
    await db.insert(organizationInvitationsTable).values({ organizationId: org.id, email, role: 'manager', invitedByUserId: owner.id, token });

    await gotoWithClosedPolicy(page, `/invite/${token}`);
    await expect(page.getByTestId('invite-preview')).toContainText(teamName);
    await expect(page.getByTestId('button-invite-sign-up')).toHaveCount(0);
    await page.getByTestId('button-invite-sign-in').click();
    await page.waitForURL(/\/sign-in\?/);
    await expect(page.getByTestId('input-sign-in-email')).toHaveValue(email);

    await waitForSignInWindow(page);
    await page.getByTestId('input-sign-in-password').fill(E2E_PASSWORD);
    await page.getByTestId('button-sign-in-submit').click();

    // Back on the invite page, signed in with the invited email: not a member until they accept.
    await page.waitForURL(`**/invite/${token}`);
    const [invitationBefore] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.token, token));
    expect(invitationBefore.status).toBe('Pending');

    await page.getByTestId('button-invite-accept').click();
    await page.waitForURL('**/overview');
    await expect(page.getByTestId('button-user-menu')).toContainText('Manager');
    await expect(page.getByTestId('button-user-menu')).toContainText(teamName);

    const user = await localUserFor(page, authUserId);
    const memberships = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, user.id));
    expect(memberships.map((m) => [m.organizationId, m.role])).toEqual([[org.id, 'manager']]);
    const [invitationAfter] = await db.select().from(organizationInvitationsTable).where(eq(organizationInvitationsTable.token, token));
    expect(invitationAfter.status).toBe('Accepted');
  });
});
