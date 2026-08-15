// TC-19: idempotent-retry (тот же Idempotency-Key + body) НЕ задваивает счётчик лимита.
// count/card_hash cap=2. #1(K1) + #1b(K1, повтор) должны считаться как ОДИН → #2 ещё проходит,
// режется только #3. Если idempotency ломает счёт → #2 уже 422.
import { test, expect } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimit, deleteLimits, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const M = ENTITIES.merchants.PAYIN;
const CARD = '4730198364688516'; // изолированный card_hash (не 4392/4627)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Страховка teardown: снести созданные-но-неудалённые лимиты после каждого теста.
test.afterEach(async ({ page }) => {
  const left = ledgerRead();
  if (left.length) { await deleteLimits(page, left).catch(() => {}); ledgerClear(); }
});

test('TC-19: idempotent-retry не задваивает счётчик лимита', async ({ page }) => {
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
  // #1b — тот же order + тот же ключ → idempotent (cached, не инкрементит)
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: ord1, idempotencyKey: K1 });
  o.n1b = r.status; o.pid1b = r.body?.payment_id; o.kind1b = r.body?.errors?.[0]?.kind; await sleep(1500);
  // #2 — новый ключ → count должен стать 2 (если #1b не задвоил)
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: `ord-${ts}-2`, idempotencyKey: `idem-${ts}-2` });
  o.n2 = r.status; await sleep(1500);
  // #3 — новый ключ → count 3 → 422
  r = await sendPayment(api, { amountRub: 100, cardPan: CARD, orderNumber: `ord-${ts}-3`, idempotencyKey: `idem-${ts}-3` });
  o.n3 = r.status; o.kind3 = r.body?.errors?.[0]?.kind;

  console.log('[TC-19]', JSON.stringify(o));
  await deleteLimit(page, id);
  await api.dispose();

  expect(o.n1, '#1 проходит').toBe(200);
  expect(o.pid1b, '#1b — тот же payment_id (cached, идемпотентно)').toBe(o.pid1);
  expect(o.n2, '#2 проходит → retry НЕ задвоил счётчик').toBe(200);
  expect(o.n3, '#3 режется (count 3)').toBe(422);
});
