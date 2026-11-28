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

## Year-end close

- **No closing entries.** Reports compute the year end:
  - **P&L:** income and expenses in the period.
  - **Balance sheet:** everything before the current fiscal year's start shows as **Retained
    earnings**. The current fiscal year's net profit shows as **Current year earnings** (3200, never
    posted to).
- **Closing a month** only locks it against new postings. Only the owner can reopen a month.

## Known gaps (post these by manual journal until automated)

- **Stripe / gateway settlement to the bank, and Stripe's own fees.** Clearing accounts grow until a
  journal moves them: Dr Bank, Dr Payment gateway fees (5000) / Cr Stripe clearing.
- **Courier COD remittances:** Dr Bank / Cr COD receivable. Courier charges to 5010.
- **Shipping income when Edudeen ships** (`fulfillmentMode = platform`). The shipping is still
  credited to the seller's balance today, as on the seller ledger.
- **Gift cards and loyalty points:** no liability is booked for issued but unredeemed value.
- **Recurring add-on renewals:** only the first add-on charge has a record. Renewals charged later
  have none.
- **Stripe-billed Premium memberships** (`source: 'stripe'`): no payment rows exist to post from.
- **Buyer checkout taxes:** not modelled. Sales tax and withholding accounts are for manual
  journals.
- **Sales before 1 July 2026:** a refund or adjustment dated after the books start that relates to an
  earlier sale still posts. The seller-payable opening balance must include the earlier sale.
- **Seller deficits:** a seller who owes Edudeen shows as a **debit** balance on Seller payables
  (2000). Receivables aging lists receivable accounts only.
