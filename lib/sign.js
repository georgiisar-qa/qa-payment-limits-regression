// ============================================================
// HMAC request signing (с 03.06.2026 на pay-router)
// Контракт подписи:
//   signing_string = "<ts>.<body>"  где ts = unix-секунды (int)
//   X-Signature    = hex(HMAC-SHA256(api_secret, signing_string))  lowercase
//   X-Timestamp    = <ts>
//   Authorization  = "Bearer <bearer>"
// Окно валидности — ~10 минут (за пределами → 403 Stale signature).
// body для GET = пустая строка; для POST — ровные байты JSON как отправляешь.
// ============================================================
import crypto from 'node:crypto';

/**
 * @param {object} opts
 * @param {string} opts.apiSecret — секрет для подписи (из ENTITIES.merchants[*].apiSecret)
 * @param {string} [opts.body=''] — тело HTTP-запроса как есть (для GET — '')
 * @param {number} [opts.ts]      — unix-секунды (если не задан — Date.now()/1000)
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
 * Готовые HTTP-заголовки для подписанного запроса.
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
 * Верификация входящего webhook-колбэка от core.
 * Использует webhook_secret (а не api_secret).
 * @returns {boolean}
 */
export function verifyWebhook({ webhookSecret, ts, body, receivedSignature }) {
  const { signature } = signRequest({ apiSecret: webhookSecret, body, ts: Number(ts) });
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(receivedSignature, 'hex'),
  );
}
