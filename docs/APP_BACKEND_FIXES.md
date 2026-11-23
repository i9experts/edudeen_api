# App backend fixes (branch `jami-branch`)

Gaps the mobile app (edudeen-app, branch `full-app`) found while aligning
with the API. One commit per fix, each with a spec. All responses keep
`{ success, data }`; new fields are additive.

**Web impact:** the `edudeen_web` source was not available when these were
written, so web call sites could not be grepped. Each fix lists the web
behaviour it could touch; items marked **check web** should be confirmed
before merging.

| # | Fix | Route(s) | Web impact |
|---|---|---|---|
| 1 | Bad id 400 | refund-request | none (only malformed ids change) |
| 2 | Bad id 400, long titles 400 | courses seller builder | **check web**: titles over 120/150 now 400 instead of being cut |
| 3 | Store settings validation | `POST /api/store/update-store` | **check web**: province spelling, province without city |
| 4 | Free sample to publish | product create/update | matches the web's own rule |
| 5 | Premium earnings | `GET finance/:storeId/fee-estimate` | none (additive) |
| 6 | Buyer review report | new routes | none (new) |
| 7 | usedFor + photos | `GET rating/my-reviews` | none (additive) |
| 8 | Buyer-only buy-now | `GET cart/buy-now` | none if the web blocks sellers already |
| 9 | Retired routes 410 | `api/seller/manual-payments/*` | none (already 410) |
| 10 | Delete unused private file | new route | none (new) |
| 11 | Payout schedule read-only | `GET/PATCH finance/:storeId/payout-schedule`, dashboard | **check web**: PATCH without `currency` |
| 12 | Maintenance states | docs + spec only | none |

---

## 1. Refund-request ids

`PATCH /api/refund-request/:id/approve|reject|follow-up`,
`GET /api/refund-request/order/:orderId`, `GET /api/refund-request/seller/:storeId`

- Before: a malformed id reached Mongoose and gave **500** (CastError).
- After: **400** `{ message: "Invalid id" }` (`ParseObjectIdPipe`). A
  well-formed unknown id keeps **404** "Refund request not found" /
  "Order not found".

## 2. Course builder / roster

`GET|PUT /api/courses/seller/:storeId/:productId`,
`GET .../:productId/students`, `GET .../:productId/lessons/:lessonId/voice`

- Before: a bad `storeId` / `productId` gave **500** (e.g.
  `/seller/product/<id>`, `/seller/students/<id>`). Section titles were
  cut to 120 and lesson titles to 150 characters with no error.
- After: bad ids **400** "Invalid id" (roster routes already did this).
  Over-long titles **400**:
  - `Section 2 title must be at most 120 characters`
  - `Lesson 1 in "Week 1" title must be at most 150 characters`
  Limits: `COURSE_LIMITS.sectionTitle` / `lessonTitle`.

## 3. Store settings (`POST /api/store/update-store`)

Only update-store; create-store is unchanged.

| Field | Before | After (400 message) |
|---|---|---|
| `productTypes: []` | saved, store sells nothing | "Choose at least one product type for your store" |
| `productTypes: "x"` (not a list) | saved | "productTypes must be a list" |
| `codEnabled: "x"` | saved as `true` | "codEnabled must be true or false" |
| `shipFrom.province: 5` / unknown | saved as `"5"` | "shipFrom.province must be one of: Sindh, Punjab, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Kashmir" |
| `shipFrom: { province }` no city | silently cleared to null | "Choose the city you ship from for this province" |

Province matching is case-insensitive and stored with the canonical
spelling (same list as addresses, `PK_PROVINCES`). `shipFrom: null` or an
empty city with no province still clears it.

## 4. Free sample required to publish a digital download

Product create (digital) and update.

- Before: the server published a digital download without a free sample.
- After: going live (`active` / `scheduled`) with `deliveryFormat:
  "download"` and no `digital.sampleFile` is **400** "Add a free sample
  file before publishing a digital product. You can save it as a draft
  without one."
- Exempt: drafts / inactive, physical products, re-saving an
  already-live listing unchanged (legacy listings keep working, same as
  the cover-style rule), pause/resume and bulk-status (they only restore
  formerly-live listings).
- **Courses: exempt** (they already need at least one lesson and offer
  preview lessons). The web source was not available to confirm the
  web's course rule - **check web**.

## 5. Fee estimate at the Premium member price

`GET /api/finance/:storeId/fee-estimate?price&type[&currency][&premiumPercent | &productId]`

- Before: any premium input was ignored.
- After: with `premiumPercent` (1-50, the seller's member discount) or
  `productId` (product override, else the store's Premium setting;
  opt-out = none) the response gains:

```json
"premium": {
  "memberPrice": 800, "sellerPercent": 15, "platformPercent": 5,
  "memberDiscountPercent": 20, "platformFunded": 50,
  "saleValue": 850, "feePercent": 7, "fee": 59.5, "net": 790.5
}
```

  `premium: null` when no member price applies (e.g. opt-out). Without the
  new params the response is unchanged. Same money logic as a real
  premium sale (`premiumLinePrice`; credited sale value = member price +
  platform-funded part, as `recordSale`'s `saleAmount`; the admin's
  premium sale fee % via `perTypePlatformFee`). Card processing is not
  included (same as the existing estimate). 400 on a bad percent /
  productId, 404 for a product of another store.

## 6. Buyer review report

New:
- `POST /api/rating/:reviewId/report-by-buyer` (role `user`, 10/min)
  body `{ reasonCode, text? }` -> 201
  `{ success, message: "Thanks. Edudeen will look at this review.", data: { reportId, status: "pending" } }`
- `GET /api/rating/report-reasons` (public) ->
  `[{ code, label, needsText }]`: abusive, off_topic, personal_info, spam,
  wrong_product, other (other needs 5+ characters; text max 300).

Rules: 409 "You already reported this review" (one per buyer per review,
also enforced by the partial unique index `one_buyer_report_per_review`
on `reports`); 429 after 20 buyer reports in 24 h; 400 for your own
review, bad reason or id; 404 unknown review; 403 for a seller token.
Admin visibility: it is a normal `Report` (`targetType: review`,
`reporterRole: user`), so it shows in Admin -> Content Moderation, where
Remove deletes the review. Audit log action `review_reported_by_buyer`.
The seller route `POST :reviewId/report` is unchanged.

## 7. my-reviews

`GET /api/rating/my-reviews` rows gain `usedFor` (`home` | `classroom` |
`school` | null) and `photos` (string[], same URLs as `media`).

## 8. buy-now buyer-only

`GET /api/cart/buy-now`: before, any logged-in role got 200; after, a
seller or admin token gets **403** "Access Denied: Insufficient role"
(same guard as `POST /api/checkout/create-checkout`).

## 9. Retired seller manual-payments

Every method and path under `/api/seller/manual-payments` answers **410**
"Bank transfers are now paid to Edudeen and confirmed by the Edudeen team
— sellers no longer set up or confirm direct payments." Before, `PUT
settings` could answer 400 (DTO validation) and a non-seller 403. Hidden
from Swagger; the service stubs and `StorePaymentSettingsDto` are gone.

## 10. Delete an unused private upload

New: `DELETE /api/upload/private-file?publicId=<id>` (role `seller`) ->
200 `{ success: true, message: "File deleted", data: { publicId } }`.

- Only the uploader; someone else's or unknown file -> 404 "File not found".
- Only product files (`kind: digital_product`); KYC documents -> 400.
- 409 "This file is used by a product or course. Remove it there first."
  while any product (deleted ones too) uses it as a digital file, free
  sample or preview source, or a course lesson uses it.
- The ownership row is removed first, references re-checked, then the
  object is deleted (R2 presigned DELETE / Cloudinary destroy); on a late
  reference or a storage error the row is restored (409).
- Audit log: category `products`, action `private_file_deleted`.

## 11. Payout wallets (backend issue 2)

Changed (not a money rule):
- `GET /api/finance/:storeId/payout-schedule` no longer writes. It
  returns the saved schedule, else the default with `saved: false`.
  Without `?currency` it uses the store's own currency (was USD).
- `PATCH .../payout-schedule` without `currency` updates the store's own
  currency schedule (was USD). **check web** if it relies on the USD
  default.
- `GET /api/finance/:storeId/dashboard` `wallets`: one per currency the
  store holds a balance in (none yet = the store's currency). A schedule
  alone no longer adds an empty wallet.
- The scheduled-payout cron reads the balance instead of creating one.

**Not changed - money rule, needs an owner decision.** A payout is paid
from the wallet whose currency equals the payout METHOD's currency
(`requestPayout`: `currency = method.currency`; the cron: the schedule's
currency). A PKR-earning store with only a USD method cannot withdraw
its PKR. Proposal:

1. A payout always debits the wallet of the **earnings currency** the
   seller picks (default: the store's `baseCurrency`).
2. A method may only receive payouts in its own currency; adding a method
   in a currency the store has no earnings in is allowed but shows "No
   earnings in USD yet".
3. No automatic FX conversion between wallets. If conversion is ever
   wanted, it needs its own rule: which rate (the frozen order
   `fxSnapshots` or the day's rate), who bears the spread, and a ledger
   entry pair (debit PKR / credit USD) with an audit log.
4. Data clean-up (needs approval, live DB): delete `payoutschedules`
   rows with no matching `sellerbalances` row in that currency and no
   `defaultPayoutMethodId`.

## 12. Maintenance states

`GET /api/platform-config/maintenance` `state` is exactly `off`,
`scheduled` or `active` (no `on`). `off` answers `{ state: "off" }` only;
`scheduled` (future `startsAt`, nothing blocked) and `active` (blocking
now) carry `scopes, type, title, message, scopeMessages, startsAt,
endsAt, statusNote, updatedAt`. Blocked calls answer 503 `{ statusCode,
maintenanceMode: true, scope, scopes, type, title, message, endsAt,
statusNote }`. `endsAt` is an estimate only. Exported as
`MAINTENANCE_STATES` (`src/admin-config/maintenance.util.ts`).

## Tests

Each fix has a spec next to the code. Controller-level specs use the
test-only helper `src/common/testing/http-harness.helper-spec.ts` (one
controller over real HTTP with mocked providers; no database).
