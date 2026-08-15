// ============================================================
// Конфиг лимит-регресса. Секреты — ТОЛЬКО из окружения (process.env):
//   локально — из .env (см. .env.example), в CI — из GitLab CI/CD Variables (Masked).
// Несекретные идентификаторы (coreId/MID/rule id) и тестовые карты — inline.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

// Локальный загрузчик .env (Playwright сам его не читает). CI-переменные имеют приоритет:
// уже заданные в process.env НЕ перезаписываются.
(() => {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const env = (name, fallback = '') => process.env[name] ?? fallback;

// SAFETY: если где-то по ошибке URL не sandbox — роняем тесты сразу.
const SANDBOX_MARKER = 'example.com';
export function assertSandbox(url) {
  if (!url.includes(SANDBOX_MARKER)) {
    throw new Error(
      `🚫 PROD PROTECTION: URL "${url}" не содержит "${SANDBOX_MARKER}". ` +
      `Эти тесты разрушительны — создают/удаляют лимиты и меняют rules. ` +
      `Запускать только на sandbox.`
    );
  }
}

// EasyAdmin (settings) — Keycloak-логин. Креды: LIMITS_KC_USER / LIMITS_KC_PASS.
export const ADMIN = {
  baseURL: env('LIMITS_ADMIN_URL', 'https://admin.example.com'),
  signInPath: '/session/new',
  email: env('LIMITS_KC_USER'),
  password: env('LIMITS_KC_PASS'),
};

// Core Console — тот же Keycloak. op2 — второй оператор для maker-checker.
export const CORE = {
  baseURL: env('LIMITS_CORE_URL', 'https://console.example.com'),
  signInPath: '/dashboard/sessions/new',
  email: env('LIMITS_KC_USER'),
  password: env('LIMITS_KC_PASS'),
  op2: { email: env('LIMITS_KC_OP2_USER'), password: env('LIMITS_KC_OP2_PASS') },
};

// pay-router primary. Дефолтный мерч для newPayApi = MERCHANT_PAYIN (coreId 145).
// HMAC: Authorization: Bearer <bearer>; X-Timestamp: <unix-sec>;
//       X-Signature: hex(HMAC-SHA256(apiSecret, "<ts>.<body>")).
export const PAY_ROUTER = {
  baseURL: env('LIMITS_BASE_URL', 'https://payments.example.com'),
  bearer: env('LIMITS_PAYIN_BEARER'),
  apiSecret: env('LIMITS_PAYIN_SECRET'),
  token: env('LIMITS_PAYIN_BEARER'), // legacy alias
  paymentsPath: '/api/v1/payments',
  payoutsPath: '/api/v1/payouts',
  balancesPath: '/api/v1/balances',
};

// webhook.site для проверки callback'ов. Токен — не PCI-секрет, но держим в env.
const WEBHOOK_TOKEN = env('LIMITS_WEBHOOK_TOKEN');
export const WEBHOOK = {
  token: WEBHOOK_TOKEN,
  url: WEBHOOK_TOKEN ? `https://webhook.site/${WEBHOOK_TOKEN}` : '',
  apiURL: WEBHOOK_TOKEN ? `https://webhook.site/token/${WEBHOOK_TOKEN}/requests` : '',
};

// Тестовые карты sandbox (публичные тест-PAN, не секреты).
export const FIXTURES = {
  cardPayin: { pan: '4392963203551251', holder: 'TEST HOLDER', cvv: '111', expires: '11/2029' },
  cardPayinFail: { pan: '4730198364688516', holder: 'TEST HOLDER', cvv: '111', expires: '11/2029' },
  cardPayout: { pan: '4627342642639018', expires: '11/2029' },
  customerPayin: { email: '178984441@gmail.com', ip: '213.196.39.16', phone: '77777777777' },
  customerPayout: { email: '178984441@gmail.com', ip: '213.196.39.16' },
  product: 'Your Product1',
  redirectSuccess: 'https://success.example.com/',
  redirectFail: 'https://declined.example.com/',
};

// ============================================================
// ENTITIES — сущности primary под лимит-регресс. coreId/id/name — несекретные;
// bearer/apiSecret — из env. Лимит scope=Merchant/Shop принимает ТОЛЬКО coreId.
// ============================================================
export const ENTITIES = {
  merchants: {
    PAYIN: {
      id: 267, coreId: 145, name: 'MERCHANT_PAYIN',
      bearer: env('LIMITS_PAYIN_BEARER'), apiSecret: env('LIMITS_PAYIN_SECRET'), token: env('LIMITS_PAYIN_BEARER'),
    },
    PAYOUT: {
      id: 268, coreId: 149, name: 'MERCHANT_PAYOUT',
      bearer: env('LIMITS_PAYOUT_BEARER'), apiSecret: env('LIMITS_PAYOUT_SECRET'), token: env('LIMITS_PAYOUT_BEARER'),
    },
  },
  shops: {
    PAYIN_A: {
      id: 270, coreId: 146, name: 'SHOP_A', merchantId: 267,
      bearer: env('LIMITS_SHOP_A_BEARER'), apiSecret: env('LIMITS_SHOP_A_SECRET'), token: env('LIMITS_SHOP_A_BEARER'),
    },
    PAYIN_B: {
      id: 271, coreId: 147, name: 'SHOP_B', merchantId: 267,
      bearer: env('LIMITS_SHOP_B_BEARER'), apiSecret: env('LIMITS_SHOP_B_SECRET'), token: env('LIMITS_SHOP_B_BEARER'),
    },
  },
};

// Мультитенант (tenantB/tenantC, USD) для _lim_multitenant / _lim_currency. Секреты — env.
export const TENANTS = {
  tenantB: {
    name: 'TenantB', base: env('LIMITS_TENANT_B_URL', 'https://payments-b.example.com'),
    cur: 'USD', shopCore: 35,
    bearer: env('LIMITS_TENANT_B_BEARER'), apiSecret: env('LIMITS_TENANT_B_SECRET'),
  },
  tenantC: {
    name: 'TenantC', base: env('LIMITS_TENANT_C_URL', 'https://payments-c.example.com'),
    cur: 'USD', shopCore: 68,
    bearer: env('LIMITS_TENANT_C_BEARER'), apiSecret: env('LIMITS_TENANT_C_SECRET'),
  },
};
