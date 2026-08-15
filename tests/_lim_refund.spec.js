// TC-22: refund vs the limit counter. The limit is a velocity control of attempts at authorization; a subsequent
// refund does NOT return budget (the counter is not decremented). Verified: refund succeeds (HTTP 200),
// but the payin counter stays exhausted.
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

// ── TC-22: refund does not decrement the payin counter (velocity is not "returned") ──
test('TC-22: refund succeeds but does NOT free the exhausted payin counter', async () => {
  test.setTimeout(160000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', byField: 'Card hash', timeWindow: 'Hour', value: 2, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG TC-22 ${Date.now()}` });

  const p1 = await sendPayment(api, { amountRub: 500 }); await sleep(2500);
  const p2 = await sendPayment(api, { amountRub: 500 }); await sleep(2500);
  const p3 = await sendPayment(api, { amountRub: 500 });
  expect(p1.status, '#1').toBe(200);
  expect(p2.status, '#2').toBe(200);
  expect(p3.status, '#3 rejected (counter exhausted)').toBe(422);

  // refund payin#1 — succeeds synchronously
  const pid = p1.body?.payment_id;
  expect(pid, 'payment_id for refund').toBeTruthy();
  const res = await api.post(`/api/v1/payments/${pid}/refund`, { data: { amount: 50000, reason: 'qa TC-22' } });
  const refBody = await res.json().catch(() => ({}));
  console.log(`[TC-22] refund → HTTP=${res.status()} refund_id=${refBody.refund_id || '-'}`);
  expect(res.status(), 'refund succeeds').toBe(200);
  await sleep(4000);

  // counter did NOT free up — the next payin is still rejected
  const p4 = await sendPayment(api, { amountRub: 500 });
  console.log(`[TC-22] p4 after refund → ${p4.status}/${kind(p4) || '-'}`);
  expect(p4.status, 'refund did NOT return velocity budget — payin is still rejected').toBe(422);
  expect(kind(p4)).toBe('limit_exceeded');
});
