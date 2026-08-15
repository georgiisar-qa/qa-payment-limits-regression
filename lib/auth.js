import { ADMIN, CORE } from './config.js';

export async function loginAdmin(page) {
  if (page.url().startsWith(ADMIN.baseURL) && !page.url().includes('/session/new')) {
    return; // already logged in for this session
  }
  await page.goto(ADMIN.baseURL + ADMIN.signInPath);
  // SSO: /session/new -> Keycloak (auth.example.com) -> back to /admin/.
  // If a Keycloak session already exists (e.g. after loginConsole) — /session/new redirects
  // STRAIGHT to /admin, there is no "Continue with Keycloak" button → clicking it would hang until timeout.
  // So: if we already left /session/new — assume logged in; click the button only if visible.
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

// Tenant for ENTITIES_* entities is always Primary. The rules/merchants list is scoped per tenant;
// without a selection the creation form will not link entities. The button lives in the top switcher.
export async function selectTenantPrimary(page) {
  const btn = page.getByRole('button', { name: 'Primary', exact: true });
  if (!(await btn.isVisible().catch(() => false))) return;
  const navP = page.waitForNavigation({ timeout: 20000, waitUntil: 'load' }).catch(() => null);
  await btn.click({ noWaitAfter: true });
  await navP;
}

// Generic tenant selection in EasyAdmin. Switcher buttons (Primary/TenantB/TenantC) exist
// only at the /admin root — first navigate there, then click. Returns true on success.
export async function selectTenant(page, name) {
  await page.goto('https://admin.example.com/admin', { waitUntil: 'load' });
  const btn = page.getByRole('button', { name, exact: true });
  if (!(await btn.isVisible().catch(() => false))) return false;
  const navP = page.waitForNavigation({ timeout: 20000, waitUntil: 'load' }).catch(() => null);
  await btn.click({ noWaitAfter: true });
  await navP;
  return true;
}

// Core Console (console.example.com/console) — admin dashboard.
// Login ONLY via Keycloak SSO. Credentials — from CORE (env LIMITS_KC_USER / LIMITS_KC_PASS).
export async function loginConsole(page) {
  if (page.url().startsWith(CORE.baseURL) && page.url().includes('/console/') && !page.url().includes('/console/sessions/new')) {
    return;
  }
  await page.goto(CORE.baseURL + '/console/sessions/new');
  // If SSO is already active (after loginAdmin) — /sessions/new redirects straight to /console/*,
  // there is no "Continue with Keycloak" button → clicking it would hang until timeout. So click ONLY
  // if the button is actually visible; otherwise assume already logged in.
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
