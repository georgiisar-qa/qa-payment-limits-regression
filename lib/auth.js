import { ADMIN, CORE } from './config.js';

export async function loginAdmin(page) {
  if (page.url().startsWith(ADMIN.baseURL) && !page.url().includes('/session/new')) {
    return; // уже залогинен в этой сессии
  }
  await page.goto(ADMIN.baseURL + ADMIN.signInPath);
  // SSO: /session/new -> Keycloak (auth.example.com) -> back to /admin/.
  // Если Keycloak-сессия уже есть (например после loginConsole) — /session/new редиректит
  // СРАЗУ в /admin, кнопки «Continue with Keycloak» нет → её click висел бы до таймаута.
  // Поэтому: если уже ушли с /session/new — считаем, что залогинены; кнопку жмём лишь если видна.
  if (!page.url().includes('/session/new')) return;
  const kc = page.getByRole('button', { name: 'Continue with Keycloak' });
  if (await kc.isVisible({ timeout: 8000 }).catch(() => false)) {
    await kc.click();
    const onKeycloak = await page.waitForURL(/key\.example\.com\/realms\//, { timeout: 8000 })
      .then(() => true).catch(() => false);
    if (onKeycloak) {
      const userInput = page.getByRole('textbox', { name: 'Username or email' });
      if (await userInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await userInput.fill(ADMIN.email);
        await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN.password);
        await page.getByRole('button', { name: 'Sign In' }).click();
      }
    }
  }
  await page.waitForURL(u =>
    u.host.includes('admin.example.com') && !u.pathname.includes('/session/new'),
    { timeout: 40000 }
  ).catch(() => {});
}

// Тенант для ENTITIES_* сущностей — всегда Primary. Список rules/merchants scoped по тенанту,
// без выбора форма создания не привяжет сущности. Кнопка живёт в верхнем свитчере.
export async function selectTenantPrimary(page) {
  const btn = page.getByRole('button', { name: 'Primary', exact: true });
  if (!(await btn.isVisible().catch(() => false))) return;
  const navP = page.waitForNavigation({ timeout: 20000, waitUntil: 'load' }).catch(() => null);
  await btn.click({ noWaitAfter: true });
  await navP;
}

// Универсальный выбор тенанта в EasyAdmin. Switcher-кнопки (Primary/TenantB/TenantC) есть
// только на корне /admin — сначала переходим туда, потом кликаем. Возвращает true при успехе.
export async function selectTenant(page, name) {
  await page.goto('https://admin.example.com/admin', { waitUntil: 'load' });
  const btn = page.getByRole('button', { name, exact: true });
  if (!(await btn.isVisible().catch(() => false))) return false;
  const navP = page.waitForNavigation({ timeout: 20000, waitUntil: 'load' }).catch(() => null);
  await btn.click({ noWaitAfter: true });
  await navP;
  return true;
}

// Core Console (console.example.com/console) — админ-дашборд.
// Логин ТОЛЬКО через Keycloak SSO. Креды — из CORE (env LIMITS_KC_USER / LIMITS_KC_PASS).
export async function loginConsole(page) {
  if (page.url().startsWith(CORE.baseURL) && page.url().includes('/console/') && !page.url().includes('/console/sessions/new')) {
    return;
  }
  await page.goto(CORE.baseURL + '/console/sessions/new');
  // Если SSO уже активна (после loginAdmin) — /sessions/new редиректит сразу в /console/*,
  // кнопки «Continue with Keycloak» нет → её click висел бы до таймаута. Поэтому кликаем ТОЛЬКО
  // если кнопка реально видна; иначе считаем, что уже залогинены.
  if (!page.url().includes('/sessions/new')) return;
  const kc = page.getByRole('button', { name: 'Continue with Keycloak' });
  if (await kc.isVisible({ timeout: 8000 }).catch(() => false)) {
    await kc.click();
    await page.waitForURL(/key\.example\.com\/realms\//, { timeout: 20000 }).catch(() => {});
    const userInput = page.getByRole('textbox', { name: 'Username or email' });
    if (await userInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await userInput.fill(CORE.email);
      await page.getByRole('textbox', { name: 'Password' }).fill(CORE.password);
      await page.getByRole('button', { name: 'Sign In' }).click();
    }
  }
  await page.waitForURL(u =>
    u.host.includes('console.example.com') && !u.pathname.includes('/console/sessions/new'),
    { timeout: 40000 }
  ).catch(() => {});
}

export async function loginCore(page) {
  if (page.url().startsWith(CORE.baseURL) && !page.url().includes('/sessions/new')) {
    return;
  }
  await page.goto(CORE.baseURL + CORE.signInPath);
  await page.getByRole('textbox', { name: /email/i }).fill(CORE.email);
  await page.getByRole('textbox', { name: /password/i }).fill(CORE.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(u => !u.pathname.includes('/sessions/new'), { timeout: 30000 });
}
