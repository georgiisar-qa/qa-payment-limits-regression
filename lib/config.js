// ============================================================
// Limit-regression config. Secrets — ONLY from the environment (process.env):
//   locally — from .env (see .env.example), in CI — from GitLab CI/CD Variables (Masked).
// Non-secret identifiers (coreId/MID/rule id) and test cards — inline.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

// Local .env loader (Playwright does not read it itself). CI variables take priority:
// values already set in process.env are NOT overwritten.
(() => {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const env = (name, fallback = '') => process.env[name] ?? fallback;

// SAFETY: if a URL is not sandbox by mistake — fail the tests immediately.
const SANDBOX_MARKER = 'example.com';
export function assertSandbox(url) {
  if (!url.includes(SANDBOX_MARKER)) {
    throw new Error(
      `🚫 PROD PROTECTION: URL "${url}" does not contain "${SANDBOX_MARKER}". ` +
      `These tests are destructive — they create/delete limits and change rules. ` +
      `Run only on sandbox.`
    );
  }
}

// EasyAdmin (settings) — Keycloak login. Credentials: LIMITS_KC_USER / LIMITS_KC_PASS.
export const ADMIN = {
  baseURL: env('LIMITS_ADMIN_URL', 'https://admin.example.com'),
  signInPath: '/session/new',
  email: env('LIMITS_KC_USER'),
  password: env('LIMITS_KC_PASS'),
};

// Core Console — same Keycloak. op2 — second operator for maker-checker.
export const CORE = {
  baseURL: env('LIMITS_CORE_URL', 'https://console.example.com'),
  signInPath: '/dashboard/sessions/new',
  email: env('LIMITS_KC_USER'),
  password: env('LIMITS_KC_PASS'),
  op2: { email: env('LIMITS_KC_OP2_USER'), password: env('LIMITS_KC_OP2_PASS') },
};

// pay-router primary. Default merchant for newPayApi = MERCHANT_PAYIN (coreId 145).
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

// webhook.site for checking callbacks. The token is not a PCI secret, but we keep it in env.
const WEBHOOK_TOKEN = env('LIMITS_WEBHOOK_TOKEN');
export const WEBHOOK = {
  token: WEBHOOK_TOKEN,
  url: WEBHOOK_TOKEN ? `https://webhook.site/${WEBHOOK_TOKEN}` : '',
  apiURL: WEBHOOK_TOKEN ? `https://webhook.site/token/${WEBHOOK_TOKEN}/requests` : '',
};

// Sandbox test cards (public test PANs, not secrets).
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
// ENTITIES — primary entities for limit regression. coreId/id/name — non-secret;
// bearer/apiSecret — from env. A limit with scope=Merchant/Shop accepts ONLY coreId.
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

// Multi-tenant (tenantB/tenantC, USD) for _lim_multitenant / _lim_currency. Secrets — env.
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
