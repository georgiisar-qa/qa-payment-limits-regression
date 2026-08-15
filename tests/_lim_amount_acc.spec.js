// Накопление amount-лимита: лимит СУММИРУЕТ транзакции и режет на пересечении порога
// (текущие amount-кейсы только value=1/0 — тривиальны; здесь value=N и переход через границу).
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

// ── AM-ACC1: amount/day value=10000 → 6000(pass)+5000(cum=11000>10000 → режет) ──
// Проверяет что лимит СУММИРУЕТ, а не смотрит на разовую сумму.
test('AM-ACC1: amount cap=10000 суммирует → перелив на 2-й режется', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 10000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG AM-ACC1 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(api, { amountRub: 6000 }); seq.push(r.status); await sleep(2000); // cum=6000 ≤ 10000 → pass
  r = await sendPayment(api, { amountRub: 5000 }); seq.push(r.status);                          // cum=11000 > 10000 → режет
  console.log('[AM-ACC1] seq', JSON.stringify(seq), 'kind2', kind(r));
  expect(seq[0], '1-й (6000, cum≤cap) проходит').toBe(200);
  expect(seq[1], '2-й (cum 11000 > 10000) режется').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── AM-ACC2: под-пороговая транзакция после почти-исчерпания тоже режется, если переливает ──
// cap=10000: 9000(pass, cum=9000) → 2000(cum=11000 → режет), хотя разовые 2000 << cap.
test('AM-ACC2: маленькая транзакция режется если переливает накопленный порог', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 10000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG AM-ACC2 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(api, { amountRub: 9000 }); seq.push(r.status); await sleep(2000); // cum=9000
  r = await sendPayment(api, { amountRub: 2000 }); seq.push(r.status);                          // cum=11000 → режет
  console.log('[AM-ACC2] seq', JSON.stringify(seq), 'kind2', kind(r));
  expect(seq[0], '9000 проходит (cum=9000 ≤ 10000)').toBe(200);
  expect(seq[1], '2000 режется — переливает накопленный порог (разовая сумма мала)').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});
