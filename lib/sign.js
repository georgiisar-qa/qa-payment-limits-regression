// ============================================================
// HMAC request signing (since 03.06.2026 on pay-router)
// Signature contract:
//   signing_string = "<ts>.<body>"  where ts = unix seconds (int)
//   X-Signature    = hex(HMAC-SHA256(api_secret, signing_string))  lowercase
//   X-Timestamp    = <ts>
//   Authorization  = "Bearer <bearer>"
// Validity window — ~10 minutes (outside it → 403 Stale signature).
// body for GET = empty string; for POST — the exact JSON bytes you send.
// ============================================================
import crypto from 'node:crypto';

/**
 * @param {object} opts
 * @param {string} opts.apiSecret — the signing secret (from ENTITIES.merchants[*].apiSecret)
 * @param {string} [opts.body=''] — the HTTP request body as-is (for GET — '')
 * @param {number} [opts.ts]      — unix seconds (if not set — Date.now()/1000)
 * @returns {{ts: number, signature: string, signingString: string}}
 */
export function signRequest({ apiSecret, body = '', ts }) {
  ts = ts ?? Math.floor(Date.now() / 1000);
  const signingString = `${ts}.${body}`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signingString)
    .digest('hex');
  return { ts, signature, signingString };
}

/**
 * Ready-made HTTP headers for a signed request.
 * @param {object} opts — {bearer, apiSecret, body}
 * @returns {object} headers — {Authorization, X-Timestamp, X-Signature, Content-Type}
 */
export function authHeaders({ bearer, apiSecret, body = '' }) {
  const { ts, signature } = signRequest({ apiSecret, body });
  return {
    Authorization:  `Bearer ${bearer}`,
    'X-Timestamp':  String(ts),
    'X-Signature':  signature,
    'Content-Type': 'application/json',
  };
}

/**
 * Verification of an incoming webhook callback from core.
 * Uses webhook_secret (not api_secret).
 * @returns {boolean}
 */
export function verifyWebhook({ webhookSecret, ts, body, receivedSignature }) {
  const { signature } = signRequest({ apiSecret: webhookSecret, body, ts: Number(ts) });
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(receivedSignature, 'hex'),
  );
}
