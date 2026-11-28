# Accounting: automatic posting rules

The company books (`src/accounting`) are a double-entry ledger in **PKR**. Fiscal year: **July–June**
(label `2026-27`). The books start on **1 July 2026**. Opening balances are one journal dated that day.

The posting engine (`src/accounting/posting/`) reads platform records and writes **one journal per
source record**. A unique index on `journal.source.type + source.id` guarantees a record is never
posted twice, even with several API instances or a re-run backfill.

- **Pure rules:** in `posting.rules.ts`.
- **Runner:** `posting.service.ts`.
- **Accounts:** all codes come from `POSTING_ACCOUNTS` in `accounting.constants.ts`.

## When it runs

- **Schedule:** every 15 minutes (`AccountingJobs.post`), plus **Run now** and **Backfill from a
  date** in Accounting → Posting status.
- **Locking:** a Redis lock prevents overlapping runs; if Redis is down it runs anyway, because the
  unique index makes that safe.
- **Watermarks:** each source keeps its own watermark.
  - Records that never change after creation (seller transactions, add-ons) are scanned by `createdAt`.
  - Records whose state changes later (payouts, plan invoices, Premium payments) are scanned by
    `updatedAt`.
  - A backfill never moves a watermark backwards.
- **Skips and errors:** a record that produces no journal is marked `skipped` with a reason. A record
  that fails (usually a missing exchange rate) is marked `error` and retried on every run, up to 50
  times.
- **Nothing before the books start** (1 July 2026) is posted. Those amounts belong in the opening
  balances.

## Currency

- Every line stores the source **currency**, the **original amount** and the **rate** used (PKR per
  1 unit).
- The rate is the `exchange_rates` row in effect on the record's date: latest non-rejected
  `effectiveFrom ≤ date`.
- If no earlier rate exists, the earliest known rate is used and the journal is flagged.
- Lines are converted at one rate, and any paisa rounding gap is absorbed by the largest line of the
  lighter side, so each journal balances exactly.

## Closed months

- An automatic journal dated in a closed month is posted on the first day of the next open month,
  with a flag naming the original date.
- Manual entries are refused instead.

## Sources and journals

### 1. Seller ledger transactions (`transactions`, source `seller_tx`)

The seller's own balance ledger. **Seller payables (2000)** is the control account, with the seller
(store id) as the party.

| Transaction | Journal |
|---|---|
| `sale` (buyer paid Edudeen) | Dr clearing (by payment rail, see below) / Cr Seller payables — amount = sale + this store's shipping. Customer party on the clearing line. |
| `sale` with `collectedBy: 'seller'` (seller kept the cash) | **skipped**: no money reached Edudeen; the commission comes from the fee entry |
| `fee` | Dr Seller payables / Cr Marketplace commission (4000) or **Managed-store MOU commission (4010)** when the sale used the MOU rate (`feeRateSource = managed_mou`, else the store's current type) / Cr Card processing fees charged (4020) |
| `platform_subsidy` (normal sale) | Dr Platform subsidies (5100) / Cr clearing: the sale already includes the sponsored part, and the buyer paid less |
| `platform_subsidy` (cash or COD-commission order, `creditedToWallet`) | Dr Platform subsidies / Cr Seller payables |
| `refund` | Dr Seller payables / Cr clearing of the order's rail (customer party) |
| `refund` on a cash order returned by the seller (`walletDebit: 0`) | **skipped** |
| `payout` (request) | Dr Seller payables / Cr Seller payouts in transit (2010) |
| `adjustment` `shippingCredit` | **skipped**: already in the sale |
| `adjustment` COD commission reversal | Dr commission (4000/4010) / Cr Seller payables |
| `adjustment` on a payout (rejected/failed) | Dr Payouts in transit / Cr Seller payables |
| other `adjustment` (manual) | credit to the seller: Dr Seller adjustments (5110) / Cr Seller payables; debit: the reverse |
| any `failed` transaction | **skipped** |

**Payment rail → clearing account.** The rail is read from the order's `fee` transaction, falling
back to the sale.

| Rail | Account |
|---|---|
| `stripe` / `card` | Stripe clearing (1100) |
| `cash_on_delivery` (collected by the courier for Edudeen) | COD receivable from couriers (1110) |
| `bank_transfer`, `manual`, JazzCash, Easypaisa | Bank — main (1010) |
| anything else | Payment gateway clearing (1120) |

### 2. Payouts paid (`payouts` with status `completed`, source `payout_completed`)

Dr Seller payouts in transit / Cr Bank — main (1010).

Together with the `payout` transaction this gives the following, and a rejected payout returns the
amount to the seller instead:

1. Request: seller payable → in transit.
2. Paid: in transit → bank.

### 3. Seller platform plan invoices (`platformplaninvoices`)

- **Paid** (`platform_plan_invoice`): Dr Stripe clearing (card) or the rail's account / Cr Platform plan
  subscriptions (4100). USD. Subscriber party = store.
- **Refunded** (`platform_plan_refund`): posts only the **new** refunded amount since the last refund
  journal, so a partial then a full refund post two entries. The source id carries the cumulative
  refunded cents.

### 4. Platform add-ons (`platformaddonpurchases`, source `addon_purchase`)

Charged on card at purchase: Dr Stripe clearing / Cr Platform add-ons (4110).

### 5. Premium membership payments (`premiumpayments` approved, source `premium_payment`)

Bank transfer approved by an admin: Dr Bank — main / Cr Premium memberships (4200).

- The recorded PKR amount (`amountPKR`) is used when present, otherwise USD converted.
- Subscriber party = the buyer.

### 6. Fixed assets (`depreciation`, `asset_purchase`, `asset_disposal`)

- **Depreciation:** straight line, monthly. One journal per asset per finished month: Dr Depreciation
  (6400) / Cr Accumulated depreciation (1590).
  - It starts the month after purchase, but never before July 2026.
  - The last month absorbs rounding.
  - It stops at the salvage value.
- **Assets bought before the books start** go into the opening balances at cost, with accumulated
  depreciation to date.
- **Purchase** (optional, when the asset is added): Dr the asset account / Cr the chosen bank or
  payable account.
- **Disposal:** Dr Accumulated depreciation, Dr proceeds account / Cr asset cost. A gain goes to Other
  income (4800), a loss to Miscellaneous (6900).

### 7. Opening balances and reversals

- **Opening balances:** entered lines, with the difference to Opening balance equity (3900). Prepared,
  then approved. Only one can ever be posted (source `opening_balance:2026-07-01`).
- **Reversals:** the mirror image of a posted entry, posted by an approver (source `reversal:<id>`).
  Each entry can be reversed once.

### 8. Payroll (Phase B)

Phase B calls `AccountingService.postJournal({ source: { type: 'payroll', id } , kind: 'auto', … })`.

### 9. Stripe settlements (`stripe_btx`, `stripe_fees`)

A daily job (02:41 UTC) and **Accounting → Stripe settlements → Sync now** read the **platform
account's** Stripe balance transactions (read-only API calls) into `acct_stripe_btx`, then post them.
Each balance transaction posts at most once (source `stripe_btx:<txn id>`); re-runs and the 2-day
overlap of each read are harmless.

**What is NOT posted again (already in the books from another source):** the gross of a card payment
or refund for a marketplace order (seller ledger), a platform plan invoice, or an add-on. Those rows
are marked `skipped` with the reason. Matching uses our own records: the PaymentIntent on
`paymenttransactions`, `providerChargeId` on plan invoices / payment attempts / add-ons.

| Balance transaction | Journal |
|---|---|
| `payout` (Stripe → bank) | Dr Stripe payout bank account (Accounting settings, default 1010) / Cr Stripe clearing (1100) |
| `payout_failure`, `payout_cancel` | the reverse |
| `charge` / `payment` of a **Connect destination charge** | Dr Stripe clearing (gross) / Cr Stripe Connect seller funds in transit (2030, seller party) / Cr commission (4000, or 4010 for a managed store) = application fee |
| `transfer` (to the connected seller) | Dr 2030 / Cr Stripe clearing; `transfer_refund` / `_cancel` / `_failure` the reverse |
| Connect `refund` | Dr 2030 (seller share) + Dr commission (fee share, pro rata) / Cr Stripe clearing |
| `application_fee` / `_refund` | skipped when it belongs to a destination charge already split above; otherwise commission vs clearing |
| `charge` with PaymentIntent metadata `promotionRequestId` | Dr clearing / Cr Promoted placements (4120); refunds reverse |
| gift card purchase (`purpose: gift_card_purchase`) | Dr clearing / Cr **Suspense (1990)**: needs a manual reclassification (no gift card liability rule yet) |
| any other card payment we can't match | Dr clearing / Cr **Suspense (1990)** |
| `adjustment` with reporting category `dispute` | Dr Chargebacks & dispute losses (5130) / Cr clearing; `dispute_reversal` the reverse |
| `stripe_fee`, `stripe_fx_fee`, `tax_fee` | Dr Payment gateway fees (5000) / Cr clearing |
| `refund_failure` | Dr clearing / Cr Buyer refunds payable (2020) |
| `topup` / `topup_reversal` | clearing vs the payout bank account |
| `reserved_funds`, `reserve_transaction`, minimum-balance holds | skipped (money stays Edudeen's inside Stripe) |
| anything else | clearing vs Suspense, flagged for review |

**Fees:** the `fee` of every balance transaction (card payments, refunds, payouts) is summed per UTC
day and currency into **one** journal once the day is over: Dr Payment gateway fees (5000) / Cr Stripe
clearing (source `stripe_fees:<YYYY-MM-DD>:<CUR>`).

**Currency:** lines are in the Stripe balance currency (usually USD) and converted to PKR at that day's
rate like every other source.

**Connect check (Phase A).** Orders settled through a seller's own Stripe account
(`settledViaConnect`) never write seller-ledger transactions, so Phase A posted **nothing** for them —
no gross was wrongly booked and no repair of earlier journals is needed. Their application fee was
missing from income; it is now booked from the destination charge above. Connect direct charges are
off unless `STRIPE_CONNECT_DIRECT_CHARGES=true`.

**Reconciliation** (same screen) compares the Stripe clearing balance per original currency with
Stripe's available + pending balance. Expected differences: card payments for orders not yet
completed (Stripe has the money; the sale posts when the order completes), FX rounding between the
sale date and the payout date, and items waiting in Suspense. The screen lists errors, unmatched and
gift-card receipts, and adjustments to review.

### 10. COD remittances (`cod_remittance`)

**Accounting → COD remittances.** Finance uploads a courier statement (CSV or .xlsx; columns found by
name with TCS / Leopards / PostEx presets and editable) or types parcels in. Each parcel is matched by
tracking number (spaces and case ignored) to `sellerOrders.shipment.trackingNumber` /
`tracking.trackingNumber`:

| Status | Meaning |
|---|---|
| matched | our parcel, collected within Rs 1 of the booked COD amount |
| short / over | our parcel, collected less / more than booked |
| unknown | no Edudeen shipment with that number |
| duplicate | already in another approved remittance, or twice in this statement (blocks approval) |

The remittance is prepared, submitted and approved by someone else (owner exempt). Approval claims every
known parcel in `acct_cod_items` (unique tracking number, so a parcel can never be remitted twice) and
posts one journal dated the remittance date:

- Dr bank / cash account chosen (net received)
- Dr Courier & shipping expense (5010) = charges on the lines
- Dr other deductions account (default Miscellaneous 6900)
- Cr COD receivable from couriers (1110) per parcel = amount collected, **customer party**, so each
  buyer's ledger shows their parcel cleared; a short parcel leaves the shortfall in 1110 for follow-up
- Cr Suspense (1990) for unknown parcels
- the difference between net received and (collected − charges − deductions) to Suspense

**Outstanding COD** (Accounting → COD remittances, and on the finance dashboard when anything is older
than 15 days): delivered or completed COD packages collected by Edudeen's courier
(`codCollector = platform`, else `fulfillmentMode`) since the books start, not claimed by an approved
remittance, aged 0–7 / 8–15 / 16–30 / 30+ days since delivery. Parcels whose last courier event is
`returned` carry no cash and are left out. Amounts are the booked COD in PKR (converted at the order
date for other currencies).

### 11. Tax & EOBI payments (`statutory_payment`)

Edudeen cannot pay FBR or EOBI itself (no API): finance pays through the bank with a PSID or challan and records
the CPR in Payroll → Tax & EOBI payments (`src/statutory/`).

- **Statements are generated** for every approved payroll run, one per authority with something owed, from the
  same payslip lines the accrual journal was built from:
  - FBR income tax on salaries → 2220, per employee (taxable income, tax deducted);
  - FBR withholding on contractors → 2210, per contractor (pay excluding claims, tax withheld);
  - EOBI → 2230, per employee (employee + employer share, wage base);
  - provident fund → 2240.

  A job every 20 minutes (and opening the page) creates them; a unique index on run + authority makes it
  idempotent. Each statement stores what the run's accrual journal credited to its account and shows any
  difference.
- **Manual statements** (e.g. tax withheld from vendors) can be added on any active liability account.
- **Due date:** day N of the following month per authority (Accounting settings, default 15th). Defaults only:
  finance checks current FBR / EOBI rules. Reminders to the finance-pack recipients 5 days before and when
  overdue, each once per statement.
- **Payment:** recorded with PSID, CPR / challan number, date, bank and the receipt, then approved by someone
  else (owner exempt). Approval posts Dr liability / Cr bank, plus Dr Penalties & fines (6910) / Cr bank for
  any late-payment penalty. Partial payments are allowed. Source id `statement:payment`.
- **No party on these lines:** payroll accrues the liabilities as one total per run, so a per-employee party
  on the payment would unbalance the employee ledgers. The statement keeps the per-person detail.

## Year-end close

- **No closing entries.** Reports compute the year end:
  - **P&L:** income and expenses in the period.
  - **Balance sheet:** everything before the current fiscal year's start shows as **Retained
    earnings**. The current fiscal year's net profit shows as **Current year earnings** (3200, never
    posted to).
- **Closing a month** only locks it against new postings. Only the owner can reopen a month.

## Known gaps (post these by manual journal until automated)

- **Other gateways' settlements** (Payment gateway clearing 1120). Stripe and couriers are automated
  (sections 9 and 10).
- **Suspense (1990)** must be reviewed: unmatched card receipts, gift card sales, unknown COD parcels
  and statement differences land there for a manual reclassification.
- **Shipping income when Edudeen ships** (`fulfillmentMode = platform`). The shipping is still
  credited to the seller's balance today, as on the seller ledger.
- **Gift cards and loyalty points:** no liability is booked for issued but unredeemed value (gift
  card card payments go to Suspense, section 9).
- **Recurring add-on renewals:** only the first add-on charge has a record. Renewals charged later
  have none.
- **Stripe-billed Premium memberships** (`source: 'stripe'`): no payment rows exist to post from.
- **Buyer checkout taxes:** not modelled. Sales tax and withholding accounts are for manual
  journals.
- **Sales before 1 July 2026:** a refund or adjustment dated after the books start that relates to an
  earlier sale still posts. The seller-payable opening balance must include the earlier sale.
- **Seller deficits:** a seller who owes Edudeen shows as a **debit** balance on Seller payables
  (2000). Receivables aging lists receivable accounts only.
