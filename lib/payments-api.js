import { request as apiRequest } from '@playwright/test';
import { PAY_ROUTER, FIXTURES, WEBHOOK } from './config.js';
import { signRequest } from './sign.js';

/**
 * Creates an API context for pay-router.
 * Since 03.06.2026 supports HMAC signing: X-Signature is computed on every request.
 *
 * @param {string|object} [credsOrBearer]
 *   - string: legacy Bearer (no signature; a POST without X-Signature now returns 403 on pay-router)
 *   - object: { bearer, apiSecret } — the normal signed path.
 *     For example: newPayApi(ENTITIES.merchants.PAYIN_VELOCITY)
 */
export async function newPayApi(credsOrBearer) {
  const creds = typeof credsOrBearer === 'object' && credsOrBearer !== null
    ? credsOrBearer
    : { bearer: credsOrBearer || PAY_ROUTER.bearer, apiSecret: null };

  const bearer    = creds.bearer    || creds.token || PAY_ROUTER.bearer;
  const apiSecret = creds.apiSecret || PAY_ROUTER.apiSecret;

  const ctx = await apiRequest.newContext({
    baseURL: creds.baseURL || PAY_ROUTER.baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
  });

  // Return a wrapper that adds X-Signature based on the body on POST/GET.
  return {
    _ctx: ctx,
    async post(path, opts = {}) {
      const bodyStr = opts.data != null ? JSON.stringify(opts.data) : (opts.body || '');
      const { ts, signature } = signRequest({ apiSecret, body: bodyStr });
      return ctx.post(path, {
        headers: { 'X-Timestamp': String(ts), 'X-Signature': signature, ...(opts.headers || {}) },
        data: opts.data,
      });
    },
    async get(path, opts = {}) {
      const { ts, signature } = signRequest({ apiSecret, body: '' });
      return ctx.get(path, {
        headers: { 'X-Timestamp': String(ts), 'X-Signature': signature, ...(opts.headers || {}) },
      });
    },
    async dispose() { await ctx.dispose(); },
  };
}

/**
 * Send a payin. Returns { status, body, orderNumber }.
 * opts: {
 *   amountRub, currency='RUB', orderNumber,
 *   fail=false,                    // cardPayinFail instead of the regular card
 *   cardPan,                       // if set — override the PAN (for BIN-country tests)
 *   card,                          // a fully custom card (takes priority over cardPan/fail)
 *   customer,                      // merged into FIXTURES.customerPayin (can set ip/country/phone/email)
 * }
 */
export async function sendPayment(api, opts) {
  const amountCents = Math.round(opts.amountRub * 100);
  const orderNumber = opts.orderNumber || `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let card;
  if (opts.card) {
    card = opts.card;
  } else {
    const base = opts.fail ? FIXTURES.cardPayinFail : FIXTURES.cardPayin;
    card = opts.cardPan ? { ...base, pan: opts.cardPan } : base;
  }

  const customer = { ...FIXTURES.customerPayin, ...(opts.customer || {}) };

  const res = await api.post(PAY_ROUTER.paymentsPath, {
    ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
    data: {
      product: FIXTURES.product,
      amount: amountCents,
      currency: opts.currency || 'RUB',
      order_number: orderNumber,
      redirect_success_url: FIXTURES.redirectSuccess,
      redirect_fail_url: FIXTURES.redirectFail,
      callback_url: opts.callbackUrl || WEBHOOK.url,
      ...(opts.merchantUrl ? { merchant_url: opts.merchantUrl } : {}),
      customer,
      card,
    },
  });

  const status = res.status();
  const raw = await res.text();
  let body = {};
  try { body = JSON.parse(raw); } catch {}

  return { status, body, orderNumber };
}

/**
 * Send a payout. Returns { status, body, orderNumber }.
 */
export async function sendPayout(api, opts) {
  const amountCents = Math.round(opts.amountRub * 100);
  const orderNumber = opts.orderNumber || `reg-po-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const card = opts.cardPan ? { ...FIXTURES.cardPayout, pan: opts.cardPan } : FIXTURES.cardPayout;

  const res = await api.post(PAY_ROUTER.payoutsPath, {
    ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
    data: {
      product: FIXTURES.product,
      amount: amountCents,
      currency: opts.currency || 'RUB',
      order_number: orderNumber,
      redirect_success_url: FIXTURES.redirectSuccess,
      redirect_fail_url: FIXTURES.redirectFail,
      callback_url: WEBHOOK.url,
      customer: { ...FIXTURES.customerPayout, ...(opts.customer || {}) },
      card,
    },
  });

  const status = res.status();
  const raw = await res.text();
  let body = {};
  try { body = JSON.parse(raw); } catch {}

  return { status, body, orderNumber };
}
