// TC-13 Payout: amount-блок, изоляция направлений, per-card velocity, каскад, idempotency.
// Payout работает (env-тариф решён: провайдер 563/MID497). Мерч payout=149, payin=145.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment, sendPayout } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const PAYOUT = ENTITIES.merchants.PAYOUT; // coreId 149
const PAYIN = ENTITIES.merchants.PAYIN;    // coreId 145
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };
const kind = (r) => r.body?.errors?.[0]?.kind;

let browser, page, poApi, piApi;
test.beforeAll(async () => {
  test.setTimeout(120000);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page); await selectTenantPrimary(page);
  poApi = await newPayApi(PAYOUT);
  piApi = await newPayApi(PAYIN);
});
test.afterEach(async () => {
  const left = ledgerRead();
  if (left.length) { await deleteLimits(page, left).catch(() => {}); ledgerClear(); }
});
test.afterAll(async () => {
  await cleanupByTitlePrefix(page, 'REG ').catch(() => {});
  await poApi?.dispose(); await piApi?.dispose(); await browser?.close();
});

// ── PO-A1: payout amount/day merchant/149 value=1 → payout режется ──
test('PO-A1: payout amount value=1 → 422 limit_exceeded', async () => {
  test.setTimeout(120000);
  let r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'clean-state payout').toBe(200);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG PO-A1 ${Date.now()}` });
  r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'payout режется').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── PO-A2: payout value=0 → полный блок ──
test('PO-A2: payout amount value=0 → 422 с первого', async () => {
  test.setTimeout(120000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 0, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG PO-A2 ${Date.now()}` });
  const r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'value=0 блок').toBe(422);
});

// ── PO-B1: payin-лимит на мерче 149 НЕ блокирует payout (изоляция направлений) ──
test('PO-B1: payin-лимит value=1 → payout проходит 200 (direction изолирован)', async () => {
  test.setTimeout(120000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG PO-B1 ${Date.now()}` });
  const r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'payout игнорит payin-лимит').toBe(200);
});

// ── PO-B2: payout-лимит на мерче 145 НЕ блокирует payin (обратная изоляция) ──
test('PO-B2: payout-лимит value=1 → payin проходит 200 (direction изолирован)', async () => {
  test.setTimeout(120000);
  let r = await sendPayment(piApi, { amountRub: 5000 });
  expect(r.status, 'clean payin').toBe(200);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG PO-B2 ${Date.now()}` });
  r = await sendPayment(piApi, { amountRub: 5000 });
  expect(r.status, 'payin игнорит payout-лимит').toBe(200);
});

// ── PO-C1: per-card velocity payout (by=card_hash) → 3 выплаты той же картой, 3-я режется ──
test('PO-C1: payout count/card_hash cap=2 → 3-я той же картой 422', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Count', direction: 'Payout', byField: 'Card hash', timeWindow: 'Hour', value: 2, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG PO-C1 ${Date.now()}` });
  const codes = [];
  for (let i = 0; i < 3; i++) { const r = await sendPayout(poApi, { amountRub: 100 }); codes.push(r.status); await sleep(2000); }
  console.log('[PO-C1] codes', JSON.stringify(codes));
  expect(codes[2], '3-я выплата той же картой режется').toBe(422);
});

// ── PO-D1: все payout-MID (497+468) под лимитом → каскаду некуда → 422 ──
test('PO-D1: все payout-MID (497+468) → payout 422', async () => {
  test.setTimeout(140000);
  let r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'clean payout').toBe(200);
  for (const mid of [497, 468]) {
    await createLimit(page, { scopeLevel: 'Mid', scope: mid, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG PO-D1-${mid} ${Date.now()}` });
  }
  r = await sendPayout(poApi, { amountRub: 1000 });
  console.log('[PO-D1] details', r.body?.errors?.[0]?.details || '—');
  expect(r.status, 'все payout-MID → 422').toBe(422);
});

// ── PO-F1: idempotent-retry payout не задваивает счётчик ──
test('PO-F1: payout idempotent-retry не задваивает счётчик', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Count', direction: 'Payout', byField: 'Card hash', timeWindow: 'Hour', value: 2, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG PO-F1 ${Date.now()}` });
  const ts = Date.now();
  const K1 = `poidem-${ts}-1`, ord1 = `poord-${ts}-1`;
  const o = {};
  let r = await sendPayout(poApi, { amountRub: 100, orderNumber: ord1, idempotencyKey: K1 }); o.n1 = r.status; o.pid1 = r.body?.payout_id; await sleep(1500);
  r = await sendPayout(poApi, { amountRub: 100, orderNumber: ord1, idempotencyKey: K1 }); o.n1b = r.status; o.pid1b = r.body?.payout_id; await sleep(1500);
  r = await sendPayout(poApi, { amountRub: 100, orderNumber: `poord-${ts}-2`, idempotencyKey: `poidem-${ts}-2` }); o.n2 = r.status; await sleep(1500);
  r = await sendPayout(poApi, { amountRub: 100, orderNumber: `poord-${ts}-3`, idempotencyKey: `poidem-${ts}-3` }); o.n3 = r.status;
  console.log('[PO-F1]', JSON.stringify(o));
  expect(o.pid1b, '#1b тот же payout_id (cached)').toBe(o.pid1);
  expect(o.n2, '#2 проходит → retry не задвоил').toBe(200);
  expect(o.n3, '#3 режется').toBe(422);
});

// ── PO-G1: payout effective_from в будущем → лимит не активен, payout проходит ──
test('PO-G1: payout effective_from future → 200 (не активен)', async () => {
  test.setTimeout(120000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31', title: `REG PO-G1 ${Date.now()}` });
  const r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'расписание не активно → payout проходит').toBe(200);
});

// ── PO-G2: payout effective_to в прошлом (истёк) → payout проходит ──
test('PO-G2: payout effective_to past → 200 (истёк)', async () => {
  test.setTimeout(120000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', effectiveFrom: '2026-01-01', effectiveTo: '2026-08-10', title: `REG PO-G2 ${Date.now()}` });
  const r = await sendPayout(poApi, { amountRub: 1000 });
  expect(r.status, 'истёкший лимит → payout проходит').toBe(200);
});

// ── PO-G3: payout shadow_mode → не режет (observe-only) ──
test('PO-G3: payout shadow_mode value=1 → 200 (observe-only)', async () => {
  test.setTimeout(120000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYOUT.coreId, limitType: 'Amount', direction: 'Payout', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', shadowMode: true, ...SCHED, title: `REG PO-G3 ${Date.now()}` });
  await page.goto('https://admin.example.com/admin/limits/' + id, { waitUntil: 'domcontentloaded' });
  const shadowVal = await page.evaluate(() => { const t = document.querySelector('main')?.innerText || ''; const m = t.match(/SHADOW MODE\s*\n?\s*(Yes|No)/i); return m ? m[1] : '(?)'; });
  const r = await sendPayout(poApi, { amountRub: 1000 });
  console.log(`[PO-G3] SHADOW MODE=${shadowVal} · payout HTTP=${r.status} ${kind(r) || ''}`);
  expect(shadowVal, 'shadow_mode проставлен (харнесс ок)').toBe('Yes');
  expect(r.status, 'shadow payout не режет (observe-only)').toBe(200);
});
