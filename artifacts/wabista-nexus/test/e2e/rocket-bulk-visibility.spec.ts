import { test, expect } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import {
  db,
  campaignsTable,
  organizationMembersTable,
  phoneNumbersTable,
  providerConnectionsTable,
  templatesTable,
  wabasTable,
} from '@workspace/db';
import {
  createAccount,
  deleteAuthUsers,
  localUserFor,
  signInViaApi,
  unique,
  waitForSignInWindow,
} from './auth-helpers';

/**
 * V2-375B Gate 6B, dedicated browser acceptance test.
 * Uses a brand-new, locally seeded MOCK workspace and a disposable DB.
 * Does not call Meta, send a message, or launch a campaign.
 */
test('Rocket Select All, sender-scoped templates, campaign-name label, and archived-number template visibility', async ({ page, baseURL }) => {
  test.setTimeout(180_000);

  const email = `${unique('rocket-gate6b')}@example.com`;
  try {
    const authUserId = await createAccount('Gate 6B Tester', email);
    await waitForSignInWindow(page);
    await signInViaApi(page, baseURL!, email);
    await page.goto('/overview');
    const user = await localUserFor(page, authUserId);

    let membership: typeof organizationMembersTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 20 && !membership; attempt++) {
      [membership] = await db.select().from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, user.id));
      if (!membership) await page.waitForTimeout(500);
    }
    expect(membership, 'Test account must have a mock workspace').toBeDefined();
    const orgId = membership!.organizationId;
    const slug = unique('gate6b');

    await db.insert(providerConnectionsTable).values({
      organizationId: orgId,
      provider: 'whatsapp-business',
      mode: 'mock',
      status: 'configured',
    }).onConflictDoNothing();

    const [wabaA] = await db.insert(wabasTable).values({
      organizationId: orgId,
      externalId: `waba-a-${slug}`,
      displayName: 'Gate6B Account A',
    }).returning();
    const [wabaB] = await db.insert(wabasTable).values({
      organizationId: orgId,
      externalId: `waba-b-${slug}`,
      displayName: 'Gate6B Account B',
    }).returning();

    async function addPhone(wabaId: number, key: string) {
      const [phone] = await db.insert(phoneNumbersTable).values({
        organizationId: orgId,
        wabaId,
        providerPhoneId: `mock-${slug}-${key}`,
        phone: `+1777${String(orgId).padStart(5, '0')}${String(key.charCodeAt(0)).padStart(2, '0')}`,
        displayName: `Gate6B sender ${key}`,
        status: 'Connected',
        setupState: 'active',
        tpsLimit: 20,
      }).returning();
      return phone!;
    }
    async function addTemplate(wabaId: number, key: string) {
      const body = `Gate6B ${key} says hello {{1}}`;
      const [template] = await db.insert(templatesTable).values({
        organizationId: orgId,
        wabaId,
        providerTemplateId: `mock-template-${slug}-${key}`,
        name: `gate6b_${key.toLowerCase()}_${orgId}`,
        status: 'Approved',
        language: 'en_US',
        category: 'Marketing',
        body,
        components: [{ type: 'BODY', text: body }],
      }).returning();
      return template!;
    }

    const phoneA = await addPhone(wabaA!.id, 'A');
    const phoneASibling = await addPhone(wabaA!.id, 'C');
    const phoneB = await addPhone(wabaB!.id, 'B');
    const templateA1 = await addTemplate(wabaA!.id, 'A1');
    const templateA2 = await addTemplate(wabaA!.id, 'A2');
    const templateB = await addTemplate(wabaB!.id, 'B');

    // 1) New Rocket campaign: visible name label and writing-box border.
    await page.goto('/rocket-campaigns');
    await page.getByTestId('button-new-campaign').click();
    await page.waitForURL(/\/rocket-campaigns\/\d+\/audience$/);
    const campaignId = Number(new URL(page.url()).pathname.match(/\/(\d+)\/audience$/)![1]);
    const namePanel = page.getByTestId('campaign-name-panel');
    await expect(namePanel).toBeVisible();
    await expect(namePanel.getByText('Campaign Name')).toBeVisible();
    const nameInput = page.getByTestId('input-campaign-name');
    await expect(nameInput).toHaveClass(/border-2/);
    const newName = `Gate 6B UI ${slug}`;
    await nameInput.fill(newName);
    await expect.poll(async () => {
      const [row] = await db.select({ name: campaignsTable.name })
        .from(campaignsTable).where(eq(campaignsTable.id, campaignId));
      return row?.name;
    }, { timeout: 15_000 }).toBe(newName);

    // 2) Initial selection must NOT show WABA templates before choosing a sender.
    await page.goto(`/rocket-campaigns/${campaignId}/message`);
    await expect(page.getByTestId('select-all-senders')).toBeVisible();
    await expect(page.getByTestId('select-all-eligible-templates')).toBeVisible();
    await expect(page.getByTestId('templates-select-senders-first')).toBeVisible();
    await expect(page.getByTestId(`template-${templateA1.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`template-${templateB.id}`)).toHaveCount(0);

    // 3) One WABA A sender: only A's templates; select all selects both A templates.
    await page.getByTestId(`sender-${phoneA.id}`).getByRole('checkbox').click();
    await expect(page.getByTestId(`template-${templateA1.id}`)).toBeVisible();
    await expect(page.getByTestId(`template-${templateA2.id}`)).toBeVisible();
    await expect(page.getByTestId(`template-${templateB.id}`)).toHaveCount(0);
    await page.getByTestId('select-all-eligible-templates').click();
    await expect(page.getByTestId(`template-${templateA1.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId(`template-${templateA2.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

    // 4) Add B: union of eligible templates; select all now includes B's template.
    await page.getByTestId(`sender-${phoneB.id}`).getByRole('checkbox').click();
    await expect(page.getByTestId(`template-${templateB.id}`)).toBeVisible();
    await page.getByTestId('select-all-eligible-templates').click();
    await expect(page.getByTestId(`template-${templateB.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

    // 5) Deselect A: no A sender remains (C was never selected), so A templates
    //    vanish AND are removed from the selection. B remains selected.
    await page.getByTestId(`sender-${phoneA.id}`).getByRole('checkbox').click();
    await expect(page.getByTestId(`template-${templateA1.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`template-${templateA2.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`template-${templateB.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

    // 6) Select all numbers and clear them. No eligible templates when cleared.
    await page.getByTestId('select-all-senders').click();
    for (const phone of [phoneA, phoneASibling, phoneB]) {
      await expect(page.getByTestId(`sender-${phone.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    }
    await page.getByTestId('clear-templates').click();
    for (const tpl of [templateA1, templateA2, templateB]) {
      await expect(page.getByTestId(`template-${tpl.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
    }
    await page.getByTestId('clear-senders').click();
    await expect(page.getByTestId('templates-select-senders-first')).toBeVisible();
    await expect(page.getByTestId(`template-${templateB.id}`)).toHaveCount(0);

    // 7) Template Center must reflect deletion/archival of the LAST sender
    //    for a WABA, without deleting the stored template history.
    await page.goto('/templates');
    await expect(page.getByTestId(`row-template-${templateA1.id}`)).toBeVisible();
    await expect(page.getByTestId(`row-template-${templateB.id}`)).toBeVisible();

    async function archive(phoneId: number) {
      const response = await page.request.delete(`/api/phone-numbers/${phoneId}`);
      expect(response.status(), await response.text()).toBe(204);
    }

    await archive(phoneB.id); // B has no surviving sender; must vanish.
    await page.reload();
    await expect(page.getByTestId(`row-template-${templateB.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-template-${templateA1.id}`)).toBeVisible();

    await archive(phoneA.id); // A still has C: keep A's templates.
    await page.reload();
    await expect(page.getByTestId(`row-template-${templateA1.id}`)).toBeVisible();
    await expect(page.getByTestId(`row-template-${templateA2.id}`)).toBeVisible();

    await archive(phoneASibling.id); // A's last sender: templates vanish.
    await page.reload();
    await expect(page.getByTestId(`row-template-${templateA1.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-template-${templateA2.id}`)).toHaveCount(0);

    const preserved = await db.select({ id: templatesTable.id }).from(templatesTable)
      .where(and(eq(templatesTable.organizationId, orgId), eq(templatesTable.wabaId, wabaA!.id)));
    expect(preserved.map(row => row.id).sort()).toEqual([templateA1.id, templateA2.id].sort());
  } finally {
    await deleteAuthUsers([email]);
  }
});
