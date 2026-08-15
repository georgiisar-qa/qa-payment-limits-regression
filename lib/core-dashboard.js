// Чтение данных платежа из Core Console (console.example.com/console).
// Все хелперы работают ПО ТОКЕНУ платежа и используют новый console-flow:
// loginConsole → /console/payin_requests?filters[api_payment_token]=<token> → раскрыть строку.
import { CORE } from './config.js';
import { loginConsole } from './auth.js';

// Обёртка для обратной совместимости — старые тесты ждут loginCoreDashboard.
export async function loginCoreDashboard(page) {
  return loginConsole(page);
}

// UI-флоу: Payins → Add filter → Token → is exactly → <token> → Apply → раскрыть строку.
// Direct-URL не работает: после прямой навигации `.w-8` first попадает на иконку sidebar,
// а не на expand-кнопку строки. UI-флоу медленнее, но надёжно (Gateway Attempts подгружаются).
async function openConsolePayinByToken(page, token) {
  if (!token) return false;
  // Сбрасываем стейт: уходим на /console (home), оттуда жмём Payins link
  // (direct goto на /console/payin_requests не триггерит правильный JS-стейт,
  //  и потом '.w-8 first' попадает не на ту иконку).
  await page.goto(`${CORE.baseURL}/console`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.getByRole('link', { name: 'Payins' }).click({ timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: 'Add filter' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole('button', { name: 'Token' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole('button', { name: 'is exactly' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole('textbox', { name: 'Enter value...' }).fill(token).catch(() => {});
  await page.getByRole('button', { name: 'Apply' }).click({ timeout: 10000 }).catch(() => {});
  // ждём появления строки таблицы
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  // expand-кнопка строго внутри строки таблицы (а не где-то в sidebar)
  const expand = page.locator('tbody tr').first().locator('.w-8').first();
  await expand.click({ timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // ждём появления Route Decision блока (раскрывается асинхронно)
  await page.getByText(/Selected:\s*#?\d+/i).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  return true;
}

async function getAllTables(page) {
  return await page.locator('table').evaluateAll(ts => ts.map(t => {
    const headers = [...t.querySelectorAll('thead th, thead td')].map(th => (th.textContent || '').trim());
    const rows = [...t.querySelectorAll('tbody tr')].map(tr =>
      [...tr.querySelectorAll('td, th')].map(c => (c.textContent || '').replace(/\s+/g, ' ').trim())
    );
    return { headers, rows };
  }));
}

function findTable(tables, includes, excludes = []) {
  const has = (t, h) => t.headers.some(th => th.toLowerCase().includes(h.toLowerCase()));
  return tables.find(t => includes.every(h => has(t, h)) && !excludes.some(h => has(t, h)));
}

/**
 * Возвращает массив правил из Route Decision платежа.
 * Каждый элемент: { ruleId, gateway, mid, priority, method, filter, limit, param, details }
 */
export async function getRouteDecision(page, token) {
  if (!await openConsolePayinByToken(page, token)) return null;
  const tables = await getAllTables(page);
  const rd = findTable(tables, ['Rule', 'Limit', 'Priority'], ['Status', 'Gateway Token']);
  if (!rd) return null;
  return rd.rows.map(r => ({
    ruleId: r[0], gateway: r[1], mid: r[2], priority: r[3],
    method: r[4], filter: r[5], limit: r[6], param: r[7], details: r[8],
  }));
}

/**
 * Возвращает массив попыток на гейтах для платежа.
 * Каждый элемент: { n, ruleId, gateway, status, gatewayToken, mid, error, time, created }
 */
export async function getGatewayAttempts(page, token) {
  if (!await openConsolePayinByToken(page, token)) return null;
  const tables = await getAllTables(page);
  const ga = findTable(tables, ['Rule', 'Status', 'Gateway Token']);
  if (!ga) return null;
  return ga.rows.map(r => ({
    n: r[0], ruleId: r[1], gateway: r[2], status: r[3],
    gatewayToken: r[4], mid: r[5], error: r[6], time: r[7], created: r[8],
  }));
}

/**
 * Возвращает rule id из строки "Selected: #X" на detail-странице.
 */
export async function getSelectedRule(page, token) {
  if (!await openConsolePayinByToken(page, token)) return null;
  const txt = await page.getByText(/Selected:\s*#?\d+/i).first().textContent().catch(() => null);
  const m = txt?.match(/#?(\d+)/);
  return m ? m[1] : null;
}

/**
 * Возвращает MID, на котором платёж УСПЕШНО прошёл (последний Success-attempt).
 * null если success-попытки нет (платёж в итоге declined).
 */
export async function getSuccessMidByToken(page, token) {
  const attempts = await getGatewayAttempts(page, token);
  if (!attempts) return null;
  const success = [...attempts].reverse().find(a => /success/i.test(a.status));
  return success ? success.mid : null;
}

// Legacy stub — больше не используется, оставлен для импортов.
export async function findPayinIdByToken(page, { token } = {}) {
  return token || null;
}

/**
 * Полная сводка по платежу из console: route decision + gateway attempts + selected.
 */
export async function getPaymentDetails(page, token) {
  if (!await openConsolePayinByToken(page, token)) return null;
  const tables = await getAllTables(page);
  const rd = findTable(tables, ['Rule', 'Limit', 'Priority'], ['Status', 'Gateway Token']);
  const ga = findTable(tables, ['Rule', 'Status', 'Gateway Token']);
  const selectedTxt = await page.getByText(/Selected:\s*#?\d+/i).first().textContent().catch(() => null);
  const selectedRuleId = selectedTxt?.match(/#?(\d+)/)?.[1] || null;
  return {
    token,
    selectedRuleId,
    routeDecision: rd ? rd.rows.map(r => ({
      ruleId: r[0], gateway: r[1], mid: r[2], priority: r[3],
      method: r[4], filter: r[5], limit: r[6], param: r[7], details: r[8],
    })) : [],
    gatewayAttempts: ga ? ga.rows.map(r => ({
      n: r[0], ruleId: r[1], gateway: r[2], status: r[3],
      gatewayToken: r[4], mid: r[5], error: r[6], time: r[7], created: r[8],
    })) : [],
  };
}
