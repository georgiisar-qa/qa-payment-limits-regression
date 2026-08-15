// Full limits suite on the UI harness (createLimit direct-input). Controls: clean-state before
// each case (negative control) + teardown with verification. Serial + REG scrubber at the end.
import { test, expect, chromium } from '@playwright/test';
import { loginAdmin, selectTenantPrimary } from '../lib/auth.js';
import { createLimit, deleteLimit, deleteLimits, cleanupByTitlePrefix, ledgerRead, ledgerClear } from '../lib/limits-admin.js';
import { newPayApi, sendPayment } from '../lib/payments-api.js';
import { ENTITIES } from '../lib/config.js';

// NOT serial: serial aborts the remainder on the first failure. --workers=1 gives sequential
// execution and a shared beforeAll, but cases are independent (one failure doesn't hide the rest).
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
// Safety-net teardown: after EACH test remove everything it created but didn't delete
// (e.g. failed on an assert before deleteLimit). The ledger tracks every created id.
// Without this an orphan limit blocks the next test's clean-state (deadlock).
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
  expect(r.status, `${label}: environment clean (no stuck limit)`).toBe(200);
}
async function clearedAfterDelete() {
  for (let i = 0; i < 6; i++) {
    const r = await sendPayment(api, { amountRub: 5000 });
    if (r.status === 200) return true;
    await sleep(2000);
  }
  return false;
}

// ── BLOCK cases: value=1/0 decline → payin blocked with 422 limit_exceeded ──
for (const c of [
  { id: 'B1', name: 'merchant/145 amount value=1 → 422', cfg: { value: 1 } },
  { id: 'B2', name: 'PSP amount value=1 → 422 (global)', cfg: { scopeLevel: 'Psp', scope: '', value: 1 } },
  { id: 'B3', name: 'merchant/145 amount value=0 → 422 (full block)', cfg: { value: 0 } },
]) {
  test(`${c.id}: ${c.name}`, async () => {
    test.setTimeout(120000);
    await cleanState(c.id);
    const id = await createLimit(page, { ...BASE, title: `REG ${c.id} ${Date.now()}`, ...c.cfg });
    const r = await sendPayment(api, { amountRub: 5000 });
    expect(r.status, `${c.id}: must block`).toBe(422);
    expect(r.body?.errors?.[0]?.kind, `${c.id}: error contract`).toBe('limit_exceeded');
    await deleteLimit(page, id);
    expect(await clearedAfterDelete(), `${c.id}: teardown lifted the block`).toBe(true);
  });
}

// ── NO-BLOCK: schedule not active → payin passes ──
for (const c of [
  { id: 'N1', name: 'effective_from in the future → 200', cfg: { value: 1, effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' } },
  { id: 'N2', name: 'effective_to in the past → 200 (expired)', cfg: { value: 1, effectiveFrom: '2026-01-01', effectiveTo: '2026-08-10' } },
]) {
  test(`${c.id}: ${c.name}`, async () => {
    test.setTimeout(120000);
    await cleanState(c.id);
    const id = await createLimit(page, { ...BASE, title: `REG ${c.id} ${Date.now()}`, ...c.cfg });
    const r = await sendPayment(api, { amountRub: 5000 });
    expect(r.status, `${c.id}: schedule not active → no block`).toBe(200);
    await deleteLimit(page, id);
  });
}

// ── Cascade: all 4 MIDs under limit → nowhere to route → 422 ──
test('B4: all 4 MIDs amount value=1 → 422 (cascade has nowhere to go)', async () => {
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

// ── Velocity: count by card_hash cap=2 → 3rd payment with the same card is blocked ──
// Separate card (4627) so the card_hash counter is isolated from the amount cases (those use 4392).
test('V1: velocity count/card_hash cap=2 → 3rd with same card 422', async () => {
  test.setTimeout(120000);
  const CARD = '4627342642639018';
  await cleanState('V1'); // env check with the default card (does not touch the CARD counter)
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
  expect(codes[2], 'V1 #3 blocked').toBe(422);
});

// ── B5: a single MID decline does NOT stop the cascade (routes to 466) — needs route_decisions ──
// Observation: MID 465 decline → payin passed 200 (not 422). Decline hard-stops only when
// ALL reachable MIDs are covered (=B4). Skipped for now: without route_decisions we can't tell
// "decline≠stop" from "465 is not first". Investigate separately.
test.skip('B5: MID 465 decline — a single one does not stop the cascade (→200), needs route_decisions', async () => {});

// ── B6: both gateways (default 1 + paytech 133) under limit → no fallback → 422 ──
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

// ── N3: two limits on the merchant (loose 1e6 + strict 1) → the strict one fires ──
test('N3: overlapping — the strict limit wins → 422', async () => {
  test.setTimeout(120000);
  await cleanState('N3');
  const loose = await createLimit(page, { ...BASE, title: `REG N3-loose ${Date.now()}`, value: 1000000 });
  const strict = await createLimit(page, { ...BASE, title: `REG N3-strict ${Date.now()}`, value: 1 });
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'N3: the strict one blocks').toBe(422);
  await deleteLimit(page, strict);
  await deleteLimit(page, loose);
  expect(await clearedAfterDelete(), 'N3: teardown').toBe(true);
});

// ── F1: on_breach=fallback on MID 465, 466/467 are free → payment passes via cascade ──
test('F1: MID 465 fallback → payment passes (200) via a backup MID', async () => {
  test.setTimeout(120000);
  await cleanState('F1');
  const id = await createLimit(page, { ...BASE, title: `REG F1 ${Date.now()}`, scopeLevel: 'Mid', scope: 465, value: 1, onBreach: 'Fallback' });
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'F1: fallback → 200 (not decline)').toBe(200);
  await deleteLimit(page, id);
});

// ── S1: shadow_mode=true → limit does not block (observe-only) ──
test('S1: shadow_mode value=1 → 200 (does not block)', async () => {
  test.setTimeout(120000);
  await cleanState('S1');
  const id = await createLimit(page, { ...BASE, title: `REG S1 ${Date.now()}`, value: 1, shadowMode: true });
  const r = await sendPayment(api, { amountRub: 5000 });
  expect(r.status, 'S1: shadow does not block').toBe(200);
  await deleteLimit(page, id);
});

// ── V2: velocity email_hash cap=2 (unique email) → 3rd is blocked ──
test('V2: velocity count/email_hash cap=2 → 3rd with same email 422', async () => {
  test.setTimeout(120000);
  const EMAIL = `veltest${Date.now()}@qa.test`;
  await cleanState('V2');
  const id = await createLimit(page, { ...BASE, title: `REG V2 ${Date.now()}`, limitType: 'Count', byField: 'Email hash', timeWindow: 'Hour', value: 2, countBasis: 'Attempts' });
  const codes = [];
  for (let i = 1; i <= 3; i++) { const r = await sendPayment(api, { amountRub: 100, customer: { email: EMAIL } }); codes.push(r.status); await sleep(2000); }
  console.log('[V2] codes =', JSON.stringify(codes));
  await deleteLimit(page, id);
  expect(codes[2], 'V2 #3 blocked').toBe(422);
});

// ── Val1: from>to — the form SHOULD reject; currently a known bug VEL-BUG-2 (it gets created) ──
test('Val1: effective_from > effective_to — known-bug VEL-BUG-2 (gets created)', async () => {
  test.setTimeout(120000);
  await cleanState('Val1');
  let id = null, created = false;
  try { id = await createLimit(page, { ...BASE, title: `REG Val1 ${Date.now()}`, value: 1, effectiveFrom: '2027-12-31', effectiveTo: '2026-01-01' }); created = true; } catch { created = false; }
  console.log(`[Val1] from>to created=${created} (expectation per VEL-BUG-2: while the bug stands it gets created; once fixed → test fails, switch to reject)`);
  expect(created, 'VEL-BUG-2: currently a limit with from>to gets created (should be rejected)').toBe(true);
  if (id) await deleteLimit(page, id);
});

// ── V3: velocity card_brand — BLOCKS. Re-test 12.08: VEL-BUG-1 for card_brand RESOLVED
// (on 19.06 there was overshoot/counter=0; now it counts per brand and blocks). All test cards
// are Visa (4xxx) = one brand group → 3rd of the same brand is blocked. ──
test('V3: velocity count/card_brand cap=2 → 3rd of same brand 422 (VEL-BUG-1 FIXED)', async () => {
  test.setTimeout(120000);
  await cleanState('V3');
  const id = await createLimit(page, { ...BASE, title: `REG V3 ${Date.now()}`, limitType: 'Count', byField: 'Card brand', timeWindow: 'Hour', value: 2, countBasis: 'Attempts' });
  const codes = [];
  for (let i = 1; i <= 3; i++) { const r = await sendPayment(api, { amountRub: 100 }); codes.push(r.status); await sleep(2000); }
  console.log('[V3] codes =', JSON.stringify(codes));
  await deleteLimit(page, id);
  expect(codes[2], 'V3: card_brand blocks (VEL-BUG-1 fixed)').toBe(422);
});

// ── Covered in separate specs (moved out of this file) ──
// TC-13 payout ............ _lim_payout.spec.js (10 green)
// TC-19 idempotency ....... _lim_idem.spec.js (green)
// B5 single-MID decline ... _lim_route.spec.js (RD-2, explained by the route)
// Shop-scope + count_basis  _lim_scope_basis.spec.js (SC-1/SC-2/CB-1/CB-2 green)
// amount accumulation ..... _lim_amount_acc.spec.js (AM-ACC1/2 green)
// window-reset (minute) ... _lim_window_reset.spec.js (TW-RESET green)
// TC-23 multitenant ....... _lim_multitenant.spec.js (MT-1/2/3 green; tenantC split-brain FIXED)
// TC-15 currency .......... _lim_currency.spec.js (TC-15a/b green — currency = a matching dimension)
// TC-17 update/toggle ..... _lim_update.spec.js (TC-17a/b/c green — cache invalidation on UPDATE)
// TC-18 multi-limit ....... _lim_multi.spec.js (TC-18a/b green — strict wins / any-breach blocks)
// TC-22 refund ............ _lim_refund.spec.js (green — refund does not decrement the counter)
// boundary + open-ended ... _lim_boundary_sched.spec.js (BND-1 boundary is inclusive / SCH-1 to=NULL)
// TC-14.2 concurrency ..... _lim_concurrency.spec.js (CONC-1/2 green — counter is atomic, no double-spend)

// ── Intentional SKIP: blocked by deploy defect LIM-1 (filter_lists/bin_range models broken) ──
test.skip('BIN1: velocity bin_range — blocked by LIM-1 (bin_range model broken, item-picker empty)', async () => {});
test.skip('TC-9 blacklist — blocked by LIM-1 (filter_lists non-functional)', async () => {});
test.skip('TC-12 shared — blocked by LIM-1 (shared_limit via filter_lists)', async () => {});

// ── Intentional SKIP: ledger domain (not limit enforcement) ──
test.skip('TC-20 reserve lifecycle — needs settle/timeout control (ledger domain, separate)', async () => {});
