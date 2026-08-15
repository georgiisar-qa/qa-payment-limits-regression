// TC-19: idempotent-retry (same Idempotency-Key + body) does NOT double-count the limit counter.
// count/card_hash cap=2. #1(K1) + #1b(K1, retry) must count as ONE → #2 still passes,
// only #3 is blocked. If idempotency breaks counting → #2 is already 422.
import { test, expect } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimit, deleteLimits, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const M = ENTITIES.merchants.PAYIN;
const CARD = '4730198364688516'; // isolated card_hash (not 4392/4627)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Teardown safety net: remove created-but-undeleted limits after each test.
test.afterEach(async ({ page }) => {
  const left = ledgerRead();
  if (left.length) { await deleteLimits(page, left).catch(() => {}); ledgerClear(); }
});

test('TC-19: idempotent-retry does not double-count the limit counter', async ({ page }) => {
  test.setTimeout(180000);
  await loginAdmin(page); await selectTenantPrimary(page);
  const api = await newPayApi(M);
  let r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'clean-state').toBe(200);

  const id = await createLimit(page, {
    scopeLevel: 'Merchant', scope: M.coreId, limitType: 'Count', direction: 'Payin', byField: 'Card hash',
    timeWindow: 'Hour', value: 2, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline',
    effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31', title: `REG IDEM ${Date.now()}`,
  });

  const ts = Date.now();
  const K1 = `idem-${ts}-1`, ord1 = `ord-${ts}-1`;
  const o = {};
  // #1
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: ord1, idempotencyKey: K1 });
  o.n1 = r.status; o.pid1 = r.body?.payment_id; await sleep(1500);
  // #1b — same order + same key → idempotent (cached, does not increment)
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: ord1, idempotencyKey: K1 });
  o.n1b = r.status; o.pid1b = r.body?.payment_id; o.kind1b = r.body?.errors?.[0]?.kind; await sleep(1500);
  // #2 — new key → count should become 2 (if #1b did not double-count)
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: `ord-${ts}-2`, idempotencyKey: `idem-${ts}-2` });
  o.n2 = r.status; await sleep(1500);
  // #3 — new key → count 3 → 422
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: `ord-${ts}-3`, idempotencyKey: `idem-${ts}-3` });
  o.n3 = r.status; o.kind3 = r.body?.errors?.[0]?.kind;

  console.log('[TC-19]', JSON.stringify(o));
  await deleteLimit(page, id);
  await api.dispose();

  expect(o.n1, '#1 passes').toBe(200);
  expect(o.pid1b, '#1b — same payment_id (cached, idempotent)').toBe(o.pid1);
  expect(o.n2, '#2 passes → retry did NOT double-count the counter').toBe(200);
  expect(o.n3, '#3 blocked (count 3)').toBe(422);
});
