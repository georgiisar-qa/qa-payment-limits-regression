// TC-17: cache invalidation on UPDATE of a live limit (not only create/delete). This directly verifies
// the reason for moving from SQL to UI config: Rails clears the cache on save. We change value/shadow on the fly
// and confirm that payment behavior changes synchronously.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, updateLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
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

// ── TC-17a: tightening on the fly — non-blocking limit → UPDATE value→1 → starts blocking ──
test('TC-17a: UPDATE tightens value (1000000→1) → payment starts being blocked (cache invalidated)', async () => {
  test.setTimeout(140000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1000000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-17a ${Date.now()}` });
  let r = await sendPayment(api, { amountRub: 100 });
  expect(r.status, 'before update (cap=1000000) passes').toBe(200);
  await sleep(1500);
  await updateLimit(page, id, { value: 1 });        // tighten
  r = await sendPayment(api, { amountRub: 100 });
  console.log('[TC-17a] after tighten', r.status, kind(r) || '');
  expect(r.status, 'after UPDATE cap=1 — blocks (cache cleared on save)').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── TC-17b: loosening on the fly — blocking limit → UPDATE value→large → stops blocking ──
test('TC-17b: UPDATE loosens value (1→1000000) → payment stops being blocked', async () => {
  test.setTimeout(140000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-17b ${Date.now()}` });
  let r = await sendPayment(api, { amountRub: 100 });
  expect(r.status, 'before update (cap=1) blocks').toBe(422);
  await sleep(1500);
  await updateLimit(page, id, { value: 1000000 });  // loosen
  r = await sendPayment(api, { amountRub: 100 });
  console.log('[TC-17b] after loosen', r.status, kind(r) || '');
  expect(r.status, 'after UPDATE cap=1000000 — passes').toBe(200);
});

// ── TC-17c: toggle shadow_mode on the fly — active block → UPDATE shadow=on → observe-only ──
test('TC-17c: UPDATE toggle shadow_mode on → blocking limit becomes observe-only', async () => {
  test.setTimeout(140000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-17c ${Date.now()}` });
  let r = await sendPayment(api, { amountRub: 100 });
  expect(r.status, 'before update (active, cap=1) blocks').toBe(422);
  await sleep(1500);
  await updateLimit(page, id, { shadowMode: true }); // enable shadow
  // confirm the flag was set in the DB
  await page.goto('https://admin.example.com/admin/limits/' + id, { waitUntil: 'domcontentloaded' });
  const shadowVal = await page.evaluate(() => { const t = document.querySelector('main')?.innerText || ''; const m = t.match(/SHADOW MODE\s*\n?\s*(Yes|No)/i); return m ? m[1] : '(?)'; });
  r = await sendPayment(api, { amountRub: 100 });
  console.log(`[TC-17c] SHADOW=${shadowVal} after-toggle HTTP=${r.status} ${kind(r) || ''}`);
  expect(shadowVal, 'shadow_mode switched to Yes via UPDATE').toBe('Yes');
  expect(r.status, 'observe-only after toggle — payment passes').toBe(200);
});
