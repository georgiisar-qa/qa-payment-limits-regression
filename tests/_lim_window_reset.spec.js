// time_window reset: after exhausting the limit in a "minute" window, the counter rolls back once the window expires,
// and the next payment passes again. No Day case checks this (the window does not roll within a run).
// count_basis=success + a fixed 70s wait — reliable for both rolling-60s and calendar-minute.
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

// ── TW-RESET: count cap=2 / window=minute → exhaust, wait for the window to roll back, passes again ──
test('TW-RESET: minute window rolls back → after the wait the payment passes again', async () => {
  test.setTimeout(200000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Minute', value: 2, currency: 'RUB', countBasis: 'Success', onBreach: 'Decline', ...SCHED, title: `REG TW-RESET ${Date.now()}` });

  // Phase 1: exhaust the window
  const before = [];
  let r = await sendPayment(api, { amountRub: 100 }); before.push(r.status); await sleep(2500); // success #1
  r = await sendPayment(api, { amountRub: 100 }); before.push(r.status); await sleep(2500);       // success #2 → counter=2
  r = await sendPayment(api, { amountRub: 100 }); before.push(r.status);                            // #3 → 422 (window active)
  console.log('[TW-RESET] before-wait', JSON.stringify(before), 'kind3', kind(r));
  expect(before[0], 'success #1').toBe(200);
  expect(before[1], 'success #2').toBe(200);
  expect(before[2], '#3 rejected — window active').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');

  // Phase 2: wait for the minute window to roll back (successes #1/#2 age out of the window)
  console.log('[TW-RESET] waiting 70s for the window to roll back…');
  await sleep(70000);

  // Phase 3: after the roll-back the payment passes again
  r = await sendPayment(api, { amountRub: 100 });
  console.log('[TW-RESET] after-wait HTTP', r.status, kind(r) || '');
  expect(r.status, 'after the minute window rolls back the payment passes again').toBe(200);
});
