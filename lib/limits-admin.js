import { ADMIN } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

// Журнал созданных лимитов. Используется для восстановления после краша:
// следующий прогон читает файл и пытается удалить всё что не было удалено.
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
 * Создаёт лимит через UI админки. Возвращает ID созданного лимита.
 *
 * cfg: {
 *   title, scopeLevel, scope, limitType, direction,
 *   timeWindow, value, currency, countBasis, onBreach,
 *   effectiveFrom, effectiveTo
 * }
 */
export async function createLimit(page, cfg) {
  await page.goto(ADMIN.baseURL + '/admin/limits/new');

  // Заполняем поля напрямую в inputs формы limit[...] (значения — как хранит БД, lowercase),
  // затем реальный клик "Create Limit". Прямое проставление убивает гонки флейки-виджетов
  // (autocomplete/select-option), из-за которых поля молча уходили null → лимит не создавался
  // (NotNull on_breach) или не энфорсился (currency = имя вместо кода).
  // Enum в БД: scope_level=merchant/shop/mid/gateway/psp · limit_type=amount/count ·
  // direction=payin/payout · time_window=minute/hour/day/month · on_breach=decline/fallback ·
  // by=card_hash/bin/bin_range/phone_hash/card_brand/issuer/mobile_operator/email_hash/token ·
  // count_basis=attempts/success/declines. Валюта — код как есть (RUB), не lowercase.
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
      `Errors: ${compact || '(не нашёл текст ошибки в DOM)'}. Screenshot: ${shotPath}`);
  }

  const urlMatch = page.url().match(/\/admin\/limits\/(\d+)(?:\?|$)/);
  if (urlMatch) {
    ledgerAdd(urlMatch[1]);
    return urlMatch[1];
  }

  // fallback — максимальный ID в списке
  await page.goto(ADMIN.baseURL + '/admin/limits');
  await waitLimitsLoaded(page);
  const ids = await page.locator('tr[id^="limit_"]').evaluateAll(
    nodes => nodes
      .filter(n => /^limit_\d+$/.test(n.id))
      .map(n => parseInt(n.id.replace('limit_', ''), 10))
      .filter(n => !isNaN(n))
  );
  if (!ids.length) throw new Error('Список лимитов пуст после создания');
  const id = String(Math.max(...ids));
  ledgerAdd(id);
  return id;
}

/**
 * Обновляет ПОЛЯ существующего лимита через форму /admin/limits/<id>/edit (тот же direct-input,
 * что и createLimit). Меняет только переданные ключи (value/shadowMode/effectiveTo/onBreach/...).
 * Нужен для TC-17 — проверки инвалидации кэша на UPDATE (а не только create/delete).
 * changes: { value?, currency?, onBreach?, effectiveFrom?, effectiveTo?, byField?, countBasis?,
 *            timeWindow?, shadowMode? (bool, снимает/ставит checkbox) }
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
      // Rails-пара: hidden value=0 + checkbox value=1 с тем же name. Ставим именно checkbox.
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

  // SUBMIT — edit-форма НЕ уходит по клику кнопки/requestSubmit (JS-обработчик глотает);
  // работает ТОЛЬКО нативный HTMLFormElement.submit() (форма стандартная Rails: _method=patch +
  // authenticity_token уже в DOM → чистый POST постит все поля). Проверено интерактивно 12.08.
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
 * Удаляет лимит по ID. Идём на detail-страницу, жмём Delete, потом
 * кнопку подтверждения (Delete или Execute — что найдётся первым).
 * Все ожидания с жёсткими таймаутами чтобы не виснуть.
 */
// Признак "лимита нет": админка на удалённый/несуществующий лимит отдаёт 404 ИЛИ 500
// (бэкенд кидает 500, а не 404 — раньше из-за проверки только на 404 ledgerRemove не
// срабатывал и журнал пух, а beforeAll-cleanup жёг ~20с на кликах по призракам).
async function limitGone(page, resp) {
  const st = resp ? resp.status() : 0;
  if (st === 404 || st === 500) return true;
  const hasDelete = await page.getByRole('button', { name: /^Delete$/ })
    .or(page.getByRole('link', { name: 'Delete' })).first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  return !hasDelete;
}

export async function deleteLimit(page, limitId) {
  // Принимаем любые confirm-диалоги
  page.on('dialog', d => d.accept().catch(() => {}));

  const resp = await page.goto(`${ADMIN.baseURL}/admin/limits/${limitId}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);

  // Фаст-путь: лимита уже нет → чистим журнал и выходим, не жжём таймауты на кликах
  if (await limitGone(page, resp)) { ledgerRemove(limitId); return; }

  // Шаг 1: первая кнопка/ссылка Delete на detail page
  const step1 = page.getByRole('link', { name: 'Delete' }).or(page.getByRole('button', { name: /^Delete$/ })).first();
  await step1.click({ timeout: 10000 }).catch(() => {});

  // Шаг 2: подтверждение — ищем либо Delete либо Execute
  const confirm = page.getByRole('button', { name: /^Delete$/ }).or(page.getByRole('button', { name: /^Execute$/ })).first();
  await confirm.click({ timeout: 10000 }).catch(() => {});

  // Шаг 3: возможная ещё одна Execute
  await page.getByRole('button', { name: /^Execute$/ }).click({ timeout: 3000 }).catch(() => {});

  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});

  // Verify с ретраями — удаление применяется асинхронно (лимит ещё 200, через миг → 500).
  // Поллим пока "пропадёт", иначе id зависнет в журнале.
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
 * Читает counter лимита с admin detail-страницы.
 * Возвращает { dbCurrent, dbReserve, redisCurrent, redisReserve, value, redisKey } или null если 404.
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
          // берём следующий sibling с числом
          let sib = n.nextElementSibling;
          while (sib) {
            const sv = (sib.textContent || '').trim();
            if (sv && /[0-9]/.test(sv)) return sv;
            sib = sib.nextElementSibling;
          }
          // или родитель содержит число отдельным блоком
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

    // Counters (DB) блок: Current / Reserve
    const dbCurrent = num(textAfterLabel('Current'));
    const dbReserve = num(textAfterLabel('Reserve'));

    // Configuration блок: Value
    const value = num(textAfterLabel('Value'));

    // Redis Details: ищем строку формата "exists: true, current: X, reserve: Y, value: Z"
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
 * Ждёт пока список лимитов подгрузится (skeleton animate-pulse уйдёт).
 */
async function waitLimitsLoaded(page) {
  // Ждём либо что появятся tr с id=limit_NNN без sub-id, либо empty state
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    if (!rows.length) return true; // empty
    const hasSkeleton = rows.some(r => r.className.includes('animate-pulse'));
    return !hasSkeleton;
  }, null, { timeout: 20000 }).catch(() => {});
}

/**
 * Возвращает массив {id, title} строк-лимитов на текущей странице.
 * Использует селектор tr[id^="limit_"] чтобы не захватывать sub-элементы (limit_NNN_title и т.п.)
 */
async function listLimitsOnPage(page) {
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[id^="limit_"]')];
    return rows
      .filter(r => /^limit_\d+$/.test(r.id))  // только row ID, без sub-полей
      .map(r => {
        const id = r.id.replace('limit_', '');
        const titleCell = r.querySelector('td:nth-child(2)');
        return { id, title: titleCell?.textContent?.trim() || '' };
      });
  });
}

/**
 * Находит все лимиты с заданным префиксом в title и удаляет их.
 * Работает через прямой URL /admin/limits/:id/delete, без лазанья по пагинации.
 */
export async function cleanupByTitlePrefix(page, prefix = 'REG ') {
  await page.goto(ADMIN.baseURL + '/admin/limits');
  await waitLimitsLoaded(page);

  const idsToDelete = [];
  // Проходим по страницам пока видим лимиты с нашим префиксом
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

    // Следующая страница — ищем ссылку rel=next или ?page=N+1
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
    console.log('  🧹 cleanup: leftover REG-limits не найдены');
    return 0;
  }
  console.log(`  🧹 cleanup: удаляю ${idsToDelete.length} REG-лимитов: ${idsToDelete.slice(0, 10).join(', ')}${idsToDelete.length > 10 ? '...' : ''}`);
  let deleted = 0;
  for (const id of idsToDelete) {
    try {
      await deleteLimit(page, id);
      deleted++;
    } catch (e) {
      console.log(`    ⚠️ не удалось удалить ${id}: ${e.message}`);
    }
  }
  console.log(`  ✅ удалено ${deleted}/${idsToDelete.length}`);
  return deleted;
}
