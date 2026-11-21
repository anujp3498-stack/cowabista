import { test, expect, type Page } from '@playwright/test';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  campaignAuditTable,
  campaignJobsTable,
  campaignsTable,
  organizationMembersTable,
  phoneNumbersTable,
  providerConnectionsTable,
  templatesTable,
  wabasTable,
} from '@workspace/db';
import { createAccount, deleteAuthUsers, localUserFor, signInViaApi, unique, waitForSignInWindow } from './auth-helpers';

// Campaign modules, end to end in the browser: a Normal campaign and a
// Rocket campaign are each created directly from their own list, get their
// own CSV audience, numbers, templates and variables, are reviewed and
// launched, and are monitored on their own pages. The workspace is a MOCK
// workspace (provider connection mode "mock"): every send goes to the
// in-process mock provider. No Meta credential exists and nothing leaves
// the machine.

type World = { orgId: number; phones: Array<typeof phoneNumbersTable.$inferSelect>; templates: Array<typeof templatesTable.$inferSelect> };

async function seedMockWorkspace(orgId: number, slug: string): Promise<World> {
  await db.insert(providerConnectionsTable).values({ organizationId: orgId, provider: 'whatsapp-business', mode: 'mock', status: 'configured' }).onConflictDoNothing();
  const [waba] = await db.insert(wabasTable).values({ organizationId: orgId, externalId: `waba-${slug}`, displayName: 'Mock account' }).returning();
  const phones = [];
  for (const [index, key] of ['X', 'Y'].entries()) {
    const [phone] = await db.insert(phoneNumbersTable).values({
      organizationId: orgId, wabaId: waba!.id, providerPhoneId: `pp-${slug}-${key}`,
      phone: `+1777${String(orgId).padStart(5, '0')}${String(index + 1).padStart(2, '0')}`,
      displayName: `Mock sender ${key}`, status: 'Connected', setupState: 'active', tpsLimit: 20,
    }).returning();
    phones.push(phone!);
  }
  const templates = [];
  for (const key of ['A', 'B']) {
    const body = `${key === 'A' ? 'Alpha' : 'Bravo'} hello {{1}}`;
    const [template] = await db.insert(templatesTable).values({
      organizationId: orgId, wabaId: waba!.id, providerTemplateId: `tpl-${slug}-${key}`,
      name: `e2e_${slug.replace(/[^a-z0-9]/g, '_')}_${key.toLowerCase()}`.slice(0, 60), status: 'Approved', language: 'en_US', category: 'Marketing',
      body, components: [{ type: 'BODY', text: body }],
    }).returning();
    templates.push(template!);
  }
  return { orgId, phones, templates };
}

function audienceCsv(rows: number, seed: number): string {
  const lines = ['phone,first_name'];
  for (let index = 0; index < rows; index++) lines.push(`+449${String(seed % 100_000).padStart(5, '0')}${String(index).padStart(4, '0')},Name${index}`);
  return `${lines.join('\n')}\n`;
}

async function uploadAudience(page: Page, csv: string) {
  await page.getByTestId('input-audience-csv').setInputFiles({ name: 'audience.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const phoneColumn = page.getByTestId('select-audience-phone-column');
  await expect(phoneColumn).toBeVisible();
  if (!(await phoneColumn.textContent())?.includes('phone')) {
    await phoneColumn.click();
    await page.getByRole('option', { name: 'phone', exact: true }).click();
  }
  await page.getByTestId('button-start-audience-upload').click();
  await expect(page.getByTestId('alert-upload-done')).toBeVisible({ timeout: 30_000 });
}

async function mapFirstName(page: Page, templateId: number) {
  await page.locator(`[data-testid^="column-${templateId}-"]`).first().click();
  await page.getByRole('option', { name: 'first_name' }).click();
}

const campaignIdFrom = (url: string) => Number(/\/(\d+)\//.exec(new URL(url).pathname + '/')![1]);

async function campaignRow(id: number) {
  const [row] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  return row!;
}

async function cancelIfActive(page: Page, orgId: number, campaignId: number | undefined) {
  if (campaignId === undefined) return;
  const row = await campaignRow(campaignId).catch(() => undefined);
  if (row && ['Running', 'Paused', 'Scheduled', 'Ready'].includes(row.status)) {
    await page.request.post(`/api/organizations/${orgId}/campaigns/${campaignId}/actions`, { data: { action: 'cancel' } }).catch(() => {});
  }
}

// The database pool is shared by every spec in the worker (workers: 1); it is
// not ended here, so a spec that runs after this one can still use it.
test.describe('campaign modules: Normal and Rocket are separate, end to end (mock workspace)', () => {

  test('Normal campaign: own list, CSV, one number + one template with a variable, speed preset, launch, monitor', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const email = `${unique('normal-module')}@example.com`;
    let world: World | undefined;
    let campaignId: number | undefined;
    try {
      const authUserId = await createAccount('Normal Tester', email);
      await waitForSignInWindow(page);
      await signInViaApi(page, baseURL!, email);
      await page.goto('/overview');
      const user = await localUserFor(page, authUserId);
      let membership: typeof organizationMembersTable.$inferSelect | undefined;
      for (let attempt = 0; attempt < 20 && !membership; attempt++) {
        [membership] = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, user.id));
        if (!membership) await page.waitForTimeout(500);
      }
      world = await seedMockWorkspace(membership!.organizationId, unique('n'));
      const [X, Y] = world.phones;
      const [A, B] = world.templates;

      // Separate list and navigation.
      await page.goto('/campaigns');
      await expect(page.getByRole('heading', { name: 'Normal Campaigns', exact: true })).toBeVisible();
      await expect(page.getByTestId('link-nav-rocket-campaigns').first()).toBeVisible();
      await page.getByTestId('button-new-campaign').click();
      await page.waitForURL(/\/campaigns\/\d+\/audience$/);
      campaignId = campaignIdFrom(page.url());
      expect((await campaignRow(campaignId)).campaignType).toBe('standard');
      await expect(page.getByTestId('step-delivery')).toHaveCount(0);
      await expect(page.getByTestId('campaign-steps').getByRole('link')).toHaveText(['Step 1: Audience', 'Step 2: Message', 'Step 3: Review & Launch']);

      await uploadAudience(page, audienceCsv(5, campaignId));
      await page.getByTestId('link-continue-to-message').click();
      await page.waitForURL(`**/campaigns/${campaignId}/message`);

      // One number: choosing another replaces the first.
      await page.getByTestId(`sender-${X!.id}`).getByRole('checkbox').click();
      await page.getByTestId(`sender-${Y!.id}`).getByRole('checkbox').click();
      await expect(page.getByTestId(`sender-${X!.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
      await page.getByTestId(`sender-${X!.id}`).getByRole('checkbox').click();
      await expect(page.getByTestId(`sender-${Y!.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
      await page.getByTestId(`template-${A!.id}`).getByRole('checkbox').click();
      await mapFirstName(page, A!.id);
      // One template: switching to another after filling a variable replaces it,
      // and the old template's values are not saved with the new one.
      await page.getByTestId(`template-${B!.id}`).getByRole('checkbox').click();
      await expect(page.getByTestId(`template-${A!.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
      await mapFirstName(page, B!.id);
      await page.getByTestId('button-save-continue-delivery').click();
      await page.waitForURL(`**/campaigns/${campaignId}/review`);

      // Speed preset on Review (no Delivery step), then launch.
      await expect(page.getByTestId('normal-speed-card')).toBeVisible();
      await page.getByTestId('normal-speed-conservative').click();
      await expect.poll(async () => (await campaignRow(campaignId!)).deliveryMode).toBe('conservative');
      await expect(page.getByTestId('text-launch-state')).toHaveText('Everything checks out.', { timeout: 20_000 });
      await page.getByTestId('button-launch').click();
      await page.getByTestId('button-confirm-launch').click();
      await page.waitForURL(new RegExp(`//[^/]+/campaigns/${campaignId}$`));
      await expect.poll(async () => (await campaignRow(campaignId!)).status, { timeout: 30_000 }).toMatch(/Running|Completed/);
      // The unchanged runtime sends through the mock provider: one number, one template.
      await expect.poll(async () => {
        const [row] = await db.select({ sent: sql<number>`count(*) filter (where ${campaignJobsTable.status} = 'Sent')::int` }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId!));
        return row!.sent;
      }, { timeout: 60_000 }).toBe(5);
      const jobs = await db.select().from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId));
      expect(new Set(jobs.map((job) => job.templateId))).toEqual(new Set([B!.id]));

      // Module separation: not in the Rocket list; a Rocket URL redirects home.
      await page.goto('/rocket-campaigns');
      await expect(page.getByRole('heading', { name: 'Rocket Campaigns', exact: true })).toBeVisible();
      await expect(page.getByTestId(`row-campaign-${campaignId}`)).toHaveCount(0);
      await page.goto(`/rocket-campaigns/${campaignId}`);
      await page.waitForURL(new RegExp(`//[^/]+/campaigns/${campaignId}$`));
      await page.goto('/campaigns');
      await expect(page.getByTestId(`row-campaign-${campaignId}`)).toBeVisible();
    } finally {
      if (world) await cancelIfActive(page, world.orgId, campaignId);
      await deleteAuthUsers([email]);
    }
  });

  test('Rocket campaign: created directly, CSV, several numbers + rotating templates, per-number TPS, launch, live speed change, pause/resume, advanced routes', async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const email = `${unique('rocket-module')}@example.com`;
    let world: World | undefined;
    let campaignId: number | undefined;
    try {
      const authUserId = await createAccount('Rocket Tester', email);
      await waitForSignInWindow(page);
      await signInViaApi(page, baseURL!, email);
      await page.goto('/overview');
      const user = await localUserFor(page, authUserId);
      let membership: typeof organizationMembersTable.$inferSelect | undefined;
      for (let attempt = 0; attempt < 20 && !membership; attempt++) {
        [membership] = await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.userId, user.id));
        if (!membership) await page.waitForTimeout(500);
      }
      world = await seedMockWorkspace(membership!.organizationId, unique('r'));
      const [X, Y] = world.phones;
      const [A, B] = world.templates;

      // Created directly from the Rocket list: no Normal campaign is chosen.
      await page.goto('/rocket-campaigns');
      await expect(page.getByRole('heading', { name: 'Rocket Campaigns', exact: true })).toBeVisible();
      await expect(page.getByTestId('rocket-advanced-settings')).toBeVisible();
      await expect(page.getByTestId('button-add-route')).toHaveCount(0); // route tools are hidden until Advanced is opened
      await page.getByTestId('button-new-campaign').click();
      await page.waitForURL(/\/rocket-campaigns\/\d+\/audience$/);
      campaignId = campaignIdFrom(page.url());
      expect((await campaignRow(campaignId)).campaignType).toBe('rocket');
      await expect(page.getByTestId('campaign-steps').getByRole('link')).toHaveText(['Step 1: Audience', 'Step 2: Message', 'Step 3: Delivery', 'Step 4: Review & Launch']);

      await uploadAudience(page, audienceCsv(60, campaignId));
      await page.getByTestId('link-continue-to-message').click();
      await page.waitForURL(`**/rocket-campaigns/${campaignId}/message`);

      // Several numbers and templates stay selected together.
      for (const phone of [X!, Y!]) await page.getByTestId(`sender-${phone.id}`).getByRole('checkbox').click();
      for (const template of [A!, B!]) await page.getByTestId(`template-${template.id}`).getByRole('checkbox').click();
      for (const phone of [X!, Y!]) await expect(page.getByTestId(`sender-${phone.id}`).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
      await mapFirstName(page, A!.id);
      await mapFirstName(page, B!.id);
      await page.getByTestId('button-save-continue-delivery').click();
      await page.waitForURL(`**/rocket-campaigns/${campaignId}/delivery`);

      // Per-number TPS: Advanced is preselected with each number's maximum.
      await expect(page.getByTestId('choice-advanced').getByRole('radio')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId(`input-rate-${X!.id}`)).toHaveValue('20');
      await page.getByTestId(`input-rate-${X!.id}`).fill('1');
      await page.getByTestId(`input-rate-${Y!.id}`).fill('1');
      await page.getByTestId('advanced-settings-toggle').click();
      await expect(page.getByTestId('route-lanes').getByRole('row')).toHaveCount(3); // header + one lane per number
      await page.getByTestId('button-save-continue-review').click();
      await page.waitForURL(`**/rocket-campaigns/${campaignId}/review`);
      await expect(page.getByTestId('normal-speed-card')).toHaveCount(0);
      await expect(page.getByTestId('text-launch-state')).toHaveText('Everything checks out.', { timeout: 20_000 });
      await page.getByTestId('button-launch').click();
      await page.getByTestId('button-confirm-launch').click();
      await page.waitForURL(new RegExp(`/rocket-campaigns/${campaignId}$`));
      await expect.poll(async () => (await campaignRow(campaignId!)).status, { timeout: 30_000 }).toBe('Running');

      // Live speed change while running: pause -> adjust -> resume, per number.
      await page.getByTestId('button-change-speed').click();
      await expect(page.getByTestId('live-speed-advanced').getByRole('radio')).toHaveAttribute('aria-checked', 'true');
      await page.getByTestId(`live-rate-${X!.id}`).fill('2');
      await page.getByTestId(`live-rate-${Y!.id}`).fill('3');
      await page.getByTestId('button-apply-speed').click();
      await expect(page.getByTestId('dialog-change-speed')).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(async () => (await campaignRow(campaignId!)).deliverySettings?.perNumberRates?.map((rate) => rate.messagesPerSecond).sort()).toEqual([2, 3]);
      await expect.poll(async () => (await campaignRow(campaignId!)).status).toBe('Running');
      const audit = await db.select().from(campaignAuditTable).where(and(eq(campaignAuditTable.campaignId, campaignId), eq(campaignAuditTable.action, 'adjust-speed')));
      expect(audit.length).toBe(1);

      // Pause and resume from the campaign page.
      await page.getByTestId('button-pause-campaign').click();
      await expect.poll(async () => (await campaignRow(campaignId!)).status).toBe('Paused');
      await page.getByTestId('button-resume-campaign').click();
      await expect.poll(async () => (await campaignRow(campaignId!)).status).toBe('Running');

      // Both numbers and both templates are used (automatic distribution + rotation).
      await expect.poll(async () => {
        const jobs = await db.select({ routeId: campaignJobsTable.routeId, templateId: campaignJobsTable.templateId }).from(campaignJobsTable).where(eq(campaignJobsTable.campaignId, campaignId!));
        return [new Set(jobs.map((job) => job.routeId)).size, new Set(jobs.map((job) => job.templateId)).size];
      }).toEqual([2, 2]);

      // Technical routes are read-only under Advanced settings on the campaign page.
      await page.getByTestId('tab-campaign-setup').click();
      await page.getByTestId('advanced-settings-toggle').click();
      await expect(page.getByTestId('route-lanes').getByRole('row')).toHaveCount(3);

      // Module separation: listed under Rocket only.
      await page.goto('/campaigns');
      await expect(page.getByTestId(`row-campaign-${campaignId}`)).toHaveCount(0);
      await page.goto(`/campaigns/${campaignId}/message`);
      await page.waitForURL(`**/rocket-campaigns/${campaignId}/message`);
      await page.goto('/rocket-campaigns');
      await expect(page.getByTestId(`row-campaign-${campaignId}`)).toBeVisible();
    } finally {
      if (world) await cancelIfActive(page, world.orgId, campaignId);
      await deleteAuthUsers([email]);
    }
  });

  test("V2-376 Unicode header image upload persists in Normal and Rocket", async ({ page, baseURL }) => {
    test.setTimeout(240_000);

    const email = `${unique("unicode-media")}@example.com`;

    try {
      const authUserId = await createAccount("Unicode Media Tester", email);

      await waitForSignInWindow(page);
      await signInViaApi(page, baseURL!, email);
      await page.goto("/overview");

      const user = await localUserFor(page, authUserId);

      let membership: typeof organizationMembersTable.$inferSelect | undefined;

      for (let attempt = 0; attempt < 20 && !membership; attempt++) {
        [membership] = await db
          .select()
          .from(organizationMembersTable)
          .where(eq(organizationMembersTable.userId, user.id));

        if (!membership) await page.waitForTimeout(500);
      }

      expect(membership).toBeDefined();

      const world = await seedMockWorkspace(
        membership!.organizationId,
        unique("media")
      );

      for (const template of world.templates) {
        await db.update(templatesTable)
          .set({
            components: [
              { type: "HEADER", format: "IMAGE" },
              { type: "BODY", text: template.body }
            ]
          })
          .where(eq(templatesTable.id, template.id));
      }

      // Valid 1x1 PNG, not just a PNG signature.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQrTgBAAJDAW6ffMAdAAAAAElFTkSuQmCC",
        "base64"
      );

      for (const module of ["normal", "rocket"] as const) {
        const base = module === "normal"
          ? "/campaigns"
          : "/rocket-campaigns";

        const filename = module === "normal"
          ? "PG618 - Bônus Diário 🇧🇷.png"
          : "活动图片 🐉.png";

        await page.goto(base);
        await page.getByTestId("button-new-campaign").click();

        await page.waitForURL(
          new RegExp(`${base}/[0-9]+/audience$`)
        );

        const campaignId = campaignIdFrom(page.url());

        await uploadAudience(
          page,
          audienceCsv(2, campaignId)
        );

        await page.getByTestId(
          "link-continue-to-message"
        ).click();

        await page.waitForURL(
          `**${base}/${campaignId}/message`
        );

        const senders = module === "normal"
          ? world.phones.slice(0, 1)
          : world.phones;

        const templates = module === "normal"
          ? world.templates.slice(0, 1)
          : world.templates;

        for (const sender of senders) {
          await page.getByTestId(
            `sender-${sender.id}`
          ).getByRole("checkbox").click();
        }

        for (const template of templates) {
          await page.getByTestId(
            `template-${template.id}`
          ).getByRole("checkbox").click();

          await mapFirstName(page, template.id);
        }

        const uploadResponse = page.waitForResponse(
          response =>
            response.request().method() === "POST" &&
            response.url().endsWith(
              `/campaigns/${campaignId}/media`
            )
        );

        await page.getByTestId(
          "input-upload-media"
        ).setInputFiles({
          name: filename,
          mimeType: "image/png",
          buffer: png
        });

        const response = await uploadResponse;

        expect(response.status()).toBe(201);

        expect(
          response.request().headers()["x-file-name"]
        ).toBe(encodeURIComponent(filename));

        const saved = await response.json() as {
          id: number;
          fileName: string;
          byteLength: number;
        };

        expect(saved.fileName).toBe(filename);
        expect(saved.byteLength).toBe(png.length);

        // Check the actual stored bytes via the authenticated API.
        const download = await page.request.get(
          `/api/organizations/${world.orgId}/campaigns/${campaignId}/media/${saved.id}/content`
        );

        expect(download.status()).toBe(200);
        expect(download.headers()["content-type"]).toContain("image/png");
        expect(await download.body()).toEqual(png);

        await expect(
          page.getByTestId("media-library")
        ).toContainText(filename);

        await expect(
          page.getByTestId("media-upload-error")
        ).toHaveCount(0);

        const slots = page.getByTestId(
          "media-select-header:media"
        );

        await expect(slots).toHaveCount(
          templates.length
        );

        for (let index = 0; index < templates.length; index++) {
          await slots.nth(index).click();

          await page.getByRole("option", {
            name: filename
          }).click();
        }

        await expect(
          page.getByTestId("button-save-message-setup")
        ).toBeEnabled();

        await page.getByTestId(
          "button-save-message-setup"
        ).click();

        await expect(
          page.getByTestId("text-save-state")
        ).toContainText("All changes are saved.");

        await page.reload();

        await expect(
          page.getByTestId("media-library")
        ).toContainText(filename);

        const savedSlots = page.getByTestId(
          "media-select-header:media"
        );

        await expect(savedSlots).toHaveCount(
          templates.length
        );

        for (let index = 0; index < templates.length; index++) {
          await expect(
            savedSlots.nth(index)
          ).toContainText(filename);
        }

        console.log(
          `V2_376_${module.toUpperCase()}_MEDIA_BROWSER_PASS`
        );
      }
    } finally {
      await deleteAuthUsers([email]);
    }
  });

});
