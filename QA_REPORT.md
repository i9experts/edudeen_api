# Edudeen API — QA & Hardening Report

Branch: `audit/edudeen-hardening` (53 commits on top of `006ff4a`, **nothing pushed**)
Scope: NestJS 11 + MongoDB (Mongoose 9) multi-vendor marketplace, education-only stores and products.
Method: eight gated phases. Each fix has a proof test that fails on the old code and passes on the new, and each phase stopped for review.

> This report only claims what was actually run. Section 6 lists what was **not** verified.

---

## 1. Result at a glance

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `nest build` | clean |
| Unit suite (`jest --runInBand`) | 43 suites passed, 3 skipped (opt-in real-DB); **441 tests passed**, 29 skipped |
| Real-MongoDB suites (replica set; finance, gift cards, AI credits, invoice refund, admin) | 5 suites, **51/51 passed** |
| Live HTTP smoke (`test/e2e-smoke.ts`, booted app, throwaway DB) | **29/29 checks passed** |
| Live WebSocket check (Phase 5, real Socket.IO client, all 3 gateways) | passed (see 3.5); not re-run in Phase 8 |
| Lint (`eslint src test`) | **8,113 errors / 1,358 warnings** (baseline 8,037 / 1,438) |
| Secrets scan of the branch diff | none found |

**Lint honesty note.** Errors are about 76 above the original baseline (warnings are 80 below). This is mostly `no-unsafe-*` noise from mock-heavy specs and from rewritten legacy services that are still `any`-typed. Every phase repaired its own new files, but the total never got back to baseline. It is not a regression in behaviour, but it is not an improvement either.

## 2. How to run the checks

```bash
npx tsc --noEmit && npm run build
npx jest --runInBand                       # unit suite (real-DB blocks skip themselves)

# real-MongoDB suites: need a REPLICA SET (transactions). The DB name must contain "_it" or "test".
TEST_MONGO_REPLSET_URI='mongodb://127.0.0.1:27018/edudeen_fin_it?replicaSet=rs0' \
TEST_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_x_it?replicaSet=rs0' \
npx jest --runInBand finance.concurrency gift-cards.redeem ai-credits.concurrency invoice-refund.concurrency admin-hardening

# live smoke: seed throwaway accounts, boot the API against a DISPOSABLE db, then
SMOKE_ADMIN_PASSWORD=... SMOKE_SELLER_PASSWORD=... SMOKE_BUYER_PASSWORD=... npm run test:smoke
```

The smoke script writes data (a category, an announcement, an address, a profile rename). It refuses to run against anything but localhost unless `SMOKE_ALLOW_REMOTE=true`. Login is throttled at 10/min per IP, so wait a minute between runs.

## 3. What was fixed, by phase

Severity scale: Critical / High / Medium / Low. Commit hashes are in `git log 006ff4a..HEAD`.

### 3.1 Phase 1 — known open issues
- **Auth:** OTPs are stored as HMAC hashes; errors are mapped consistently; `issueSession` is public; change-password returns a fresh token so the old session is revoked.
- **Manual payments:** payment proofs are now private. Buyers fetch their own via `getOwnProofUrl`, admins via `adminGetProofUrl`.
- **Categories:** `updateCategory`, `reorderCategories` and `deleteCategory` (with `reassignTo`) implemented and tested.
- **Indexes:** 20 duplicate index declarations removed (including `paymentTransaction.Schema.ts`).
- **Bug caught by the live run:** a lint cleanup rewrote `auditMeta` into infinite recursion (500 on admin category writes). Fixed, with a controller test added.

### 3.2 Phase 2 — money modules (all fixes proven on a real replica set)
- **Payouts:** approve, reject and retry are atomic conditional updates.
- **Sales ledger:** `recordSale` is idempotent per order and store.
- **Clearing balances:** `processClearingBalances` is guarded.
- **Redis locks:** owner-token locks (compare-and-delete). Crons fail closed when Redis is down.
- **Checkout:** charge amount is computed server-side (`computeChargeAmount`). A per-checkout claim (`claimCheckoutForPlacement`) stops double placement. A gift card that no longer covers its amount is re-checked at placement.
- **Gift cards:** redemption is an aggregation-pipeline update that clamps the balance and records `redeemedCheckoutIds`. A real-Mongo test caught a retry race, which is fixed.
- **Refunds and returns:** refund-request and return actions are atomic claims with FX conversion.
- **Admin finance jobs:** admin-triggered jobs share the cron lock and are audited.
- **Marketing/discounts:** validation hardened.

### 3.3 Phase 3 — subscriptions, platform plans, AI credits
- **AI credit wallet:** pipeline-atomic, with a bounded ledger. AI Studio uses hold, capture and refund with a `deducted` flag; stale holds are recovered by a cron.
- **Platform plans:** a pending plan change applies only on the paid-invoice webhook. Downgrade to free cancels the Stripe subscription. Stripe idempotency keys are deterministic per billing period.
- **Invoice refunds:** idempotent (`invoice-refund.util.ts`).
- **Entitlements:** limits merge over the fallback.
- **Webhooks:** an event that is still `received` is re-enqueued instead of dropped.

### 3.4 Phase 4 — catalog and education domain
- **Private uploads:** `UploadedAsset` tracks who owns each private Cloudinary asset.
- **Products:** `product-input.util.ts` and `buildDigitalConfig` validate digital-product input; `resolveSubCategoryId` fixed.
- **Live-store rule:** `isStoreLive` is used wherever public content is served.
- **Store, cart, wishlist:** hardened.

### 3.5 Phase 5 — communication, content, SEO, AI
| Sev | Area | Fix |
|---|---|---|
| High | WebSockets (3 gateways) | One shared `WsAuthService`: access-token only, Redis session, `tokenVersion`, account status. `?token=` refused by default. Verified live: a refresh token, a query-string token, no token and a garbage token are all disconnected; an old token is disconnected after a password change; a buyer cannot join another store's activity feed. |
| High | Messaging | Attachment URLs must be Cloudinary https URLs from this account (max 10). Reply quotes are rebuilt from the real parent message. Block rows enforced. Presence scoped to counterparts. |
| High | SEO | The redirect-destination check accepted `/\evil.com`, `/\t/evil.com` and `/%5cevil.com`. Fixed. `Object.assign(doc, dto)` removed. OAuth `redirect_uri` allowlisted. |
| High | Store content | Field allowlists on banner and theme writes. Public theme no longer exposes `draft`. Non-live stores are not publicly readable. Per-store caps of 50 pages and 500 posts. |
| High | Emails | User values escaped in HTML emails. CR/LF stripped from subjects. Contact form can no longer be used as a mail relay. |
| Medium | Activity log, notifications, OTP mailer | Escaped regex, bounded dates, CSV formula guard, device-token cap. OTP mail no longer hard-codes a personal Gmail sender or logs the recipient. |

### 3.6 Phase 6 — admin modules
| Sev | Area | Fix |
|---|---|---|
| High | admin-users | User detail returned the password hash, OTP hash, push token and `tokenVersion`. They are now excluded. |
| High | Suspend cascade | Suspending an already-suspended seller overwrote the restore list with `[]`, so stores could never be restored. The list is now merged (`suspendSellerCascade`) and the session is revoked once. |
| High | Unsuspend | Only a suspended account can be unsuspended (atomic claim, else 409). |
| High | Moderation | Report approve and remove are atomic claims (two admins, exactly one wins), and are put back if the action fails. Removing a review report now actually hides the review. |
| High | Marketplace | A store of a suspended seller can no longer be approved live. |
| Medium | Config | `usdToPkrRate` (what buyers are charged) must sit inside the FX sanity band. FX band min < max is checked after merge. |
| Medium | Marketing | 0-value and already-expired platform coupons rejected. Re-used codes give 409 instead of 500. Ended campaigns no longer block their rotation slot. |
| Medium | Analytics | CSV export had no formula guard. Fixed. |
| Low | All admin lists | `limit` ≤ 100, search escaped and ≤ 100 chars, malformed ids return 400. |

### 3.7 Phase 7 — cross-cutting sweeps
| Sev | Area | Fix |
|---|---|---|
| Critical | NoSQL injection | `verifyOtp`, `resend-otp`, `forgot-password` and `reset-password` took untyped bodies, so `{"email":{"$ne":null}}` matched the first account. On the old code this reached a real account's OTP check. Now strict DTOs, plus a global interceptor that rejects any `$`-prefixed key in a body or query. Proven live before and after. |
| High | Mass assignment | Global `ValidationPipe` now has `whitelist: true`. All validated DTOs were scanned first, and a guard test keeps them valid. |
| High | Addresses | `update-address` wrote the whole body (`userId`, `isDelete`, `status`). Now an allowlist with type and length checks. |
| Medium | Pagination | `clampInt` on page/limit in 27 services. |
| Medium | Scheduler | A failing cron job no longer escapes as an unhandled rejection. It is logged by name. All 25 cron jobs were checked and use `runLocked`. |
| Low | Logging, dead code | SMTP errors and subscriber emails no longer logged. 40 unused imports and 2 dead DTO files removed. |
| Low | Proxy | New opt-in `TRUST_PROXY` env (see decision 3 below). |

## 4. Open decisions (never answered — nothing below was implemented)

Each has a recommendation; none were acted on without your approval.

**Urgent**
1. **Signed Cloudinary URLs never expire (Phase 4).** `expires_at` is only enforced for `private_download_url` or token auth. KYC documents and payment proofs behind signed URLs stay reachable once leaked. Options: stream through the API, enable Cloudinary token auth, or accept it for previews. Recommend streaming KYC and proofs through the API.
2. **Two admin switches do nothing (Phase 6).** No route uses `@RequireFeature`, and nothing reads `maintenanceMode`. Wiring them changes behaviour: `giftCards`, `affiliateProgram` and `bulkProductImport` default to `false` although gift cards already work. Recommend enforcing maintenance mode (default off) and fixing the flag defaults before enforcing flags.

**Security hardening (Phase 7)**
3. **`TRUST_PROXY`.** Behind Railway or a load balancer, set `TRUST_PROXY=1`, otherwise the per-IP throttle shares one bucket across all users and audit logs show the proxy IP.
4. **Global CastError filter.** A malformed id still returns 500 on many routes. Recommend a global filter turning it into 400.
5. **helmet and Swagger.** No security headers are set. helmet would be a new dependency, so it needs approval. Swagger is public at `/api` in every environment. Recommend helmet defaults and Swagger off unless `SWAGGER_ENABLED=true`.

**Product and business**
- **Phase 1:** messaging attachments private vs public; `isListedOnEdudeen` (recommend wiring into marketplace browse, default true, plus a backfill script that is not run); seller-created subcategories (per-store scope with admin promote).
- **Phase 2:** coupon rules (per-user limit, `startsAt`, restore on cancel); gift-card purchase seller credit; platform coupons seller-funded vs platform-funded; shipping requirement; paid is not delivered; partial-cancel seller pay; refund of a pending sale; promotion cancel pro-rating.
- **Phase 3:** early-access and subscriber-only product enforcement (the helper `applyEarlyAccessWindow` is currently unused); cancel at period end for Stripe; pause/resume; domain and white-label sweep on downgrade.
- **Phase 4:** sellers editing buyer name/phone; DNS TXT proof for custom domains; re-review of approved education stores on changes; extra education-only guardrails; a backfill script for `UploadedAsset`.
- **Phase 5:** OAuth `state` nonce (needs a client change); newsletter double opt-in; `?token=` WebSocket default; forwarded-message attribution; whether admins get universal conversation access.
- **Phase 6:** nothing creates `listing`, `seller` or `review` reports, so the marketplace moderation queue can never fill (add a buyer report endpoint, or drop those target types); analytics sums revenue across different currencies (recommend grouping by currency); `aiConfig` and `emailConfig` are stored but nothing reads them.

## 5. Known issues not fixed

All deferred deliberately; none were hidden.
- **Email/newsletter:** newsletter double opt-in and cooldown; unsubscribe is a mutating GET; no retry or dedupe on the mail queue (`sendMail` never throws); `requireTLS`; promotions `notifyAdmins` template escaping unchecked.
- **SEO integrations:** token-refresh race and stuck `syncing` status; `lastError` echoes Google text; Bing key sent in a URL; bulk AI `entityIds` uncapped; sitemap stale chunks and duplicate URLs.
- **Media:** no MIME sniffing in the media library.
- **Messaging:** `getConversationById` exposes the buyer's email to the seller; edit/delete do not update `lastMessage`; FCM `data` values must be strings.
- **Admin:** a store suspended by moderation while its seller was suspended is also restored on unsuspend (needs a per-store marker).
- **Dead code:** unreferenced DTO classes remain in `orders/dto`, `products/dto`, `otp/dto` and `cart/dto/validate-cart-response.dto.ts`. They look like validation but are never applied; delete or wire them.
- **Throttler:** storage is per-instance memory, so limits multiply with the number of instances.
- **Types:** 5 unused constructor-injected members and many `any`-typed legacy paths remain (the source of most lint errors).

## 6. Not verified

- **Real third parties:** Stripe (no keys, webhooks and payments only with mocks), Cloudinary (only the cloud-name rule), SMTP, FCM, and Google/Bing OAuth.
- **Clients:** no web or mobile client was run against the API. The whitelist, operator-key guard, stricter DTOs and WebSocket token rule can break a client that relies on the old looseness.
- **Production behaviour:** `TRUST_PROXY` behind a real proxy; a multi-instance deployment; real load or timing.
- **Smoke coverage:** the HTTP smoke does not cover payments, checkout, stores, products or the WebSocket gateways. The gateways were verified live in Phase 5 with a script that was not kept in the repo. The smoke script was never run against the original baseline, so there is no "fails before" run for it; the per-fix proof tests are what show before/after.
- **Data:** no migration or backfill script was run. Every proposed one (`isListedOnEdudeen`, `UploadedAsset`) is only described, not written or run against any real database.
- **Dependencies:** `npm audit` was not run, and no dependency was added.

## 7. Breaking changes for frontend and mobile

Collected from all phases. Items marked * are the likeliest to break a client.

- *Unknown fields are silently dropped on every DTO endpoint (`whitelist: true`).
- *Any `$`-prefixed key in a request body or query returns 400.
- *WebSockets: the token must be sent in `auth.token`; `?token=` is refused (the Flutter app already sends `auth.token`).
- *`resend-otp` and `verifyOtp` take only `user` or `seller` roles; `forgot-password` and `reset-password` take `user`, `seller` or `admin`. Emails must be valid, OTPs exactly 6 characters.
- *`page`/`limit` are clamped (limit ≤ 100); admin lists reject `limit` > 100 and `search` > 100 characters.
- *Change-password returns a new token in `data.token`; the old session is revoked.
- Messaging: attachments must be Cloudinary https URLs from this account (max 10), text ≤ 4000, reply and forward payloads are built by the server; duplicate reports return 409.
- SEO: stricter redirect destinations; OAuth `redirectUri` must be on an allowed origin.
- Store content: banner links and blog/OG images must be https; the public theme no longer includes `draft`; per-store caps of 50 pages and 500 posts; store-banner update ignores unknown fields.
- Admin: user detail no longer includes credential fields; unsuspending a non-suspended account and re-actioning a resolved report return 409; featuring a non-active listing returns 400; platform coupon codes must be 3–32 characters of letters, digits, `-` or `_`; campaign `bannerImage` must be https; `usdToPkrRate` must be inside the FX sanity band; the public announcements feed no longer returns `createdBy`.
- Addresses: `update-address` accepts only address fields and cannot touch deleted addresses.
- Cart/search: `clear-cart`, `clear-wishlist`, `remove-from-wishlist` and `recently-viewed` need valid 24-character ids.
- Money flows (Phases 2–3): see the commit messages for the exact changes to checkout totals, gift-card redemption, payouts and plan changes.

## 8. Environment used

macOS, Node 26.3, MongoDB 8.3.4 (a throwaway single-node replica set on port 27018 for the integration and smoke runs; the shared instance on 27017 was never written to), Redis 8.6.3. Every database used during QA had an `edudeen_*` name and was disposable. No non-local database was touched.
