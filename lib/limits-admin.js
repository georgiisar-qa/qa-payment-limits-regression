import { ADMIN } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

// Ledger of created limits. Used to recover after a crash:
// the next run reads the file and tries to delete everything that wasn't removed.
const LEDGER_PATH = path.join(process.cwd(), '.regression-limits-ledger.txt');

function ledgerAdd(id) {
  try { fs.appendFileSync(LEDGER_PATH, `${id}\n`); } catch {}
}
function ledgerRemove(id) {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return;
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(l => l && l !== String(id));
    fs.writeFileSync(LEDGER_PATH, lines.length ? lines.join('\n') + '\n' : '');
  } catch {}
}
export function ledgerRead() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return [];
    return fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean);
  } catch { return []; }
}
export function ledgerClear() {
  try { fs.writeFileSync(LEDGER_PATH, ''); } catch {}
}

/**
 * Creates a limit through the admin UI. Returns the ID of the created limit.
 *
 * cfg: {
 *   title, scopeLevel, scope, limitType, direction,
 *   timeWindow, value, currency, countBasis, onBreach,
 *   effectiveFrom, effectiveTo
 * }
 */
export async function createLimit(page, cfg) {
  await page.goto(ADMIN.baseURL + '/admin/limits/new');

  // Fill fields directly into the limit[...] form inputs (values as the DB stores them, lowercase),
  // then a real "Create Limit" click. Direct setting kills flaky-widget races
  // (autocomplete/select-option) that made fields silently go null → the limit wasn't created
  // (NotNull on_breach) or wasn't enforced (currency = name instead of code).
  // DB enums: scope_level=merchant/shop/mid/gateway/psp · limit_type=amount/count ·
  // direction=payin/payout · time_window=minute/hour/day/month · on_breach=decline/fallback ·
  // by=card_hash/bin/bin_range/phone_hash/card_brand/issuer/mobile_operator/email_hash/token ·
  // count_basis=attempts/success/declines. Currency — the code as-is (RUB), not lowercase.
  const toDb = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '_');
  await page.evaluate((c) => {
    const set = (name, val) => {
      const el = document.querySelector(`[name="limit[${name}]"]`);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('title', c.title);
    set('scope_level', c.scopeLevel);
    if (c.scope) set('scope_id', c.scope);
    set('limit_type', c.limitType);
    set('direction', c.direction);
    set('time_window', c.timeWindow);
    set('value', c.value);
    if (c.currency) set('currency_code', c.currency);
    if (c.filterListId) set('filter_list_id', c.filterListId);
    if (c.by) set('by', c.by);
    if (c.countBasis) set('count_basis', c.countBasis);
    set('on_breach', c.onBreach);
    if (c.effectiveFrom) set('effective_from', c.effectiveFrom);
    if (c.effectiveTo) set('effective_to', c.effectiveTo);
    if (c.shadow) {
      const cb = document.querySelector('input[type="checkbox"][name="limit[shadow_mode]"]');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }, {
    title: cfg.title || '', scopeLevel: toDb(cfg.scopeLevel),
    scope: (cfg.scope ?? '') === '' ? '' : String(cfg.scope),
    limitType: toDb(cfg.limitType), direction: toDb(cfg.direction), timeWindow: toDb(cfg.timeWindow),
    value: String(cfg.value), currency: cfg.currency || '',
    by: cfg.byField ? toDb(cfg.byField) : '', countBasis: cfg.countBasis ? toDb(cfg.countBasis) : '',
    onBreach: toDb(cfg.onBreach), effectiveFrom: cfg.effectiveFrom || '', effectiveTo: cfg.effectiveTo || '',
    shadow: !!cfg.shadowMode, filterListId: cfg.filterListId ? String(cfg.filterListId) : '',
  });

  // SUBMIT
  await page.getByRole('button', { name: 'Create Limit' }).click();

  await Promise.race([
    page.waitForURL(u => !u.pathname.endsWith('/new'), { timeout: 30000 }).catch(() => null),
    page.locator('text=error prohibited').waitFor({ timeout: 15000 }).catch(() => null),
  ]);

  if (page.url().includes('/limits/new')) {
    const shotPath = `test-results/limit-create-fail-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    const errBlocks = await page.locator('.invalid-feedback, .form-error-message, .alert-danger, [class*="error"]:visible')
      .allInnerTexts().catch(() => []);
    const mainTxt = await page.locator('main').innerText().catch(() => '');
    const compact = (errBlocks.join(' | ').trim()
      || mainTxt.split('\n').filter(s => s.trim()).slice(0, 15).join(' | ')).slice(0, 600);
    throw new Error(`Backend rejected (scope=${cfg.scopeLevel} id=${cfg.scope}). ` +
      `Errors: ${compact || '(no error text found in DOM)'}. Screenshot: ${shotPath}`);
  }

  const urlMatch = page.url().match(/\/admin\/limits\/(\d+)(?:\?|$)/);
  if (urlMatch) {
    ledgerAdd(urlMatch[1]);
    return urlMatch[1];
  }

  // fallback — the maximum ID in the list
  await page.goto(ADMIN.baseURL + '/admin/limits');
  await waitLimitsLoaded(page);
  const ids = await page.locator('tr[id^="limit_"]').evaluateAll(
    nodes => nodes
      .filter(n => /^limit_\d+$/.test(n.id))
      .map(n => parseInt(n.id.replace('limit_', ''), 10))
      .filter(n => !isNaN(n))
  );
  if (!ids.length) throw new Error('Limits list is empty after creation');
  const id = String(Math.max(...ids));
  ledgerAdd(id);
  return id;
}

/**
 * Updates the FIELDS of an existing limit via the /admin/limits/<id>/edit form (same direct-input
 * as createLimit). Changes only the passed keys (value/shadowMode/effectiveTo/onBreach/...).
 * Needed for TC-17 — verifying cache invalidation on UPDATE (not only create/delete).
 * changes: { value?, currency?, onBreach?, effectiveFrom?, effectiveTo?, byField?, countBasis?,
 *            timeWindow?, shadowMode? (bool, unsets/sets the checkbox) }
 */
export async function updateLimit(page, limitId, changes) {
  const toDb = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '_');
  await page.goto(`${ADMIN.baseURL}/admin/limits/${limitId}/edit`, { waitUntil: 'load' });

  await page.evaluate((c) => {
    const set = (name, val) => {
      const el = document.querySelector(`[name="limit[${name}]"]`);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (c.value !== undefined) set('value', c.value);
    if (c.currency !== undefined) set('currency_code', c.currency);
    if (c.onBreach !== undefined) set('on_breach', c.onBreach);
    if (c.timeWindow !== undefined) set('time_window', c.timeWindow);
    if (c.by !== undefined) set('by', c.by);
    if (c.countBasis !== undefined) set('count_basis', c.countBasis);
    if (c.effectiveFrom !== undefined) set('effective_from', c.effectiveFrom);
    if (c.effectiveTo !== undefined) set('effective_to', c.effectiveTo);
    if (c.shadow !== undefined) {
      // Rails pair: hidden value=0 + checkbox value=1 with the same name. Set the checkbox specifically.
      const cb = [...document.querySelectorAll('input[name="limit[shadow_mode]"]')].find(e => e.type === 'checkbox');
      if (cb) { cb.checked = !!c.shadow; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }, {
    value: changes.value !== undefined ? String(changes.value) : undefined,
    currency: changes.currency,
    onBreach: changes.onBreach !== undefined ? toDb(changes.onBreach) : undefined,
    timeWindow: changes.timeWindow !== undefined ? toDb(changes.timeWindow) : undefined,
    by: changes.byField !== undefined ? toDb(changes.byField) : undefined,
    countBasis: changes.countBasis !== undefined ? toDb(changes.countBasis) : undefined,
    effectiveFrom: changes.effectiveFrom, effectiveTo: changes.effectiveTo,
    shadow: changes.shadowMode,
  });

  // SUBMIT — the edit form does NOT submit on a button click/requestSubmit (a JS handler swallows it);
  // ONLY the native HTMLFormElement.submit() works (the form is standard Rails: _method=patch +
  // authenticity_token already in the DOM → a plain POST submits all fields). Verified interactively 12.08.
  const navP = page.waitForNavigation({ timeout: 30000, waitUntil: 'load' }).catch(() => null);
  await page.evaluate(() => {
    const form = document.querySelector('[name="limit[value]"]').closest('form');
    HTMLFormElement.prototype.submit.call(form);
  });
  await navP;

  if (page.url().includes('/edit')) {
    const mainTxt = await page.locator('main').innerText().catch(() => '');
    throw new Error(`updateLimit rejected (id=${limitId}): ${mainTxt.split('\n').filter(s=>s.trim()).slice(0,10).join(' | ').slice(0,400)}`);
  }
  return limitId;
}

/**
 * Deletes a limit by ID. Go to the detail page, click Delete, then
 * the confirmation button (Delete or Execute — whichever is found first).
 * All waits have hard timeouts so nothing hangs.
 */
// "Limit is gone" indicator: the admin returns 404 OR 500 for a deleted/nonexistent limit
// (the backend throws 500, not 404 — previously, checking only for 404 meant ledgerRemove
// didn't fire and the ledger grew, while the beforeAll cleanup burned ~20s clicking on ghosts).
async function limitGone(page, resp) {
  const st = resp ? resp.status() : 0;
  if (st === 404 || st === 500) return true;
  const hasDelete = await page.getByRole('button', { name: /^Delete$/ })
    .or(page.getByRole('link', { name: 'Delete' })).first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  return !hasDelete;
}

export async function deleteLimit(page, limitId) {
  // Accept any confirm dialogs
  page.on('dialog', d => d.accept().catch(() => {}));

  const resp = await page.goto(`${ADMIN.baseURL}/admin/limits/${limitId}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);

  // Fast path: the limit is already gone → clear the ledger and exit, don't burn timeouts on clicks
  if (await limitGone(page, resp)) { ledgerRemove(limitId); return; }

  // Step 1: the first Delete button/link on the detail page
  const step1 = page.getByRole('link', { name: 'Delete' }).or(page.getByRole('button', { name: /^Delete$/ })).first();
  await step1.click({ timeout: 10000 }).catch(() => {});

  // Step 2: confirmation — look for either Delete or Execute
  const confirm = page.getByRole('button', { name: /^Delete$/ }).or(page.getByRole('button', { name: /^Execute$/ })).first();
  await confirm.click({ timeout: 10000 }).catch(() => {});

  // Step 3: a possible additional Execute
  await page.getByRole('button', { name: /^Execute$/ }).click({ timeout: 3000 }).catch(() => {});

  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});

  // Verify with retries — deletion applies asynchronously (limit still 200, a moment later → 500).
  // Poll until it "disappears", otherwise the id lingers in the ledger.
  for (let i = 0; i < 4; i++) {
    const verify = await page.goto(`${ADMIN.baseURL}/admin/limits/${limitId}`,
      { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
    if (await limitGone(page, verify)) { ledgerRemove(limitId); break; }
    await page.waitForTimeout(1500);
  }
}

/**
 * Safely deletes many limits ignoring errors for missing ones.
 */
export async function deleteLimits(page, ids) {
  for (const id of ids) {
    try {
      await deleteLimit(page, id);
      console.log(`  🗑️ deleted limit ${id}`);
    } catch (e) {
      console.log(`  ⚠️ failed to delete ${id}: ${e.message}`);
    }
  }
}

/**
 * Reads a limit's counter from the admin detail page.
 * Returns { dbCurrent, dbReserve, redisCurrent, redisReserve, value, redisKey } or null if 404.
 */
export async function getLimitCounters(page, limitId) {
  const resp = await page.goto(`${ADMIN.baseURL}/admin/limits/${limitId}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 });
  if (resp && resp.status() === 404) return null;

  return await page.evaluate(() => {
    const num = s => s === null || s === undefined ? null : parseFloat(String(s).replace(/[^\d.\-]/g, ''));
    const textAfterLabel = (label) => {
      const nodes = [...document.querySelectorAll('div, span, p, dt, dd, td')];
      for (const n of nodes) {
        const txt = (n.textContent || '').trim();
        if (new RegExp(`^${label}$`, 'i').test(txt)) {
          // take the next sibling containing a number
          let sib = n.nextElementSibling;
          while (sib) {
            const sv = (sib.textContent || '').trim();
            if (sv && /[0-9]/.test(sv)) return sv;
            sib = sib.nextElementSibling;
          }
          // or the parent contains the number as a separate block
          const parent = n.parentElement;
          if (parent) {
            const cells = [...parent.children];
            const idx = cells.indexOf(n);
            if (idx >= 0 && cells[idx + 1]) return (cells[idx + 1].textContent || '').trim();
          }
        }
      }
      return null;
    };

    // Counters (DB) block: Current / Reserve
    const dbCurrent = num(textAfterLabel('Current'));
    const dbReserve = num(textAfterLabel('Reserve'));

    // Configuration block: Value
    const value = num(textAfterLabel('Value'));

    // Redis Details: look for a line in the format "exists: true, current: X, reserve: Y, value: Z"
    const redisText = [...document.querySelectorAll('p')]
      .map(p => (p.textContent || '').trim())
      .find(t => /current:\s*[\d.]/.test(t) && /reserve:\s*[\d.]/.test(t)) || '';
    const m = redisText.match(/current:\s*([\d.]+).*reserve:\s*([\d.]+).*value:\s*([\d.]+)/i);
    const redisCurrent = m ? parseFloat(m[1]) : null;
    const redisReserve = m ? parseFloat(m[2]) : null;
    const redisValue = m ? parseFloat(m[3]) : null;

    const redisKey = [...document.querySelectorAll('p')]
      .map(p => (p.textContent || '').trim())
      .find(t => /^limit:/.test(t)) || null;

    return {
      dbCurrent, dbReserve, value,
      redisCurrent, redisReserve, redisValue,
      redisKey,
    };
  });
}

/**
 * Waits until the limits list has loaded (the animate-pulse skeleton goes away).
 */
async function waitLimitsLoaded(page) {
  // Wait either for tr with id=limit_NNN without a sub-id to appear, or for the empty state
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    if (!rows.length) return true; // empty
    const hasSkeleton = rows.some(r => r.className.includes('animate-pulse'));
    return !hasSkeleton;
  }, null, { timeout: 20000 }).catch(() => {});
}

/**
 * Returns an array of {id, title} for the limit rows on the current page.
 * Uses the tr[id^="limit_"] selector so it doesn't catch sub-elements (limit_NNN_title etc.)
 */
async function listLimitsOnPage(page) {
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[id^="limit_"]')];
    return rows
      .filter(r => /^limit_\d+$/.test(r.id))  // only row IDs, no sub-fields
      .map(r => {
        const id = r.id.replace('limit_', '');
        const titleCell = r.querySelector('td:nth-child(2)');
        return { id, title: titleCell?.textContent?.trim() || '' };
      });
  });
}

/**
 * Finds all limits with the given title prefix and deletes them.
 * Works via the direct URL /admin/limits/:id/delete, without crawling pagination.
 */
export async function cleanupByTitlePrefix(page, prefix = 'REG ') {
  await page.goto(ADMIN.baseURL + '/admin/limits');
  await waitLimitsLoaded(page);

  const idsToDelete = [];
  // Walk through pages while we still see limits with our prefix
  let pageNum = 1;
  const seenPages = new Set();
  while (pageNum < 50) {
    if (seenPages.has(pageNum)) break;
    seenPages.add(pageNum);

    const items = await listLimitsOnPage(page);
    if (!items.length) break;

    for (const it of items) {
      if (it.title.startsWith(prefix)) {
        idsToDelete.push(it.id);
      }
    }

    // Next page — look for a rel=next link or ?page=N+1
    const nextHref = await page.evaluate(() => {
      const next = document.querySelector('a[rel="next"]');
      return next?.getAttribute('href') || null;
    });
    if (!nextHref) break;
    await page.goto(ADMIN.baseURL + nextHref);
    await waitLimitsLoaded(page);
    pageNum++;
  }

  if (!idsToDelete.length) {
    console.log('  🧹 cleanup: no leftover REG-limits found');
    return 0;
  }
  console.log(`  🧹 cleanup: deleting ${idsToDelete.length} REG-limits: ${idsToDelete.slice(0, 10).join(', ')}${idsToDelete.length > 10 ? '...' : ''}`);
  let deleted = 0;
  for (const id of idsToDelete) {
    try {
      await deleteLimit(page, id);
      deleted++;
    } catch (e) {
      console.log(`    ⚠️ failed to delete ${id}: ${e.message}`);
    }
  }
  console.log(`  ✅ deleted ${deleted}/${idsToDelete.length}`);
  return deleted;
}
