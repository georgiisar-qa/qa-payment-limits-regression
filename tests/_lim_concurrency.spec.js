// Concurrency / overshoot-guard (план TC-14.2): счётчик лимита атомарен под параллельной нагрузкой —
// НЕ пропускает больше cap при одновременных payin (нет race check-then-incr → нет двойного списания).
// Реализовано в харнессе через Promise.all (пробником доказано: детерминированно ровно cap успехов).
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

// Стреляет N одновременных payin и возвращает {ok, blocked, other}.
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

// ── CONC-1: cap=5, 10 одновременных → ровно 5 успехов, без overshoot ──
test('CONC-1: count cap=5 под 10 параллельными → ровно 5 успехов (счётчик атомарен)', async () => {
  test.setTimeout(120000);
  const CAP = 5, N = 10;
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Hour', value: CAP, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG CONC-1 ${Date.now()}` });
  const { ok, blocked, other } = await burst(N, 'c1');
  console.log(`[CONC-1] cap=${CAP} fired=${N} → ok=${ok} blocked=${blocked} other=${JSON.stringify(other)}`);
  expect(ok, 'НЕ больше cap прошло под гонкой (нет overshoot)').toBeLessThanOrEqual(CAP);
  expect(ok, 'ровно cap успехов — счётчик атомарен').toBe(CAP);
  expect(blocked, 'остальные отбиты').toBe(N - CAP);
});

// ── CONC-2: cap=1, 5 одновременных → ровно 1 успех (защита от double-spend) ──
test('CONC-2: count cap=1 под 5 параллельными → ровно 1 успех (no double-spend)', async () => {
  test.setTimeout(120000);
  const CAP = 1, N = 5;
  await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Count', direction: 'Payin', timeWindow: 'Hour', value: CAP, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG CONC-2 ${Date.now()}` });
  const { ok, blocked, other } = await burst(N, 'c2');
  console.log(`[CONC-2] cap=${CAP} fired=${N} → ok=${ok} blocked=${blocked} other=${JSON.stringify(other)}`);
  expect(ok, 'под гонкой при cap=1 не проскочило больше одного (нет двойного списания)').toBe(1);
  expect(blocked, 'остальные 4 отбиты').toBe(N - CAP);
});
