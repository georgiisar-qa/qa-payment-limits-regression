// TC-15: валюта как измерение матчинга лимита. Лимит в валюте платежа — применяется; лимит в другой
// валюте — НЕ применяется к платежу (нет кросс-валютного применения / автоконверсии).
// Проверяем на тенанте tenantB (USD): USD-лимит режет USD-платёж; RUB-лимит его игнорит.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenant } from '../lib/auth.js';
import { createLimit, deleteLimits, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { TENANTS } from '../lib/config.js';

const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };
const kind = (r) => r.body?.errors?.[0]?.kind;
const TENANT_B = TENANTS.tenantB; // креды из env (LIMITS_TENANT_B_*)

let browser, page, api;
test.beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page);
  api = await newPayApi({ baseURL: TENANT_B.base, bearer: TENANT_B.bearer, apiSecret: TENANT_B.apiSecret });
});
test.afterEach(async () => { const l = ledgerRead(); if (l.length) { await deleteLimits(page, l).catch(() => {}); ledgerClear(); } });
test.afterAll(async () => { await api?.dispose(); await browser?.close(); });

// ── TC-15a: USD-лимит на tenantB → USD-платёж режется (валюта совпадает) ──
test('TC-15a: USD-лимит value=1 → USD-payin 422 (валюта совпадает)', async () => {
  test.setTimeout(120000);
  await selectTenant(page, TENANT_B.name);
  let r = await sendPayment(api, { amountRub: 10, currency: 'USD' });
  expect(r.status, 'clean-state tenantB USD').toBe(200);
  await createLimit(page, { scopeLevel: 'Shop', scope: TENANT_B.shopCore, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'USD', onBreach: 'Decline', ...SCHED, title: `REG TC-15a ${Date.now()}` });
  r = await sendPayment(api, { amountRub: 10, currency: 'USD' });
  console.log('[TC-15a] USD-limit vs USD-pay', r.status, kind(r) || '');
  expect(r.status, 'USD-лимит режет USD-платёж').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear();
});

// ── TC-15b: RUB-лимит на tenantB → USD-платёж проходит (валюта не совпадает → лимит не применяется) ──
test('TC-15b: RUB-лимит value=1 → USD-payin 200 (валюта не совпадает, лимит не матчит)', async () => {
  test.setTimeout(120000);
  await selectTenant(page, TENANT_B.name);
  await createLimit(page, { scopeLevel: 'Shop', scope: TENANT_B.shopCore, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-15b ${Date.now()}` });
  const r = await sendPayment(api, { amountRub: 10, currency: 'USD' });
  console.log('[TC-15b] RUB-limit vs USD-pay', r.status, kind(r) || '');
  expect(r.status, 'RUB-лимит НЕ применяется к USD-платежу (валюта — измерение матчинга)').toBe(200);
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear();
});
