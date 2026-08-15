// Сброс time_window: после исчерпания лимита в окне «minute» счётчик откатывается по истечении окна,
// следующий платёж снова проходит. Ни один Day-кейс этого не проверяет (окно не роллится в прогоне).
// count_basis=success + фикс. ожидание 70с — надёжно и для rolling-60s, и для calendar-minute.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const PAYIN = ENTITIES.merchants.PAYIN; // coreId 145
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };
const kind = (r) => r.body?.errors?.[0]?.kind;

let browser, page, api;
test.beforeAll(async () => {
  test.setTimeout(120000);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page); await selectTenantPrimary(page);
  api = await newPayApi(PAYIN);
});
test.afterEach(async () => {
  const l = ledgerRead();
  if (l.length) { await deleteLimits(page, l).catch(() => {}); ledgerClear(); }
});
test.afterAll(async () => {
  await cleanupByTitlePrefix(page, 'REG ').catch(() => {});
  await api?.dispose(); await browser?.close();
});

// ── TW-RESET: count cap=2 / window=minute → исчерпать, дождаться отката окна, снова проходит ──
test('TW-RESET: minute-окно откатывается → после ожидания платёж снова проходит', async () => {
  test.setTimeout(200000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Minute', value: 2, currency: 'RUB', countBasis: 'Success', onBreach: 'Decline', ...SCHED, title: `REG TW-RESET ${Date.now()}` });

  // Фаза 1: исчерпать окно
  const before = [];
  let r = await sendPayment(api, { amountRub: 100 }); before.push(r.status); await sleep(2500); // success #1
  r = await sendPayment(api, { amountRub: 100 }); before.push(r.status); await sleep(2500);       // success #2 → counter=2
  r = await sendPayment(api, { amountRub: 100 }); before.push(r.status);                            // #3 → 422 (окно активно)
  console.log('[TW-RESET] before-wait', JSON.stringify(before), 'kind3', kind(r));
  expect(before[0], 'success #1').toBe(200);
  expect(before[1], 'success #2').toBe(200);
  expect(before[2], '#3 режется — окно активно').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');

  // Фаза 2: ждём отката minute-окна (успехи #1/#2 стареют из окна)
  console.log('[TW-RESET] ждём 70с отката окна…');
  await sleep(70000);

  // Фаза 3: после отката платёж снова проходит
  r = await sendPayment(api, { amountRub: 100 });
  console.log('[TW-RESET] after-wait HTTP', r.status, kind(r) || '');
  expect(r.status, 'после отката minute-окна платёж снова проходит').toBe(200);
});
