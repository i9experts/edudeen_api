# Deploy checklist — `jami-branch` → production

Everything between the audit base `006ff4a` and `HEAD` of `jami-branch`: the QA/hardening audit (53 commits, see
`QA_REPORT.md`), the seven bundle commits (security, digital delivery, uploads, store approval, store-theme fix,
scope cleanup, verified reviews), and Phases 1–3 of the unified cart / single checkout work (unified cart, multi-store
checkout, per-store shipping, fulfillment mode, COD money fix, gift-card restore, free orders).

**Nothing here has been deployed anywhere.** Treat every "verified" below as "verified on a local throwaway
database / Stripe test mode", not on staging or production (see §5 for what was *not* verified).

---

## 1. Environment variables

Set these in the production environment **before** the new build starts. Never commit values.

### Must be reviewed / set

| Variable | Why | Notes |
|---|---|---|
| `NODE_ENV=production` | CORS denies `localhost` origins in production; the seed script refuses to run. | Already expected, double-check. |
| `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET` (live) | Payments and webhook signature check. | In live mode `STRIPE_WEBHOOK_SECRET_TEST` is ignored. Keys are being rotated — use the new ones. |
| `TRUST_PROXY` (e.g. `1`) | Behind Railway / a load balancer, without it the per-IP throttle shares one bucket for all users and audit logs record the proxy IP. | New. A hop count, or `true`/`false`. |
| `GOOGLE_CLIENT_IDS` | Comma-separated Google client IDs (Android, iOS, web each have their own). Falls back to `GOOGLE_CLIENT_ID`. | Changed (social-login hardening). **Include every client ID your apps use**, or Google sign-in will be rejected. |
| `SMTP_FROM` (or `SMTP_USER`), `APP_NAME` | OTP mail is now sent from the configured sender instead of a hard-coded personal Gmail address. | Changed. Without a valid sender OTP emails fail. |
| `WEB_APP_URL` | Base URL used in emails and as an allowed OAuth origin (default `https://www.edudeen.com`). | New. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CLOUDINARY_*`, `MONGO_URI`, `REDIS_URL` | Unchanged names. | Confirm present. Rotate any secret that has ever been printed in a log/terminal. |

### Behaviour switches (defaults are the safe choice)

| Variable | Default | Effect |
|---|---|---|
| `STORE_SELF_SERVE_ACTIVATION` | unset = **off** | **Behaviour change:** new stores now wait for admin approval. Set `true` only to restore instant activation. Make sure an admin is actually working the approval queue. |
| `FREE_ORDERS_PER_USER_PER_DAY` | `20` | Cap on free-checkout orders per buyer per rolling 24 h. |
| `WS_ALLOW_QUERY_TOKEN` | unset = off | Allows `?token=` on WebSockets. Leave unset (the Flutter app sends `auth.token`). |
| `PLATFORM_DOMAINS` | none | Extra comma-separated hostnames a store may never claim. |
| `SEO_OAUTH_REDIRECT_URIS` | none | Exact URLs/origins allowed as SEO OAuth `redirectUri`. Required if the SEO integrations are used. |
| `PUBLIC_TRIAL_DAILY_CAP` | built-in default | Daily cap for the public worksheet trial. |

### CI / tooling only (not for production)

`TEST_MONGO_URI`, `TEST_MONGO_REPLSET_URI` (integration specs; the database name must contain `_it` or `test`),
`SMOKE_BASE_URL`, `SMOKE_MONGO_URI`, `SEED_*`. Do **not** set them on the production service.

---

## 2. Breaking changes for the mobile and web apps

Apps built before this release keep working for the checkout flows (see "Compatible" at the end), but these changes can
affect them. Items marked ★ are the likeliest to break a client.

### From the audit (full list in `QA_REPORT.md` §7)

- ★ Unknown fields are silently dropped on every DTO endpoint (global `whitelist: true`).
- ★ Any `$`-prefixed key in a request body or query returns 400.
- ★ WebSockets: the token must be sent in `auth.token`; `?token=` is refused.
- ★ OTP: `resend-otp` / `verifyOtp` accept only `user` or `seller`; `forgot-password` / `reset-password` accept `user`, `seller`
  or `admin`. Emails must be valid; OTPs exactly 6 characters.
- ★ `page`/`limit` are clamped (limit ≤ 100); admin lists reject `limit` > 100 and `search` > 100 characters.
- ★ Change-password returns a new token in `data.token`; the old session is revoked.
- ★ **Reviews require a verified purchase** (digital buyers now qualify).
- ★ **New stores need admin approval** (unless `STORE_SELF_SERVE_ACTIVATION=true`).
- **Removed:** the POS module, legacy platform-subscriptions, the dead OTP controller, the staff-seat add-on. Store types are
  restricted to education-relevant ones. Any client still calling those endpoints/types will get 404/400.
- Uploads: public and private uploads are checked against extension + MIME allowlists.
- Digital delivery: one access check for all downloads; refund revokes access; download counting is atomic.
- ★ **Social login now verifies the provider's token on the server** and takes the email from the provider, never from the request body
  (fixes an account-takeover hole). The app must send the provider `token`; without it the API answers 401 "Missing provider token for
  verification". The token's audience must be one of `GOOGLE_CLIENT_IDS`.
- Cart quantity and price validation, and CORS, are stricter (CORS allows `edudeen.com`, `*.edudeen.com`, and
  `localhost` only outside production).
- Messaging, SEO, store content, admin and address endpoints are stricter (details in `QA_REPORT.md` §7).

### New in Phases 1–3

| Area | Change | Client action |
|---|---|---|
| Unified cart | New `GET /api/cart/unified[?currency=]` (flat lines, per-store subtotals, grand total in display currency; `null` totals if rates are unavailable) and `POST /api/cart/clear-all`. `get-cart`/`my-carts` lines gain a `currency` field. | Cart screen can switch to `unified`. |
| Checkout | `POST /api/checkout/create-checkout`: `storeId` is **optional**. Without it, all of the buyer's store carts are checked out together (max 20 stores / 100 lines). Items from inactive stores are skipped and returned in `data.unavailableItems[]` (they stay in the cart); 400 if nothing is left. | Show `unavailableItems`; omit `storeId` on the main marketplace. |
| Orders | A checkout now produces **up to 2 Orders** (digital + physical, linked by `checkoutId`), each with one `sellerOrder` per store. | Render several `sellerOrders` per Order, and possibly two Orders per purchase. |
| Shipping | One shipping line **per store with physical items** (`shippingByStore[]` in the `addShippingInCheckout` response; `sellerOrder.shippingFee`). A multi-store physical cart now costs more than before (zone fee × stores). A digital-only checkout has **no** shipping. | Show per-store shipping; do not assume one fee. |
| COD | Offered only when all physical items are from **one** store (also enforced server-side, including 'split'). `allowedPaymentMethods` reflects it. | Hide COD when absent. |
| Free orders | `allowedPaymentMethods` is `['free']` when the total is 0. New `POST /api/payment/free-checkout {checkoutId}` places the order (new `paymentType: "free"`). `initiatePayment` and bank transfer reject a 0 total. | Call it when `totalAmount` is 0 after a coupon / gift card. Handle `paymentType: "free"` in order screens and filters. |
| Coupons / gift cards | **One coupon and one gift card per checkout.** A store coupon / gift card affects only that store's items; a platform coupon affects all. | Keep one code field each. |
| Fulfillment | Stores have `fulfillmentMode` (`seller` default). Sellers can only choose `seller`; an admin grants `platform` (`PATCH /api/admin/marketplace/stores/:id/fulfillment-mode`). On Edudeen-fulfilled sub-orders sellers get 403 on `update-status`, and `mark-paid` is admin-only. | Seller app: handle the 403 and hide status controls for those sub-orders. |
| Cancel / refund | Cancelling a store's last item refunds that store's shipping line. Gift-card value that paid for cancelled/refunded/returned items goes back on the card. Refunding a free order moves no money but revokes access. | — |

### Money changes for sellers (communicate before release)

- **COD paid to the seller's own courier no longer credits the sale.** Marking it paid *debits the commission* instead;
  the seller's balance can go **negative** and payouts are blocked until later sales cover it. A COD return credits the
  commission back (proportionally). Platform-fulfilled COD is unchanged.
- **Breaking for all sellers:** a refund overdraft held in pending balance is no longer forgiven when a later sale clears —
  it is netted against the sale being released.
- Seller-fulfilled stores are credited their shipping line (no commission) on card/bank-transfer orders.
- Card fee is charged on sale + shipping; commission on the sale only.

### Compatible

Requests that still send `storeId` to `create-checkout` (store-subdomain checkout), the per-store cart endpoints and
`my-carts` behave as before.

---

## 3. Data and staging checks

### Data
- **No migration is required.** All new fields are additive with safe defaults (`Store.fulfillmentMode` = seller;
  `sellerOrder.fulfillmentMode` / `shippingFee` / `settlementShippingFee`; `Checkout.shippingByStore`;
  `GiftCard.restoredRefKeys`; `'free'` added to payment-type enums). Documents without them behave as seller-fulfilled.
- **Size the COD exposure first.** Before this fix, a COD sale marked paid was credited to the seller although the platform never
  received the cash. Run the read-only report **yourself** against a production read replica/secondary (it only reads):
  `mongosh "<production connection string>" --quiet --file scripts/cod-exposure-report.mongosh.js`
  (optional `--eval 'var SINCE="2026-01-01"'`, `--eval 'var DETAIL=true'`).
  Decide on a corrective action (debit or clawback) — **none is implemented**, and the fix only changes behaviour going forward.
- Take a database snapshot/backup before deploying.
- Proposed backfills that were **never written or run** (see `QA_REPORT.md` §4): `isListedOnEdudeen`, `UploadedAsset`.
- A Redis dump (`dump.rdb`, ~3.7 KB) is tracked in the repo. Its contents were not inspected. Remove it from git
  (`git rm --cached dump.rdb`, add to `.gitignore`) after checking it holds nothing sensitive.

### Staging (do all of these; each was only exercised locally)
1. Deploy the branch to staging with production-like env (live-like Stripe **test** keys, real Cloudinary, SMTP, Redis, an Atlas replica set).
2. **Real Stripe webhook:** with the Stripe CLI (`stripe listen --forward-to .../api/payment/stripe-webhook`) pay a multi-store cart and confirm
   the order is created by the *webhook* (the local smoke used the status-polling fallback). Replay the event and confirm no second order.
   Configure the endpoint to send `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`.
3. **Real Cloudinary download** of a purchased digital file (the local smoke only checked that download links are issued), and a refund revoking it.
4. Run `npm run test:smoke` and `npm run test:smoke:checkout` (the latter refuses non-local databases — run it against a local copy of the build, or adapt its guard for staging deliberately).
5. Manual: 1 digital + 2 physical stores, platform coupon, per-store shipping, pay, partial cancel/refund of one sub-order; a single-store COD order marked paid (seller balance goes down by the commission, payout request rejected); a COD return; a free item; a gift-card purchase and cancel (balance restored).
6. Old app builds: store-subdomain checkout with `storeId`, and an old build against the new API (the ★ list above).
7. Exchange rates: a fresh PKR rate exists (cross-currency checkout is refused on stale rates); shipping zones exist; the admin approval queue for new stores is staffed.
8. CI: add a Mongo **replica set** service and set `TEST_MONGO_REPLSET_URI` / `TEST_MONGO_URI` so the money integration specs (COD ledger, shipping credit, gift-card restore, payout/refund concurrency) actually run — in a normal `npm test` they are skipped.
9. Full suite: `npm test` (jest is capped at 2 workers) and the replica-set suites.

---

## 4. Deploy order

1. **Prepare:** CI green (including the replica-set suites); database backup; production env set per §1 (rotated Stripe keys, `TRUST_PROXY`, `GOOGLE_CLIENT_IDS`, SMTP sender).
2. **Staging pass** (§3) and sign-off. Run the COD exposure report and decide on remediation.
3. **Tell sellers** about the COD / refund-netting / shipping changes (§2), and staff the store-approval queue.
4. **Deploy the API** in a short window. The schema changes are additive, so old and new instances can coexist, but during the overlap an old
   instance still credits COD sales — keep the overlap brief.
5. **Stripe:** confirm the live webhook endpoint and secret are the rotated ones and the four event types are enabled.
6. **Post-deploy checks (read-only):** `GET /health/live`; log in; `GET /api/cart/unified`; place one real low-value order and refund it.
7. **Release the mobile and web apps after the API** (the API stays compatible with old builds; the new cart/free/shipping UI needs the new endpoints).
8. **Monitor the activity log / alerts** for the first days: `seller_balance_negative`, `gift_card_shortfall`, `gift_card_restore_failed`,
   `stripe_payment_without_transaction`, `payment_amount_currency_mismatch`, `coupon_usage_limit_exceeded`, `manual_refund_required`.

**Rollback notes:** rolling back the code reintroduces the COD credit bug. Documents written with the new fields stay valid for the old code,
but orders/transactions with `paymentType: "free"` would fail validation if the old code re-saves them. Negative seller balances created by the
new COD rule remain and would need handling.

---

## 5. Not verified yet / open items

Not verified (local throwaway DB + Stripe test mode only): a real webhook delivery, a real Cloudinary download, staging behind a real proxy,
a multi-instance deployment (the throttler store is per-instance memory), platform-fulfilled orders end-to-end, and any web/mobile client run
against these changes.

Follow-ups (not built):
- Reduce a cart line's quantity on cleanup instead of removing the whole line.
- Staging test of a real Stripe webhook delivery (Stripe CLI) and a real Cloudinary download (§3).
- Seller requests platform shipping → admin approves.
- One combined buyer email for mixed carts (currently one per Order).
- Per-store analytics / banner attribution.
- Refund shipping on returns (today only a cancel refunds it).
- Restore coupon usage on cancel.
- Corrective ledger action for COD sales already credited (needs the exposure report first).
- Admin-config field for the free-order cap (today an env var); an exact (not best-effort) daily cap.
- Open decisions in `QA_REPORT.md` §4 (signed Cloudinary URLs, admin feature flags, CastError filter, helmet/Swagger).
