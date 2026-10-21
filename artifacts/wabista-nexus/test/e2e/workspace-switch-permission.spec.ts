import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import {
  db,
  pool,
  organizationsTable,
  organizationMembersTable,
  usersTable,
} from '@workspace/db';
import { deleteAuthUsers, localUserFor, signUpViaApi, unique } from './auth-helpers';

// Regression check for Task #7: switching the active workspace must
// *immediately* reflect the new organization's role and member data in the
// UI -- never a stale/more-privileged role, and never another tenant's
// member rows, surviving from the previously active org. The fix lives in
// WorkspaceSwitcher.handleSwitch (src/components/layout/shell.tsx), which
// clears the React Query cache and forces a full page reload on switch
// instead of relying on cache invalidation alone. See also
// test/workspace-switch-permission-regression.md (the manual plan this
// harness supersedes with real, repeatable automation).
//
// This is a real, checked-in Playwright test (not the ad hoc testing
// subagent) so it can be re-run on demand or wired into CI, any time
// WorkspaceSwitcher, attachOrgContext, or the member/role-gating logic in
// team-roles.tsx changes.

test.describe('workspace switch: permission + cross-tenant data isolation', () => {
  test.afterAll(async () => {
    await pool.end();
  });

  test('switching org A (owner) <-> org B (manager) never leaks stale permissions or the other tenant\'s member data', async ({
    page,
    baseURL,
  }) => {
    const email = `${unique('switch-test')}@example.com`;
    const seedUserIds: number[] = [];
    let orgAId: number | undefined;
    let orgBId: number | undefined;

    try {
      // 1. Sign up a real Better Auth account through the API from the
      // page's own context (the session cookie lands in the browser), then
      // open the app signed in. The UI sign-up/sign-in forms are covered in
      // auth-flow.spec.ts.
        const authUserId = await signUpViaApi(page, baseURL!, 'Switch Tester', email);
      await page.goto('/overview');
      await page.waitForURL('**/overview');

      // 2. The first authenticated request JIT-provisions the local user
      // row (linked through auth_user_links) plus a personal "Org A" (Owner
      // membership). Poll briefly for it, then read the result straight
      // from the database.
      const ourUser = await localUserFor(page, authUserId);

      // Membership provisioning happens inside attachOrgContext's own
      // transaction, which can still be in flight for a brief moment after
      // the user row itself becomes visible -- poll instead of a single
      // read to avoid a race against that in-request transaction.
      let membershipsA: (typeof organizationMembersTable.$inferSelect)[] = [];
      for (let attempt = 0; attempt < 20 && membershipsA.length === 0; attempt++) {
        membershipsA = await db
          .select()
          .from(organizationMembersTable)
          .where(eq(organizationMembersTable.userId, ourUser.id));
        if (membershipsA.length === 0) await page.waitForTimeout(500);
      }
      if (membershipsA.length !== 1 || membershipsA[0].role !== 'owner') {
        throw new Error(
          `Expected exactly one Owner membership (personal org) after first login, got: ${JSON.stringify(membershipsA)}`,
        );
      }
      orgAId = membershipsA[0].organizationId;

      // 3. Seed Org B (Manager role for the same user) plus one
      // distinguishable "seed" member per org, so the UI check below
      // proves both permission gating AND member data never leak across
      // the switch -- not just the Invite Member button.
      const [orgB] = await db
        .insert(organizationsTable)
        .values({ name: unique('Org B'), slug: unique('org-b') })
        .returning();
      orgBId = orgB.id;
      await db.insert(organizationMembersTable).values({
        organizationId: orgBId,
        userId: ourUser.id,
        role: 'manager',
      });

      const seedNameA = unique('OrgA-Seed-Member');
      const seedNameB = unique('OrgB-Seed-Member');

      const [seedUserA] = await db
        .insert(usersTable)
        .values({ clerkId: unique('seed-a'), email: `${unique('seed-a')}@example.com`, name: seedNameA })
        .returning();
      seedUserIds.push(seedUserA.id);
      await db.insert(organizationMembersTable).values({ organizationId: orgAId, userId: seedUserA.id, role: 'agent' });

      const [seedUserB] = await db
        .insert(usersTable)
        .values({ clerkId: unique('seed-b'), email: `${unique('seed-b')}@example.com`, name: seedNameB })
        .returning();
      seedUserIds.push(seedUserB.id);
      await db.insert(organizationMembersTable).values({ organizationId: orgBId, userId: seedUserB.id, role: 'agent' });

      // 4. Org A (Owner) is active by default. Owner-only UI and Org A's
      // member data must be visible; Org B's must not appear at all.
      await page.goto('/team-roles');
      await expect(page.getByTestId('button-invite-member')).toBeVisible();
      await expect(page.getByText(seedNameA)).toBeVisible();
      await expect(page.getByText(seedNameB)).toHaveCount(0);

      // 5. Switch to Org B (Manager) via the real workspace switcher.
      await page.getByTestId('button-workspace-switcher').click();
      await page.getByTestId(`option-workspace-${orgBId}`).click();
      await page.waitForURL('**/overview');

      // 6. THE BUG THIS TEST GUARDS AGAINST: a stale, more-privileged role
      // (Owner) or Org A's member rows surviving the switch.
      await page.goto('/team-roles');
      await expect(page.getByTestId('button-invite-member')).toHaveCount(0);
      await expect(page.locator('[data-testid^="select-role-"]')).toHaveCount(0);
      await expect(page.getByText(seedNameB)).toBeVisible();
      await expect(page.getByText(seedNameA)).toHaveCount(0);

      // 7. Switch back to Org A -- Owner permissions and Org A's data must
      // be fully restored, with zero residue from Org B.
      await page.getByTestId('button-workspace-switcher').click();
      await page.getByTestId(`option-workspace-${orgAId}`).click();
      await page.waitForURL('**/overview');

      await page.goto('/team-roles');
      await expect(page.getByTestId('button-invite-member')).toBeVisible();
      await expect(page.getByText(seedNameA)).toBeVisible();
      await expect(page.getByText(seedNameB)).toHaveCount(0);
    } finally {
      // Cleanup: remove everything this test created so re-runs stay
      // collision-free and the dev database doesn't accumulate test data.
      if (orgAId !== undefined) {
        await db.delete(organizationMembersTable).where(eq(organizationMembersTable.organizationId, orgAId)).catch(() => {});
        await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId)).catch(() => {});
      }
      if (orgBId !== undefined) {
        await db.delete(organizationMembersTable).where(eq(organizationMembersTable.organizationId, orgBId)).catch(() => {});
        await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId)).catch(() => {});
      }
      for (const id of seedUserIds) {
        await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
      }
      await deleteAuthUsers([email]);
    }
  });
});
