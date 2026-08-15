// TC-15: currency as a limit-matching dimension. A limit in the payment's currency applies; a limit in a different
// currency does NOT apply to the payment (no cross-currency application / auto-conversion).
// Verified on tenant tenantB (USD): a USD limit rejects a USD payment; a RUB limit ignores it.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenant } from '../lib/auth.js';
import { createLimit, deleteLimits, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { TENANTS } from '../lib/config.js';

const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };
const kind = (r) => r.body?.errors?.[0]?.kind;
const TENANT_B = TENANTS.tenantB; // credentials from env (LIMITS_TENANT_B_*)

let browser, page, api;
test.beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page);
  api = await newPayApi({ baseURL: TENANT_B.base, bearer: TENANT_B.bearer, apiSecret: TENANT_B.apiSecret });
});
test.afterEach(async () => { const l = ledgerRead(); if (l.length) { await deleteLimits(page, l).catch(() => {}); ledgerClear(); } });
test.afterAll(async () => { await api?.dispose(); await browser?.close(); });

// ── TC-15a: USD limit on tenantB → USD payment rejected (currency matches) ──
test('TC-15a: USD limit value=1 → USD payin 422 (currency matches)', async () => {
  test.setTimeout(120000);
  await selectTenant(page, TENANT_B.name);
  let r = await sendPayment(api, { amountRub: 10, currency: 'USD' });
  expect(r.status, 'clean-state tenantB USD').toBe(200);
  await createLimit(page, { scopeLevel: 'Shop', scope: TENANT_B.shopCore, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'USD', onBreach: 'Decline', ...SCHED, title: `REG TC-15a ${Date.now()}` });
  r = await sendPayment(api, { amountRub: 10, currency: 'USD' });
  console.log('[TC-15a] USD-limit vs USD-pay', r.status, kind(r) || '');
  expect(r.status, 'USD limit rejects USD payment').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear();
});

// ── TC-15b: RUB limit on tenantB → USD payment passes (currency differs → limit does not apply) ──
test('TC-15b: RUB limit value=1 → USD payin 200 (currency differs, limit does not match)', async () => {
  test.setTimeout(120000);
  await selectTenant(page, TENANT_B.name);
  await createLimit(page, { scopeLevel: 'Shop', scope: TENANT_B.shopCore, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-15b ${Date.now()}` });
  const r = await sendPayment(api, { amountRub: 10, currency: 'USD' });
  console.log('[TC-15b] RUB-limit vs USD-pay', r.status, kind(r) || '');
  expect(r.status, 'RUB limit does NOT apply to a USD payment (currency is a matching dimension)').toBe(200);
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear();
});
