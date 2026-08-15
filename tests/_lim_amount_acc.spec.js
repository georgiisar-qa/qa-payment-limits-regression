// Amount-limit accumulation: the limit SUMS transactions and blocks when the threshold is crossed
// (existing amount cases only use value=1/0 — trivial; here value=N and crossing the boundary).
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

// ── AM-ACC1: amount/day value=10000 → 6000(pass)+5000(cum=11000>10000 → blocks) ──
// Verifies the limit SUMS rather than looking at a single transaction amount.
test('AM-ACC1: amount cap=10000 accumulates → overflow on 2nd is blocked', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 10000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG AM-ACC1 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(api, { amountRub: 6000 }); seq.push(r.status); await sleep(2000); // cum=6000 ≤ 10000 → pass
  r = await sendPayment(api, { amountRub: 5000 }); seq.push(r.status);                          // cum=11000 > 10000 → blocks
  console.log('[AM-ACC1] seq', JSON.stringify(seq), 'kind2', kind(r));
  expect(seq[0], '1st (6000, cum≤cap) passes').toBe(200);
  expect(seq[1], '2nd (cum 11000 > 10000) blocked').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── AM-ACC2: a sub-threshold transaction after near-exhaustion is also blocked if it overflows ──
// cap=10000: 9000(pass, cum=9000) → 2000(cum=11000 → blocks), even though a single 2000 << cap.
test('AM-ACC2: small transaction is blocked if it overflows the accumulated threshold', async () => {
  test.setTimeout(140000);
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 10000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG AM-ACC2 ${Date.now()}` });
  const seq = [];
  let r = await sendPayment(api, { amountRub: 9000 }); seq.push(r.status); await sleep(2000); // cum=9000
  r = await sendPayment(api, { amountRub: 2000 }); seq.push(r.status);                          // cum=11000 → blocks
  console.log('[AM-ACC2] seq', JSON.stringify(seq), 'kind2', kind(r));
  expect(seq[0], '9000 passes (cum=9000 ≤ 10000)').toBe(200);
  expect(seq[1], '2000 blocked — overflows the accumulated threshold (single amount is small)').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});
