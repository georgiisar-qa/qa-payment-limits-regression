// TC-18: взаимодействие нескольких лимитов одновременно на одной сущности. Любое пробитие блокирует;
// более строгий лимит выигрывает, даже если у второго ещё есть запас.
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

// ── TC-18a: amount(loose 1M) + count/card_hash(strict cap=2) → строгий (count) режет 3-й, у amount ещё запас ──
test('TC-18a: два лимита — строгий count режет раньше, чем amount исчерпан', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1000000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-18a-amt ${Date.now()}` });
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', byField: 'Card hash', timeWindow: 'Hour', value: 2, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG TC-18a-cnt ${Date.now()}` });
  const seq = [];
  let r;
  for (let i = 0; i < 3; i++) { r = await sendPayment(api, { amountRub: 100 }); seq.push(r.status); await sleep(2000); }
  console.log('[TC-18a] seq', JSON.stringify(seq), 'kind3', kind(r));
  expect(seq[0], '#1 оба лимита ок').toBe(200);
  expect(seq[1], '#2 оба лимита ок').toBe(200);
  expect(seq[2], '#3 режется count-лимитом (amount ещё не исчерпан)').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── TC-18b: amount(strict cap=1) + count(loose cap=100) → пробитие ЛЮБОГО (amount) блокирует с первого ──
test('TC-18b: два лимита — пробитие строгого amount блокирует с первого платежа', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-18b-amt ${Date.now()}` });
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', byField: 'Card hash', timeWindow: 'Hour', value: 100, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG TC-18b-cnt ${Date.now()}` });
  const r = await sendPayment(api, { amountRub: 100 });
  console.log('[TC-18b] first', r.status, kind(r) || '');
  expect(r.status, 'пробитие amount-лимита блокирует, хотя count ещё свободен').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});
