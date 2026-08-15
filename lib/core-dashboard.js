// Reading payment data from Core Console (console.example.com/console).
// All helpers work BY PAYMENT TOKEN and use the new console flow:
// loginConsole → /console/payin_requests?filters[api_payment_token]=<token> → expand the row.
import { CORE } from './config.js';
import { loginConsole } from './auth.js';

// Backward-compatibility wrapper — old tests expect loginCoreDashboard.
export async function loginCoreDashboard(page) {
  return loginConsole(page);
}

// UI flow: Payins → Add filter → Token → is exactly → <token> → Apply → expand the row.
// Direct URL does not work: after direct navigation, `.w-8` first lands on the sidebar icon,
// not on the row's expand button. The UI flow is slower but reliable (Gateway Attempts load).
async function openConsolePayinByToken(page, token) {
  if (!token) return false;
  // Reset state: go to /console (home), then click the Payins link
  // (direct goto to /console/payin_requests does not trigger the correct JS state,
  //  and then '.w-8 first' lands on the wrong icon).
  await page.goto(`${CORE.baseURL}/console`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.getByRole('link', { name: 'Payins' }).click({ timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: 'Add filter' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole('button', { name: 'Token' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole('button', { name: 'is exactly' }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole('textbox', { name: 'Enter value...' }).fill(token).catch(() => {});
  await page.getByRole('button', { name: 'Apply' }).click({ timeout: 10000 }).catch(() => {});
  // wait for the table row to appear
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  // expand button strictly inside the table row (not somewhere in the sidebar)
  const expand = page.locator('tbody tr').first().locator('.w-8').first();
  await expand.click({ timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // wait for the Route Decision block to appear (expands asynchronously)
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
 * Returns the array of rules from the payment's Route Decision.
 * Each element: { ruleId, gateway, mid, priority, method, filter, limit, param, details }
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
 * Returns the array of gateway attempts for the payment.
 * Each element: { n, ruleId, gateway, status, gatewayToken, mid, error, time, created }
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
 * Returns the rule id from the "Selected: #X" line on the detail page.
 */
export async function getSelectedRule(page, token) {
  if (!await openConsolePayinByToken(page, token)) return null;
  const txt = await page.getByText(/Selected:\s*#?\d+/i).first().textContent().catch(() => null);
  const m = txt?.match(/#?(\d+)/);
  return m ? m[1] : null;
}

/**
 * Returns the MID on which the payment SUCCEEDED (the last Success attempt).
 * null if there is no success attempt (the payment was ultimately declined).
 */
export async function getSuccessMidByToken(page, token) {
  const attempts = await getGatewayAttempts(page, token);
  if (!attempts) return null;
  const success = [...attempts].reverse().find(a => /success/i.test(a.status));
  return success ? success.mid : null;
}

// Legacy stub — no longer used, kept for imports.
export async function findPayinIdByToken(page, { token } = {}) {
  return token || null;
}

/**
 * Full payment summary from console: route decision + gateway attempts + selected.
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
