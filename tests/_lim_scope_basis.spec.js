// Дострой скоуп-матрицы (Shop) + count_basis (success/declines). Все кейсы НЕ блокированы LIM-1.
// Топология: мерч PAYIN coreId 145; шопы PAYIN_A coreId 146 (свои creds), PAYIN_B coreId 147 (свои creds).
// count_basis-семантика подтверждена пробником (_lim_cb_probe): fail-карта=200 init, счётчик по финальному статусу.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const PAYIN = ENTITIES.merchants.PAYIN;   // coreId 145
const SHOP_A = ENTITIES.shops.PAYIN_A;    // coreId 146
const SHOP_B = ENTITIES.shops.PAYIN_B;    // coreId 147
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };
const kind = (r) => r.body?.errors?.[0]?.kind;

let browser, page, mApi, aApi, bApi;
test.beforeAll(async () => {
  test.setTimeout(120000);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page); await selectTenantPrimary(page);
  mApi = await newPayApi(PAYIN);
  aApi = await newPayApi(SHOP_A);
  bApi = await newPayApi(SHOP_B);
});
test.afterEach(async () => {
  const l = ledgerRead();
  if (l.length) { await deleteLimits(page, l).catch(() => {}); ledgerClear(); }
});
test.afterAll(async () => {
  await cleanupByTitlePrefix(page, 'REG ').catch(() => {});
  await mApi?.dispose(); await aApi?.dispose(); await bApi?.dispose(); await browser?.close();
});

// ── SC-1: Shop-scope amount value=1 на шопе A (146) → payin кредами шопа A режется ──
test('SC-1: shop-scope amount value=1 → payin шопа A 422 (Shop scope энфорсит)', async () => {
  test.setTimeout(120000);
  let r = await sendPayment(aApi, { amountRub: 1000 });
  expect(r.status, 'clean-state shop A').toBe(200);
  await createLimit(page, { scopeLevel: 'Shop', scope: SHOP_A.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG SC-1 ${Date.now()}` });
  r = await sendPayment(aApi, { amountRub: 1000 });
  expect(r.status, 'shop-scope лимит режет свой шоп').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── SC-2: тот же лимит на шопе A НЕ трогает шоп B (147) → изоляция соседних шопов ──
test('SC-2: shop A лимит → payin шопа B проходит 200 (изоляция шопов)', async () => {
  test.setTimeout(120000);
  let r = await sendPayment(bApi, { amountRub: 1000 });
  expect(r.status, 'clean-state shop B').toBe(200);
  await createLimit(page, { scopeLevel: 'Shop', scope: SHOP_A.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG SC-2 ${Date.now()}` });
  r = await sendPayment(bApi, { amountRub: 1000 });
  expect(r.status, 'соседний шоп B игнорит лимит шопа A').toBe(200);
});

// ── CB-1: count_basis=Success cap=2 (no by) → отказ НЕ съедает бюджет ──
test('CB-1: count_basis=success cap=2 → declines не считаются', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Day', value: 2, currency: 'RUB', countBasis: 'Success', onBreach: 'Decline', ...SCHED, title: `REG CB-1 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(mApi, { amountRub: 100, fail: true }); seq.push(r.status); await sleep(2000);   // decline — не считается
  for (let i = 0; i < 3; i++) { r = await sendPayment(mApi, { amountRub: 100 }); seq.push(r.status); await sleep(2000); }
  console.log('[CB-1] seq', JSON.stringify(seq), 'kind3', kind(r));
  expect(seq[1], 'S1 проходит').toBe(200);
  expect(seq[2], 'S2 проходит — значит fail НЕ был засчитан в success-бюджет').toBe(200);
  expect(seq[3], '3-й success режется').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── CB-2: count_basis=Declines cap=2 (no by) → успехи НЕ считаются, только отказы ──
test('CB-2: count_basis=declines cap=2 → successes не считаются', async () => {
  test.setTimeout(160000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Day', value: 2, currency: 'RUB', countBasis: 'Declines', onBreach: 'Decline', ...SCHED, title: `REG CB-2 ${Date.now()}` });
  const seq = [];
  for (let i = 0; i < 2; i++) { const r = await sendPayment(mApi, { amountRub: 100 }); seq.push(r.status); await sleep(2000); }   // успехи — не считаются
  let r;
  for (let i = 0; i < 3; i++) { r = await sendPayment(mApi, { amountRub: 100, fail: true }); seq.push(r.status); await sleep(2000); }
  console.log('[CB-2] seq', JSON.stringify(seq), 'kind_last', kind(r));
  expect(seq[0], 'S1 проходит').toBe(200);
  expect(seq[1], 'S2 проходит').toBe(200);
  expect(seq[2], 'F1 проходит (decline #1, счётчик=1)').toBe(200);
  expect(seq[3], 'F2 проходит (decline #2, счётчик=2) — значит 2 успеха НЕ засчитались').toBe(200);
  expect(seq[4], 'F3 (decline #3) режется').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});
