// Полный сьют лимитов на UI-харнессе (createLimit direct-input). Контроли: clean-state перед
// каждым кейсом (negative control) + teardown с верификацией. Serial + скраббер REG в конце.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

// НЕ serial: serial обрывает остаток на первом фейле. --workers=1 даёт последовательность
// и общий beforeAll, но кейсы независимы (фейл одного не скрывает остальные).
const M = ENTITIES.merchants.PAYIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = {
  scopeLevel: 'Merchant', scope: M.coreId, limitType: 'Amount', direction: 'Payin',
  timeWindow: 'Day', currency: 'RUB', onBreach: 'Decline',
  effectiveFrom: '2026-08-01', effectiveTo: '2027-12-31',
};

let browser, page, api;
test.beforeAll(async () => {
  test.setTimeout(120000);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await loginAdmin(page);
  await selectTenantPrimary(page);
  api = await newPayApi(M);
});
// СТРАХОВКА teardown: после КАЖДОГО теста сносим всё, что он создал но не удалил
// (например упал на ассерте до deleteLimit). ledger трекает каждый созданный id.
// Без этого орфан-лимит блокирует clean-state следующего теста (дедлок).
test.afterEach(async () => {
  const left = ledgerRead();
  if (left.length) { await deleteLimits(page, left).catch(() => {}); ledgerClear(); }
});
test.afterAll(async () => {
  await cleanupByTitlePrefix(page, 'REG ').catch(() => {});
  await api?.dispose();
  await browser?.close();
});

async function cleanState(label) {
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, `${label}: среда чистая (нет застрявшего лимита)`).toBe(200);
}
async function clearedAfterDelete() {
  for (let i = 0; i < 6; i++) {
    const r = await sendPayment(api, { amountRub: 5000 });
    if (r.status === 200) return true;
    await sleep(2000);
  }
  return false;
}

// ── BLOCK-кейсы: value=1/0 decline → payin режется 422 limit_exceeded ──
for (const c of [
  { id: 'B1', name: 'merchant/145 amount value=1 → 422', cfg: { value: 1 } },
  { id: 'B2', name: 'PSP amount value=1 → 422 (глобально)', cfg: { scopeLevel: 'Psp', scope: '', value: 1 } },
  { id: 'B3', name: 'merchant/145 amount value=0 → 422 (полный блок)', cfg: { value: 0 } },
]) {
  test(`${c.id}: ${c.name}`, async () => {
    test.setTimeout(120000);
    await cleanState(c.id);
    const id = await createLimit(page, { ...BASE, title: `REG ${c.id} ${Date.now()}`, ...c.cfg });
    const r = await sendPayment(api, { amountRub: 5000 });
    expect(r.status, `${c.id}: должен резать`).toBe(422);
    expect(r.body?.errors?.[0]?.kind, `${c.id}: контракт ошибки`).toBe('limit_exceeded');
    await deleteLimit(page, id);
    expect(await clearedAfterDelete(), `${c.id}: teardown снял блок`).toBe(true);
  });
}

// ── NO-BLOCK: расписание не активно → payin проходит ──
for (const c of [
  { id: 'N1', name: 'effective_from в будущем → 200', cfg: { value: 1, effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' } },
  { id: 'N2', name: 'effective_to в прошлом → 200 (истёк)', cfg: { value: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-08-10' } },
]) {
  test(`${c.id}: ${c.name}`, async () => {
    test.setTimeout(120000);
    await cleanState(c.id);
    const id = await createLimit(page, { ...BASE, title: `REG ${c.id} ${Date.now()}`, ...c.cfg });
    const r = await sendPayment(api, { amountRub: 5000 });
    expect(r.status, `${c.id}: расписание не активно → не режет`).toBe(200);
    await deleteLimit(page, id);
  });
}

// ── Каскад: все 4 MID под лимитом → некуда → 422 ──
test('B4: все 4 MID amount value=1 → 422 (каскад некуда)', async () => {
  test.setTimeout(150000);
  await cleanState('B4');
  const ids = [];
  for (const mid of [464, 465, 466, 467]) {
    ids.push(await createLimit(page, { ...BASE, title: `REG B4-${mid} ${Date.now()}`, scopeLevel: 'Mid', scope: mid, value: 1 }));
  }
  const r = await sendPayment(api, { amountRub: 5000 });
  console.log('[B4] details:', r.body?.errors?.[0]?.details || '—');
  expect(r.status, 'B4: 422').toBe(422);
  expect(r.body?.errors?.[0]?.kind).toBe('limit_exceeded');
  for (const id of ids) await deleteLimit(page, id);
  expect(await clearedAfterDelete(), 'B4: teardown').toBe(true);
});

// ── Velocity: count by card_hash cap=2 → 3-й той же картой режется ──
// Отдельная карта (4627) чтобы счётчик card_hash был изолирован от amount-кейсов (те на 4392).
test('V1: velocity count/card_hash cap=2 → 3-й той же картой 422', async () => {
  test.setTimeout(120000);
  const CARD = '4627342642639018';
  await cleanState('V1'); // env-чек дефолт-картой (не трогает счётчик CARD)
  const id = await createLimit(page, {
    ...BASE, title: `REG V1 ${Date.now()}`, limitType: 'Count', byField: 'Card hash',
    timeWindow: 'Hour', value: 2, countBasis: 'Attempts',
  });
  const codes = [];
  for (let i = 1; i <= 3; i++) {
    const r = await sendPayment(api, { amountRub: 100, cardPan: CARD });
    codes.push(r.status);
    await sleep(2000);
  }
  console.log('[V1] codes =', JSON.stringify(codes));
  await deleteLimit(page, id);
  expect(codes[0], 'V1 #1').toBe(200);
  expect(codes[1], 'V1 #2').toBe(200);
  expect(codes[2], 'V1 #3 режется').toBe(422);
});

// ── B5: одиночный MID-decline НЕ стопит каскад (уходит на 466) — нужен route_decisions ──
// Наблюдение: MID 465 decline → payin прошёл 200 (не 422). Decline hard-стопит только когда
// перекрыты ВСЕ достижимые MID (=B4). Пока skip: без route_decisions не отличить «decline≠stop»
// от «465 не первый». Расследовать отдельно.
test.skip('B5: MID 465 decline — одиночный не стопит каскад (→200), нужен route_decisions', async () => {});

// ── B6: оба gateway (default 1 + paytech 133) под лимитом → fallback некуда → 422 ──
test('B6: gateway 1+133 amount value=1 → 422', async () => {
  test.setTimeout(120000);
  await cleanState('B6');
  const ids = [];
  for (const gw of [1, 133]) ids.push(await createLimit(page, { ...BASE, title: `REG B6-${gw} ${Date.now()}`, scopeLevel: 'Gateway', scope: gw, value: 1 }));
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'B6: 422').toBe(422);
  for (const id of ids) await deleteLimit(page, id);
  expect(await clearedAfterDelete(), 'B6: teardown').toBe(true);
});

// ── N3: два лимита на merchant (loose 1e6 + strict 1) → срабатывает строгий ──
test('N3: overlapping — строгий лимит выигрывает → 422', async () => {
  test.setTimeout(120000);
  await cleanState('N3');
  const loose = await createLimit(page, { ...BASE, title: `REG N3-loose ${Date.now()}`, value: 1000000 });
  const strict = await createLimit(page, { ...BASE, title: `REG N3-strict ${Date.now()}`, value: 1 });
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'N3: строгий режет').toBe(422);
  await deleteLimit(page, strict);
  await deleteLimit(page, loose);
  expect(await clearedAfterDelete(), 'N3: teardown').toBe(true);
});

// ── F1: on_breach=fallback на MID 465, 466/467 свободны → платёж проходит каскадом ──
test('F1: MID 465 fallback → платёж проходит (200) через резервный MID', async () => {
  test.setTimeout(120000);
  await cleanState('F1');
  const id = await createLimit(page, { ...BASE, title: `REG F1 ${Date.now()}`, scopeLevel: 'Mid', scope: 465, value: 1, onBreach: 'Fallback' });
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'F1: fallback → 200 (не decline)').toBe(200);
  await deleteLimit(page, id);
});

// ── S1: shadow_mode=true → лимит не режет (observe-only) ──
test('S1: shadow_mode value=1 → 200 (не блокирует)', async () => {
  test.setTimeout(120000);
  await cleanState('S1');
  const id = await createLimit(page, { ...BASE, title: `REG S1 ${Date.now()}`, value: 1, shadowMode: true });
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'S1: shadow не режет').toBe(200);
  await deleteLimit(page, id);
});

// ── V2: velocity email_hash cap=2 (уникальный email) → 3-й режется ──
test('V2: velocity count/email_hash cap=2 → 3-й тем же email 422', async () => {
  test.setTimeout(120000);
  const EMAIL = `veltest${Date.now()}@qa.test`;
  await cleanState('V2');
  const id = await createLimit(page, { ...BASE, title: `REG V2 ${Date.now()}`, limitType: 'Count', byField: 'Email hash', timeWindow: 'Hour', value: 2, countBasis: 'Attempts' });
  const codes = [];
  for (let i = 1; i <= 3; i++) { const r = await sendPayment(api, { amountRub: 100, customer: { email: EMAIL } }); codes.push(r.status); await sleep(2000); }
  console.log('[V2] codes =', JSON.stringify(codes));
  await deleteLimit(page, id);
  expect(codes[2], 'V2 #3 режется').toBe(422);
});

// ── Val1: from>to — форма ДОЛЖНА отклонять; сейчас известный баг VEL-BUG-2 (создаётся) ──
test('Val1: effective_from > effective_to — known-bug VEL-BUG-2 (создаётся)', async () => {
  test.setTimeout(120000);
  await cleanState('Val1');
  let id = null, created = false;
  try { id = await createLimit(page, { ...BASE, title: `REG Val1 ${Date.now()}`, value: 1, effectiveFrom: '2027-12-31', effectiveTo: '2026-01-01' }); created = true; } catch { created = false; }
  console.log(`[Val1] from>to created=${created} (ожидание по VEL-BUG-2: пока баг — создаётся; починят → тест упадёт, поменять на reject)`);
  expect(created, 'VEL-BUG-2: сейчас лимит с from>to создаётся (должен отклоняться)').toBe(true);
  if (id) await deleteLimit(page, id);
});

// ── V3: velocity card_brand — РЕЖЕТ. Ре-тест 12.08: VEL-BUG-1 для card_brand УСТРАНЁН
// (на 19.06 был overshoot/counter=0; сейчас считает по бренду и блокирует). Все тест-карты
// Visa (4xxx) = одна brand-группа → 3-я той же brand режется. ──
test('V3: velocity count/card_brand cap=2 → 3-й той же brand 422 (VEL-BUG-1 FIXED)', async () => {
  test.setTimeout(120000);
  await cleanState('V3');
  const id = await createLimit(page, { ...BASE, title: `REG V3 ${Date.now()}`, limitType: 'Count', byField: 'Card brand', timeWindow: 'Hour', value: 2, countBasis: 'Attempts' });
  const codes = [];
  for (let i = 1; i <= 3; i++) { const r = await sendPayment(api, { amountRub: 100 }); codes.push(r.status); await sleep(2000); }
  console.log('[V3] codes =', JSON.stringify(codes));
  await deleteLimit(page, id);
  expect(codes[2], 'V3: card_brand режет (VEL-BUG-1 пофикшен)').toBe(422);
});

// ── Покрыто в отдельных спеках (вынесено из этого файла) ──
// TC-13 payout ............ _lim_payout.spec.js (10 green)
// TC-19 idempotency ....... _lim_idem.spec.js (green)
// B5 single-MID decline ... _lim_route.spec.js (RD-2, объяснён route'ом)
// Shop-scope + count_basis  _lim_scope_basis.spec.js (SC-1/SC-2/CB-1/CB-2 green)
// amount-накопление ....... _lim_amount_acc.spec.js (AM-ACC1/2 green)
// window-reset (minute) ... _lim_window_reset.spec.js (TW-RESET green)
// TC-23 мультитенант ...... _lim_multitenant.spec.js (MT-1/2/3 green; tenantC split-brain FIXED)
// TC-15 валюта ............ _lim_currency.spec.js (TC-15a/b green — валюта = измерение матчинга)
// TC-17 update/toggle ..... _lim_update.spec.js (TC-17a/b/c green — cache invalidation на UPDATE)
// TC-18 multi-limit ....... _lim_multi.spec.js (TC-18a/b green — строгий выигрывает / any-breach блок)
// TC-22 refund ............ _lim_refund.spec.js (green — refund не декрементит счётчик)
// boundary + open-ended ... _lim_boundary_sched.spec.js (BND-1 граница включительна / SCH-1 to=NULL)
// TC-14.2 concurrency ..... _lim_concurrency.spec.js (CONC-1/2 green — счётчик атомарен, no double-spend)

// ── Осознанные SKIP: блокировано дефектом деплоя LIM-1 (filter_lists/bin_range модели сломаны) ──
test.skip('BIN1: velocity bin_range — блокировано LIM-1 (модель bin_range сломана, item-picker пуст)', async () => {});
test.skip('TC-9 blacklist — блокировано LIM-1 (filter_lists нефункциональны)', async () => {});
test.skip('TC-12 shared — блокировано LIM-1 (shared_limit через filter_lists)', async () => {});

// ── Осознанный SKIP: ledger-домен (не enforcement лимитов) ──
test.skip('TC-20 reserve lifecycle — нужен контроль settle/timeout (ledger-домен, отдельно)', async () => {});
