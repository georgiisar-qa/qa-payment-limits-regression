// TC-17: инвалидация кэша при UPDATE живого лимита (не только create/delete). Это прямая проверка
// того, ради чего ушли с SQL на UI-конфиг: Rails сбрасывает кэш на save. Меняем value/shadow «на лету»
// и убеждаемся, что поведение платежа меняется синхронно.
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

// ── TC-17a: ужесточение на лету — не блокирующий лимит → UPDATE value→1 → начинает резать ──
test('TC-17a: UPDATE ужесточает value (1000000→1) → платёж начинает резаться (cache invalidated)', async () => {
  test.setTimeout(140000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1000000, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-17a ${Date.now()}` });
  let r = await sendPayment(api, { amountRub: 100 });
  expect(r.status, 'до апдейта (cap=1000000) проходит').toBe(200);
  await sleep(1500);
  await updateLimit(page, id, { value: 1 });        // ужесточаем
  r = await sendPayment(api, { amountRub: 100 });
  console.log('[TC-17a] after tighten', r.status, kind(r) || '');
  expect(r.status, 'после UPDATE cap=1 — режет (кэш сброшен на save)').toBe(422);
  expect(kind(r)).toBe('limit_exceeded');
});

// ── TC-17b: ослабление на лету — блокирующий лимит → UPDATE value→большое → перестаёт резать ──
test('TC-17b: UPDATE ослабляет value (1→1000000) → платёж перестаёт резаться', async () => {
  test.setTimeout(140000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-17b ${Date.now()}` });
  let r = await sendPayment(api, { amountRub: 100 });
  expect(r.status, 'до апдейта (cap=1) режет').toBe(422);
  await sleep(1500);
  await updateLimit(page, id, { value: 1000000 });  // ослабляем
  r = await sendPayment(api, { amountRub: 100 });
  console.log('[TC-17b] after loosen', r.status, kind(r) || '');
  expect(r.status, 'после UPDATE cap=1000000 — проходит').toBe(200);
});

// ── TC-17c: toggle shadow_mode на лету — активный блок → UPDATE shadow=on → observe-only ──
test('TC-17c: UPDATE toggle shadow_mode on → блокирующий лимит становится observe-only', async () => {
  test.setTimeout(140000);
  const id = await createLimit(page, { scopeLevel: 'Merchant', scope: PAYIN.coreId, limitType: 'Amount', direction: 'Payin', timeWindow: 'Day', value: 1, currency: 'RUB', onBreach: 'Decline', ...SCHED, title: `REG TC-17c ${Date.now()}` });
  let r = await sendPayment(api, { amountRub: 100 });
  expect(r.status, 'до апдейта (active, cap=1) режет').toBe(422);
  await sleep(1500);
  await updateLimit(page, id, { shadowMode: true }); // включаем shadow
  // подтверждаем что флаг проставился в БД
  await page.goto('https://admin.example.com/admin/limits/' + id, { waitUntil: 'domcontentloaded' });
  const shadowVal = await page.evaluate(() => { const t = document.querySelector('main')?.innerText || ''; const m = t.match(/SHADOW MODE\s*\n?\s*(Yes|No)/i); return m ? m[1] : '(?)'; });
  r = await sendPayment(api, { amountRub: 100 });
  console.log(`[TC-17c] SHADOW=${shadowVal} after-toggle HTTP=${r.status} ${kind(r) || ''}`);
  expect(shadowVal, 'shadow_mode переключился в Yes через UPDATE').toBe('Yes');
  expect(r.status, 'observe-only после toggle — платёж проходит').toBe(200);
});
