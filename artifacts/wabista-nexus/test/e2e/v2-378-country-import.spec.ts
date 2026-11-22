import { test, expect, type Page } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import {
  db,
  campaignContactsTable,
  contactImportOccurrencesTable,
  contactImportSessionsTable,
} from '@workspace/db';

import {
  createAccount,
  deleteAuthUsers,
  signInViaApi,
  unique,
  waitForSignInWindow,
} from './auth-helpers';

test('V2-378: actual Audience UI sends correct country fallback headers', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);

  const email = `${unique('v2-378-country')}@example.com`;
  let accountCreated = false;

  try {
    await createAccount('V2-378 Country Tester', email);
    accountCreated = true;

    await waitForSignInWindow(page);
    await signInViaApi(page, baseURL!, email);

    await page.goto('/overview');
    await page.goto('/campaigns');

    await expect(page.getByTestId('button-new-campaign')).toBeVisible();
    await page.getByTestId('button-new-campaign').click();
    await page.waitForURL(/\/campaigns\/\d+\/audience$/);
    const campaignId = Number(
      new URL(page.url()).pathname.match(/\/campaigns\/(\d+)\/audience$/)?.[1]
    );
    expect(Number.isSafeInteger(campaignId) && campaignId > 0).toBe(true);


    async function uploadCase(
      name: string,
      rows: string[],
      choice: string | null,
      expectedCode: string | undefined,
    ) {
      await page.getByTestId('input-audience-csv').setInputFiles({
        name: `${name}.csv`,
        mimeType: 'text/csv',
        buffer: Buffer.from(`phone\n${rows.join('\n')}\n`),
      });

      const preset = page.getByTestId('select-audience-country-preset');
      await expect(preset).toBeVisible();
      await expect(preset).toHaveValue('auto');

      if (choice) {
        await preset.selectOption(choice);
        await expect(preset).toHaveValue(choice);

        if (choice === 'custom') {
          await page.getByTestId('input-audience-country-code').fill('254');
        }
      }

      await expect(
        page.getByTestId('button-start-audience-upload'),
      ).toBeEnabled();

      const requestPromise = page.waitForRequest((request) => {
        const path = new URL(request.url()).pathname;
        return request.method() === 'POST' &&
          /\/imports$/.test(path);
      });

      await page.getByTestId('button-start-audience-upload').click();

      const request = await requestPromise;
      expect(request.headers()['x-default-country-code']).toBe(expectedCode);
      expect(request.headers()['x-import-operation']).toBe('append');

      await expect(
        page.getByTestId('alert-upload-done'),
      ).toBeVisible({ timeout: 30_000 });


      // V2_378_PERSISTED_PHONE_ASSERTIONS
      const expected: Record<string, {
        valid: number;
        duplicate: number;
        canonical: string[];
        repeated: string[];
      }> = {
        'auto-international': {
          valid: 2, duplicate: 0,
          canonical: ['+919876543210', '+5511987654321'],
          repeated: [],
        },
        'india-fallback': {
          valid: 0, duplicate: 2,
          canonical: [],
          repeated: ['+919876543210', '+5511987654321'],
        },
        'brazil-fallback': {
          valid: 0, duplicate: 1,
          canonical: [],
          repeated: ['+5511987654321'],
        },
        'custom-fallback': {
          valid: 1, duplicate: 0,
          canonical: ['+14155550123'],
          repeated: [],
        },
      };

      const wanted = expected[name];
      expect(wanted).toBeDefined();

      const [saved] = await db.select()
        .from(contactImportSessionsTable)
        .where(and(
          eq(contactImportSessionsTable.campaignId, campaignId),
          eq(contactImportSessionsTable.fileName, `${name}.csv`),
        ));

      expect(saved?.status).toBe('Completed');
      expect(saved?.defaultCountryCode ?? undefined).toBe(expectedCode);
      expect(saved?.validRows).toBe(wanted.valid);
      expect(saved?.duplicateRows).toBe(wanted.duplicate);
      expect(saved?.invalidRows).toBe(0);
      expect(saved?.suppressedRows).toBe(0);

      const canonical = await db.select({
        phone: campaignContactsTable.normalizedPhone,
        status: campaignContactsTable.status,
      }).from(campaignContactsTable)
        .where(eq(campaignContactsTable.importSessionId, saved!.id));

      expect(
        canonical.map((row) => row.phone).sort()
      ).toEqual([...wanted.canonical].sort());

      expect(canonical.every((row) => row.status === 'Valid')).toBe(true);

      const repeated = await db.select({
        phone: contactImportOccurrencesTable.normalizedPhone,
        classification: contactImportOccurrencesTable.classification,
      }).from(contactImportOccurrencesTable)
        .where(eq(contactImportOccurrencesTable.importSessionId, saved!.id));

      expect(
        repeated.map((row) => row.phone).sort()
      ).toEqual([...wanted.repeated].sort());

      expect(
        repeated.every((row) => row.classification === 'duplicate_of_existing')
      ).toBe(true);

      await page.getByTestId('button-clear-audience-file').click();
    }

    // International numbers: no fallback header.
    await uploadCase(
      'auto-international',
      ['+919876543210', '+5511987654321'],
      null,
      undefined,
    );

    // National Indian number plus already-prefixed Brazil number.
    await uploadCase(
      'india-fallback',
      ['9876543210', '+5511987654321'],
      '91',
      '91',
    );

    // National Brazilian number.
    await uploadCase(
      'brazil-fallback',
      ['11987654321'],
      '55',
      '55',
    );

    // Custom code: test request header without guessing a national number.
    await uploadCase(
      'custom-fallback',
      ['+14155550123'],
      'custom',
      '254',
    );
  } finally {
    if (accountCreated) await deleteAuthUsers([email]);
  }
});
