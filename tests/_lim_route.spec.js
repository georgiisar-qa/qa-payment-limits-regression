// Route-level cascade proof via route_decisions (Core Console). We prove WHICH MID is selected.
import { test, expect } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimit, deleteLimits, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { loginCoreDashboard, getRouteDecision, getGatewayAttempts, getSuccessMidByToken } from '../lib/core-dashboard.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

const M = ENTITIES.merchants.PAYIN;
const BASE = {
  scopeLevel: 'Merchant', scope: M.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day',
  currency: 'RUB', onBreach: 'Decline', effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31',
};

// Teardown safety net: remove created-but-undeleted limits after each test.
test.afterEach(async ({ page }) => {
  const left = ledgerRead();
  if (left.length) { await deleteLimits(page, left).catch(() => {}); ledgerClear(); }
});

async function probe(page, token, label) {
  await loginCoreDashboard(page);
  const successMid = await getSuccessMidByToken(page, token);
  const attempts = await getGatewayAttempts(page, token);
  const rd = await getRouteDecision(page, token);
  console.log(`[${label}] successMid=${successMid}`);
  console.log(`[${label}] attempts=`, JSON.stringify((attempts || []).map(a => ({ n: a.n, mid: a.mid, gw: a.gateway, st: a.status }))));
  console.log(`[${label}] route=`, JSON.stringify((rd || []).map(x => ({ rule: x.ruleId, mid: x.mid, limit: x.limit }))));
  return { successMid, attempts, rd };
}

test('RD-1: MID 465 fallback → success spilled over to another MID (not 465)', async ({ page }) => {
  test.setTimeout(180000);
  await loginAdmin(page); await selectTenantPrimary(page);
  const api = await newPayApi(M);
  let r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'clean-state').toBe(200);
  const id = await createLimit(page, { ...BASE, title: `REG RD1 ${Date.now()}`, scopeLevel: 'Mid', scope: 465, value: 1, onBreach: 'Fallback' });
  r = await sendPayment(api, { amountRub: 5000 });
  console.log('[RD-1] body', JSON.stringify(r.body).slice(0, 400));
  const token = r.body?.token || r.body?.payment_id || r.body?.api_payment_token || r.body?.id;
  console.log('[RD-1] payin', r.status, 'token', token);
  expect(r.status, 'fallback → 200').toBe(200);
  const { successMid } = await probe(page, token, 'RD-1');
  await deleteLimit(page, id);
  await api.dispose();
  expect(successMid, 'success NOT on 465 (spillover to the backup MID)').not.toBe('465');
});

test('RD-2: MID 465 single decline → what the cascade does (documented)', async ({ page }) => {
  test.setTimeout(180000);
  await loginAdmin(page); await selectTenantPrimary(page);
  const api = await newPayApi(M);
  let r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'clean-state').toBe(200);
  const id = await createLimit(page, { ...BASE, title: `REG RD2 ${Date.now()}`, scopeLevel: 'Mid', scope: 465, value: 1, onBreach: 'Decline' });
  r = await sendPayment(api, { amountRub: 5000 });
  const token = r.body?.payment_id || r.body?.token;
  console.log('[RD-2] payin', r.status, 'kind', r.body?.errors?.[0]?.kind || '—', 'token', token);
  if (r.status === 200 && token) await probe(page, token, 'RD-2');
  else console.log('[RD-2] payment rejected (422) — the payin record may not persist, route unavailable');
  await deleteLimit(page, id);
  await api.dispose();
});
