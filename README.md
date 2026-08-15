# qa-payment-limits-regression

Playwright **UI + API regression suite** for a payment platform's **limits & velocity** subsystem — deterministic enforcement testing across scopes, cascade routing, schedules, currency, concurrency and multi-tenant isolation.

> Anonymized portfolio extract: domains → `example.com`, generic entity names, **no secrets in code** (all creds via env).

## What it covers — 14 specs, ~49 cases

| Group | Spec | Checks |
|---|---|---|
| Amount | `_limits_suite`, `_lim_amount_acc`, `_lim_boundary_sched` | below/at/over limit, accumulation, inclusive boundary |
| Count / velocity | `_limits_suite`, `_lim_scope_basis` | `count_basis` attempts/success/declines, `by=card_hash/email/brand` |
| on_breach / cascade | `_lim_route` | decline vs fallback, single-MID decline, all-MID exhausted → 422 |
| Scope hierarchy | `_limits_suite`, `_lim_multi` | psp / gateway / merchant / shop / mid resolution + isolation |
| Schedule | `_lim_boundary_sched` | `effective_from/to`, open-ended, overlapping (strictest wins) |
| Window reset | `_lim_window_reset` | minute-window counter reset |
| Currency | `_lim_currency` | limit currency as a matching dimension (no cross-currency apply) |
| Shadow / update | `_lim_update` | shadow observe-only, tighten/loosen & toggle live |
| Concurrency | `_lim_concurrency` | atomic counter under parallel payins — exactly cap, no over-admit |
| Payout | `_lim_payout` | direction isolation, per-card velocity, cascade, idempotency (×10) |
| Idempotency | `_lim_idem` | repeated Idempotency-Key increments counter once |
| Refund | `_lim_refund` | velocity budget not released on refund |
| Multi-tenant | `_lim_multitenant` | per-tenant enforcement + cross-tenant isolation |

## Design highlights (why it's reliable)

- **Config via app, not DB** — limits created/updated/deleted through authenticated form-POST (CSRF token) to the admin panel; login via Keycloak SSO.
- **Enforcement asserted on API responses** (`kind=limit_exceeded`, error contract, correct id) — not on DB fields.
- **Anti-false-positive controls:** negative control (clean-state baseline payin passes) before every block case; armed-gate proving enforcement is live; teardown sweep by a ledger of created IDs (no orphans).
- **Deterministic isolation:** `--workers=1` for shared counters; `value=1/0` for block/no-block; fresh limit starts its counter at arm time.
- **Known-bug cases** assert current behavior + reference the defect, instead of silently passing.

## Run

```bash
npm ci
npx playwright install chromium
cp .env.example .env      # fill test-env creds (see .env.example)
npm run limits            # full suite (~15 min, workers=1)
npx playwright test tests/_lim_payout.spec.js   # single spec
```

## Structure

- `tests/_lim*.spec.js` — one spec per test group.
- `lib/` — `config.js` (entities/creds from env), `sign.js` (HMAC request signing), `payments-api.js` (signed API client), `limits-admin.js` (admin form automation), `auth.js` (Keycloak SSO), `core-dashboard.js` (route-decision / counter scraping).

## Safety

Destructive by design (creates/deletes limits) — guarded by `assertSandbox()`: refuses to run against non-sandbox URLs. Only sandbox/test environments.
