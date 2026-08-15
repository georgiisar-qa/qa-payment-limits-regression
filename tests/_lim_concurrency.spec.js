// Concurrency / overshoot-guard (plan TC-14.2): the limit counter is atomic under parallel load —
// it does NOT allow more than cap on concurrent payin (no race check-then-incr → no double-spend).
// Implemented in the harness via Promise.all (probe-proven: deterministically exactly cap successes).
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const PAYIN = ENTITIES.merchants.PAYIN; // coreId 145
const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };

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

// Fires N concurrent payin and returns {ok, blocked, other}.
async function burst(n, tag) {
  const ts = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => sendPayment(api, { amountRub: 100, orderNumber: `${tag}-${ts}-${i}` }))
  );
  const ok = results.filter(r => r.status === 200).length;
  const blocked = results.filter(r => r.status === 422).length;
  const other = results.filter(r => r.status !== 200 && r.status !== 422).map(r => r.status);
  return { ok, blocked, other };
}

// ── CONC-1: cap=5, 10 concurrent → exactly 5 successes, no overshoot ──
test('CONC-1: count cap=5 under 10 parallel → exactly 5 successes (counter is atomic)', async () => {
  test.setTimeout(120000);
  const CAP = 5, N = 10;
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Hour', value: CAP, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG CONC-1 ${Date.now()}` });
  const { ok, blocked, other } = await burst(N, 'c1');
  console.log(`[CONC-1] cap=${CAP} fired=${N} → ok=${ok} blocked=${blocked} other=${JSON.stringify(other)}`);
  expect(ok, 'no more than cap passed under the race (no overshoot)').toBeLessThanOrEqual(CAP);
  expect(ok, 'exactly cap successes — counter is atomic').toBe(CAP);
  expect(blocked, 'the rest are rejected').toBe(N - CAP);
});

// ── CONC-2: cap=1, 5 concurrent → exactly 1 success (double-spend protection) ──
test('CONC-2: count cap=1 under 5 parallel → exactly 1 success (no double-spend)', async () => {
  test.setTimeout(120000);
  const CAP = 1, N = 5;
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Hour', value: CAP, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG CONC-2 ${Date.now()}` });
  const { ok, blocked, other } = await burst(N, 'c2');
  console.log(`[CONC-2] cap=${CAP} fired=${N} → ok=${ok} blocked=${blocked} other=${JSON.stringify(other)}`);
  expect(ok, 'under the race with cap=1 no more than one slipped through (no double-spend)').toBe(1);
  expect(blocked, 'the remaining 4 are rejected').toBe(N - CAP);
});
