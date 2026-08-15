// TC-23 Мультитенант: (1) каждый тенант энфорсит лимиты независимо; (2) лимит одного тенанта
// НЕ протекает в другой (изоляция). Креды — из нагрузочного сетапа (reports/qa-lt-{tenantB,tenantC}-FINAL.json).
// Тенант-switcher только на корне /admin (см. selectTenant). Лимит удаляется в активном тенанте до переключения.
// NB: tenantC split-brain (19.06 overshoot 5/5) — ПОЧИНЕН, теперь отбивает (проверено пробником 12.08).
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenant } from '../lib/auth.js';
import { createLimit, deleteLimits, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES, TENANTS } from '../lib/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCHED = { effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31' };
const kind = (r) => r.body?.errors?.[0]?.kind;

// Тенантные payin-шопы (LT_M1_S_PAYIN_A) — свои pay-router/creds/coreId, валюта USD.
// Креды — из config.TENANTS (env: LIMITS_TENANT_B_*/LIMITS_TENANT_C_*).
const TEN = TENANTS;

let browser, page, primaryApi, tenantBApi, tenantCApi;
test.beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page);
  primaryApi  = await newPayApi(ENTITIES.merchants.PAYIN); // primary payin (RUB, coreId 145)
  tenantBApi = await newPayApi({ baseURL: TEN.tenantB.base, bearer: TEN.tenantB.bearer, apiSecret: TEN.tenantB.apiSecret });
  tenantCApi = await newPayApi({ baseURL: TEN.tenantC.base, bearer: TEN.tenantC.bearer, apiSecret: TEN.tenantC.apiSecret });
});
test.afterEach(async () => { const l = ledgerRead(); if (l.length) { await deleteLimits(page, l).catch(() => {}); ledgerClear(); } });
test.afterAll(async () => { await primaryApi?.dispose(); await tenantBApi?.dispose(); await tenantCApi?.dispose(); await browser?.close(); });

// Хелпер: завести count/card_hash cap=2 лимит на shop-scope в текущем тенанте, вернуть id.
async function mkTenantLimit(t, tag) {
  return createLimit(page, { scopeLevel: 'Shop', scope: t.shopCore, limitType: 'Count', direction: 'Payin', byField: 'Card hash', timeWindow: 'Hour', value: 2, currency: t.cur, countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG MT-${tag} ${Date.now()}` });
}

// ── MT-1: tenantB энфорсит + лимит tenantB НЕ трогает primary ──
test('MT-1: tenantB count/card_hash cap=2 режет 3-й; primary не затронут (изоляция)', async () => {
  test.setTimeout(180000);
  const t = TEN.tenantB;
  await selectTenant(page, t.name);
  await mkTenantLimit(t, 'tenantB');
  const seq = [];
  for (let i = 0; i < 3; i++) { const r = await sendPayment(tenantBApi, { amountRub: 10, currency: t.cur }); seq.push(r.status); await sleep(2500); }
  console.log('[MT-1] tenantB seq', JSON.stringify(seq));
  expect(seq[0], 'tenantB #1').toBe(200);
  expect(seq[1], 'tenantB #2').toBe(200);
  expect(seq[2], 'tenantB #3 режется').toBe(422);
  // кросс-тенант: primary-payin проходит, несмотря на исчерпанный лимит tenantB
  const d = await sendPayment(primaryApi, { amountRub: 100 });
  expect(d.status, 'primary НЕ затронут лимитом tenantB (изоляция тенантов)').toBe(200);
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear(); // удаляем в активном (tenantB) тенанте
});

// ── MT-2: tenantC энфорсит (split-brain починен) + лимит tenantC НЕ трогает primary ──
test('MT-2: tenantC count/card_hash cap=2 режет 3-й (split-brain FIXED); primary не затронут', async () => {
  test.setTimeout(180000);
  const t = TEN.tenantC;
  await selectTenant(page, t.name);
  await mkTenantLimit(t, 'tenantC');
  const seq = [];
  for (let i = 0; i < 3; i++) { const r = await sendPayment(tenantCApi, { amountRub: 10, currency: t.cur }); seq.push(r.status); await sleep(2500); }
  console.log('[MT-2] tenantC seq', JSON.stringify(seq));
  expect(seq[0], 'tenantC #1').toBe(200);
  expect(seq[1], 'tenantC #2').toBe(200);
  expect(seq[2], 'tenantC #3 режется — enforcement восстановлен').toBe(422);
  const d = await sendPayment(primaryApi, { amountRub: 100 });
  expect(d.status, 'primary НЕ затронут лимитом tenantC').toBe(200);
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear();
});

// ── MT-3: обратная изоляция — лимит primary НЕ трогает tenantB ──
test('MT-3: primary merchant cap=1 исчерпан → tenantB payin проходит (обратная изоляция)', async () => {
  test.setTimeout(180000);
  await selectTenant(page, 'Primary');
  await createLimit(page, { scopeLevel: 'Merchant', scope: ENTITIES.merchants.PAYIN.coreId, limitType: 'Count', direction: 'Payin', byField: 'Card hash', timeWindow: 'Hour', value: 1, currency: 'RUB', countBasis: 'Attempts', onBreach: 'Decline', ...SCHED, title: `REG MT-primary ${Date.now()}` });
  const dseq = [];
  for (let i = 0; i < 2; i++) { const r = await sendPayment(primaryApi, { amountRub: 100 }); dseq.push(r.status); await sleep(2500); }
  console.log('[MT-3] primary seq', JSON.stringify(dseq));
  expect(dseq[0], 'primary #1').toBe(200);
  expect(dseq[1], 'primary #2 режется (cap=1)').toBe(422);
  // tenantB-payin проходит — primary-лимит его не касается
  const s = await sendPayment(tenantBApi, { amountRub: 10, currency: TEN.tenantB.cur });
  expect(s.status, 'tenantB НЕ затронут лимитом primary (обратная изоляция)').toBe(200);
  await deleteLimits(page, ledgerRead()).catch(() => {}); ledgerClear();
});
