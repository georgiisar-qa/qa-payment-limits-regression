// Filling plan gaps: amount boundary precision (1.3/1.4 — boundary is inclusive) and
// open-ended schedule effective_to=NULL (5.4 — active indefinitely). Both are available via the UI
// (the limit arms instantly; the sync lag from the plan does not apply to UI config).
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

// ── BND-1 (plan 1.3+1.4): amount boundary is inclusive — spend EXACTLY=limit passes, +1 blocks ──
test('BND-1: amount cap=10000 — spend exactly=limit 200, next (+1) 422', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 10000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG BND-1 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(api, { amountRub: 9900 }); seq.push(r.status); await sleep(2000); // cum=9900 < 10000
  r = await sendPayment(api, { amountRub: 100 });  seq.push(r.status); await sleep(2000);       // cum=10000 EXACTLY = limit
  r = await sendPayment(api, { amountRub: 1 });    seq.push(r.status);                            // cum=10001 > limit
  console.log('[BND-1] seq', JSON.stringify(seq), 'kind3', kind(r));
  expect(seq[0], '9900 (< limit) passes').toBe(200);
  expect(seq[1], 'exactly=limit (10000) passes — boundary is inclusive (≤)').toBe(200);
  expect(seq[2], '+1 over the limit (10001) blocked').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── SCH-1 (plan 5.4): open-ended limit (effective_from in the past, effective_to empty) active indefinitely ──
test('SCH-1: effective_to=NULL → limit active indefinitely and blocks (422)', async () => {
  test.setTimeout(120000);
  // effectiveTo NOT passed → field empty; from in the past
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', effectiveFrom: '2026-08-01', title: `REG SCH-1 ${Date.now()}` });
  const r = await sendPayment(api, { amountRub: 100 });
  console.log('[SCH-1] open-ended payin', r.status, kind(r) || '');
  expect(r.status, 'open-ended limit (to=NULL) is active and blocks').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});
