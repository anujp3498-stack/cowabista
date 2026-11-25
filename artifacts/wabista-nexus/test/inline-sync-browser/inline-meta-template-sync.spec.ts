import { test, expect, type Page } from '@playwright/test'

const ORG_ID = 383003
const SYNC_URL = `/api/organizations/${ORG_ID}/whatsapp/templates/sync`

async function openHarness(page: Page, role: 'owner' | 'admin' | 'manager' = 'owner') {
  await page.route('**/api/organizations', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: ORG_ID, name: 'Mock Test Workspace', role, isActive: true,
    }]) })
  })
  await page.goto('/test/inline-sync-browser/harness.html')
  await expect(page.getByTestId('inline-meta-template-sync').first()).toBeVisible()
}

function result(status: 'synced' | 'failed' | 'superseded', templatesSeen = 0) {
  return {
    wabaId: 101, wabaExternalId: 'mock-waba-101', wabaDisplayName: 'Mock WABA',
    source: 'workspace_credential', status, templatesSeen,
    templatesUpserted: templatesSeen, templatesMarkedRemoved: 0,
    ...(status === 'failed' ? { error: { code: 'provider_rejected', message: 'Permission denied (mock)' } } : {}),
  }
}

const syncResult = (wabas: ReturnType<typeof result>[]) => ({ syncedAt: '2026-11-25T00:00:00Z', wabas })

test('owner syncs mock Meta templates and campaign refresh callback runs', async ({ page }) => {
  let calls = 0
  await page.route(`**${SYNC_URL}`, async route => {
    calls++
    expect(route.request().method()).toBe('POST')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(syncResult([result('synced', 7)])) })
  })
  await openHarness(page)
  const sync = page.getByTestId('button-inline-sync-templates').first()
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect(page.getByTestId('inline-template-sync-result').first()).toContainText('Meta templates refreshed')
  await expect(page.getByTestId('inline-template-sync-result').first()).toContainText('7 template(s)')
  await expect(page.getByTestId('campaign-refresh-count')).toHaveText('1')
  expect(calls).toBe(1)
})

test('partial failure is visible and is never called full success', async ({ page }) => {
  await page.route(`**${SYNC_URL}`, async route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(syncResult([result('synced', 3), { ...result('failed'), wabaId: 102, wabaDisplayName: 'Second WABA' }])),
  }))
  await openHarness(page)
  await page.getByTestId('button-inline-sync-templates').first().click()
  const banner = page.getByTestId('inline-template-sync-result').first()
  await expect(banner).toContainText('Templates partially synced')
  await expect(banner).toContainText('Second WABA: Permission denied (mock)')
  await expect(page.getByTestId('campaign-refresh-count')).toHaveText('1')
})

test('network error is explained and button allows retry', async ({ page }) => {
  let attempts = 0
  await page.route(`**${SYNC_URL}`, async route => {
    attempts++
    if (attempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Mock provider unavailable"}' })
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(syncResult([result('synced', 2)])) })
  })
  await openHarness(page)
  const sync = page.getByTestId('button-inline-sync-templates').first()
  await sync.click()
  await expect(page.getByTestId('inline-template-sync-error').first()).toContainText('Template sync or refresh was not completed')
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect(page.getByTestId('inline-template-sync-result').first()).toContainText('Meta templates refreshed')
  await expect(page.getByTestId('inline-template-sync-error').first()).toHaveCount(0)
  expect(attempts).toBe(2)
})

test('manager and explicitly disabled controls cannot trigger a sync', async ({ page }) => {
  let calls = 0
  await page.route(`**${SYNC_URL}`, async route => { calls++; await route.fulfill({ status: 500 }) })
  await openHarness(page, 'manager')
  await expect(page.getByTestId('button-inline-sync-templates').first()).toBeDisabled()
  await expect(page.getByTestId('inline-meta-template-sync').first()).toContainText('Only the workspace owner or an admin')
  expect(calls).toBe(0)
})

test('explicitly disabled control stays disabled even for owner', async ({ page }) => {
  await openHarness(page, 'owner')
  await expect(page.getByTestId('explicitly-disabled-control').getByTestId('button-inline-sync-templates')).toBeDisabled()
})
