// Добивка пробелов плана: boundary-точность суммы (1.3/1.4 — граница включительна) и
// open-ended расписание effective_to=NULL (5.4 — активен бессрочно). Оба доступны через UI
// (лимит армится мгновенно, sync-лаг из плана к UI-конфигу не относится).
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

// ── BND-1 (план 1.3+1.4): граница суммы включительна — расход РОВНО=лимит проходит, +1 режет ──
test('BND-1: amount cap=10000 — расход ровно=лимит 200, следующий (+1) 422', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 10000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG BND-1 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(api, { amountRub: 9900 }); seq.push(r.status); await sleep(2000); // cum=9900 < 10000
  r = await sendPayment(api, { amountRub: 100 });  seq.push(r.status); await sleep(2000);       // cum=10000 РОВНО = лимит
  r = await sendPayment(api, { amountRub: 1 });    seq.push(r.status);                            // cum=10001 > лимит
  console.log('[BND-1] seq', JSON.stringify(seq), 'kind3', kind(r));
  expect(seq[0], '9900 (< лимита) проходит').toBe(200);
  expect(seq[1], 'ровно=лимит (10000) проходит — граница включительна (≤)').toBe(200);
  expect(seq[2], '+1 сверх лимита (10001) режется').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── SCH-1 (план 5.4): open-ended лимит (effective_from прошлое, effective_to пусто) активен бессрочно ──
test('SCH-1: effective_to=NULL → лимит активен бессрочно и режет (422)', async () => {
  test.setTimeout(120000);
  // effectiveTo НЕ передаём → поле пустое; from в прошлом
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', effectiveFrom: '2026-08-01', title: `REG SCH-1 ${Date.now()}` });
  const r = await sendPayment(api, { amountRub: 100 });
  console.log('[SCH-1] open-ended payin', r.status, kind(r) || '');
  expect(r.status, 'бессрочный лимит (to=NULL) активен и режет').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});
