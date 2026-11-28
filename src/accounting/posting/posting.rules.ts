/* eslint-disable prettier/prettier */
/**
 * Pure auto-posting rules: one source record in -> one balanced journal draft (in the SOURCE currency) or a skip.
 * The runner (posting.service.ts) loads the records, converts the draft to PKR and saves it. Every mapping is
 * described in docs/accounting-posting-rules.md — keep the two in step.
 */
import { POSTING_ACCOUNTS as A, type PartyType } from '../accounting.constants';
import { round2, toPaisa, type LineInput } from '../accounting.util';

export interface DraftLine {
  accountCode: string;
  debit?: number;
  credit?: number;
  party?: { type: PartyType; id: string; name?: string | null } | null;
  storeId?: string | null;
  description?: string | null;
}
export interface PostingDraft { date: Date; currency: string; memo: string; ref: string | null; lines: DraftLine[] }
export type RuleResult = { post: PostingDraft } | { skip: string };

const sellerParty = (storeId: string, name?: string | null) => ({ type: 'seller' as const, id: String(storeId), name: name ?? null });

/** Which clearing/bank account a buyer payment rail lands in. */
export function clearingAccountFor(paymentMethodType: string | null | undefined): string {
  const pm = String(paymentMethodType ?? '').toLowerCase();
  if (pm === 'stripe' || pm === 'card') return A.stripeClearing;
  if (pm === 'cash_on_delivery' || pm === 'cod') return A.codReceivable;
  if (pm === 'bank_transfer' || pm === 'manual' || pm === 'manual_transfer' || pm === 'jazzcash' || pm === 'easypaisa') return A.bank;
  return A.gatewayClearing;
}

// ── Seller ledger transactions (finance `transactions` collection) ──────────────
export interface SellerTxInput {
  _id: string;
  storeId: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  description?: string | null;
  referenceId: string | null;
  referenceType: string | null;
  metadata: Record<string, any> | null;
  createdAt: Date;
}
export interface SellerTxContext {
  storeName?: string | null;
  /** Store.managementType now — used only when the sale didn't record which fee rule applied. */
  managementType?: 'self' | 'managed' | null;
  /** Metadata of the 'sale' transaction of the same order and store (fee rule, shipping, rail). */
  saleMeta?: Record<string, any> | null;
  /** Payment rail of the order (from the order's fee transaction). */
  paymentMethodType?: string | null;
  customer?: { id: string; name?: string | null } | null;
  orderNumber?: string | null;
}

export function postSellerTx(tx: SellerTxInput, ctx: SellerTxContext = {}): RuleResult {
  const md = tx.metadata ?? {};
  const amt = round2(Math.abs(Number(tx.amount) || 0));
  const date = new Date(tx.createdAt);
  const store = sellerParty(tx.storeId, ctx.storeName);
  const ref = ctx.orderNumber ? `Order #${ctx.orderNumber}` : tx.referenceId ? `${tx.referenceType ?? 'ref'} ${tx.referenceId}` : null;
  const memo = tx.description || `${tx.type} ${ref ?? ''}`.trim();
  const customer = ctx.customer?.id ? { type: 'customer' as const, id: String(ctx.customer.id), name: ctx.customer.name ?? null } : null;
  const draft = (lines: DraftLine[]): RuleResult => ({ post: { date, currency: (tx.currency || 'USD').toUpperCase(), memo, ref, lines } });

  if (tx.status === 'failed') return { skip: 'failed transaction' };
  if (amt === 0) return { skip: 'zero amount' };

  switch (tx.type) {
    case 'sale': {
      // Cash kept by the seller: no money reached Edudeen; the commission is booked by the fee transaction.
      if (md.collectedBy === 'seller') return { skip: 'cash collected by seller (commission posted from the fee entry)' };
      const shipping = round2(Number(md.shippingCredit ?? 0));
      const gross = round2(amt + shipping);
      const clearing = clearingAccountFor(ctx.paymentMethodType ?? md.paymentMethodType);
      return draft([
        { accountCode: clearing, debit: gross, party: customer, storeId: tx.storeId, description: 'Buyer payment (incl. this store\'s shipping and any platform-funded discount)' },
        { accountCode: A.sellerPayable, credit: gross, party: store, storeId: tx.storeId, description: shipping > 0 ? `Sale ${amt} + shipping ${shipping}` : 'Sale' },
      ]);
    }
    case 'fee': {
      const platformFee = round2(Number(md.platformFee ?? 0));
      const processingFee = round2(Number(md.processingFee ?? 0));
      const source = md.feeRateSource ?? ctx.saleMeta?.feeRateSource ?? null;
      const managed = source ? source === 'managed_mou' : ctx.managementType === 'managed';
      const commissionAccount = managed ? A.commissionManaged : A.commissionSelf;
      // The two parts are informational; the transaction amount is authoritative. Any gap goes to commission.
      const processing = Math.min(processingFee, amt);
      const commission = round2(amt - processing);
      const lines: DraftLine[] = [{ accountCode: A.sellerPayable, debit: amt, party: store, storeId: tx.storeId, description: 'Commission and fees charged to the seller' }];
      if (commission > 0) lines.push({ accountCode: commissionAccount, credit: commission, storeId: tx.storeId, description: managed ? 'MOU commission' : `Platform commission${platformFee && platformFee !== commission ? ` (fee ${platformFee})` : ''}` });
      if (processing > 0) lines.push({ accountCode: A.processingFeeIncome, credit: processing, storeId: tx.storeId, description: 'Card processing fee' });
      return draft(lines);
    }
    case 'platform_subsidy': {
      // Normal sale: the sale amount already includes the subsidy and the buyer paid less -> reduce clearing.
      // Cash-collected / COD-commission orders: the subsidy was credited to the seller's wallet.
      const toWallet = md.creditedToWallet === true || md.collectedBy === 'seller' || md.codCommission === true;
      return draft([
        { accountCode: A.subsidyExpense, debit: amt, storeId: tx.storeId, description: 'Platform-sponsored discount' },
        toWallet
          ? { accountCode: A.sellerPayable, credit: amt, party: store, storeId: tx.storeId, description: 'Discount credited to the seller' }
          : { accountCode: clearingAccountFor(ctx.paymentMethodType ?? ctx.saleMeta?.paymentMethodType), credit: amt, party: customer, storeId: tx.storeId, description: 'Part of the sale the buyer did not pay' },
      ]);
    }
    case 'refund': {
      if (md.collectedBy === 'seller' || md.walletDebit === 0) return { skip: 'cash order refunded by the seller (wallet not debited)' };
      return draft([
        { accountCode: A.sellerPayable, debit: amt, party: store, storeId: tx.storeId, description: 'Refund charged to the seller' },
        { accountCode: clearingAccountFor(ctx.paymentMethodType ?? ctx.saleMeta?.paymentMethodType), credit: amt, party: customer, storeId: tx.storeId, description: 'Refund paid to the buyer' },
      ]);
    }
    case 'payout': {
      return draft([
        { accountCode: A.sellerPayable, debit: amt, party: store, storeId: tx.storeId, description: 'Payout to seller' },
        { accountCode: A.payoutsInTransit, credit: amt, party: store, storeId: tx.storeId, description: 'Awaiting bank transfer' },
      ]);
    }
    case 'adjustment': {
      if (md.shippingCredit === true) return { skip: 'shipping line already included in the sale' };
      if (md.codCommissionReversal === true || md.codCommissionReversalRef) {
        const source = ctx.saleMeta?.feeRateSource ?? null;
        const managed = source ? source === 'managed_mou' : ctx.managementType === 'managed';
        return draft([
          { accountCode: managed ? A.commissionManaged : A.commissionSelf, debit: amt, storeId: tx.storeId, description: 'Commission reversed (refund/return)' },
          { accountCode: A.sellerPayable, credit: amt, party: store, storeId: tx.storeId, description: 'Commission credited back' },
        ]);
      }
      if (tx.referenceType === 'payout') {
        // Rejected/failed payout: the money never left, back to the seller's balance.
        return draft([
          { accountCode: A.payoutsInTransit, debit: amt, party: store, storeId: tx.storeId, description: 'Payout returned' },
          { accountCode: A.sellerPayable, credit: amt, party: store, storeId: tx.storeId, description: 'Payout returned to balance' },
        ]);
      }
      // Any other manual adjustment: a credit to the seller is Edudeen's cost, a debit is a recovery.
      const credit = Number(tx.amount) > 0;
      return draft(credit
        ? [
          { accountCode: A.sellerAdjustments, debit: amt, storeId: tx.storeId, description: 'Adjustment in the seller\'s favour' },
          { accountCode: A.sellerPayable, credit: amt, party: store, storeId: tx.storeId },
        ]
        : [
          { accountCode: A.sellerPayable, debit: amt, party: store, storeId: tx.storeId },
          { accountCode: A.sellerAdjustments, credit: amt, storeId: tx.storeId, description: 'Adjustment recovered from the seller' },
        ]);
    }
    default:
      return { skip: `unknown transaction type "${tx.type}"` };
  }
}

// ── Payouts paid from the bank ──────────────────────────────────────────────
export interface PayoutInput { _id: string; storeId: string; amount: number; currency: string; status: string; processedAt?: Date | null; updatedAt?: Date | null; payoutMethodSnapshot?: { type?: string; bankName?: string | null; accountLast4?: string } | null }

export function postPayoutCompleted(p: PayoutInput, storeName?: string | null): RuleResult {
  if (p.status !== 'completed') return { skip: `payout ${p.status}` };
  const amt = round2(Math.abs(Number(p.amount) || 0));
  if (!amt) return { skip: 'zero amount' };
  const store = sellerParty(p.storeId, storeName);
  const via = p.payoutMethodSnapshot?.bankName || p.payoutMethodSnapshot?.type || 'bank';
  return {
    post: {
      date: new Date(p.processedAt ?? p.updatedAt ?? Date.now()),
      currency: (p.currency || 'USD').toUpperCase(),
      memo: `Payout paid to ${storeName ?? 'seller'} via ${via}`,
      ref: `Payout ${p._id}`,
      lines: [
        { accountCode: A.payoutsInTransit, debit: amt, party: store, storeId: p.storeId },
        { accountCode: A.bank, credit: amt, storeId: p.storeId, description: `Paid via ${via}` },
      ],
    },
  };
}

// ── Seller platform plan invoices ───────────────────────────────────────────
export interface PlanInvoiceInput { _id: string; storeId: string; invoiceNumber: string; amountUSD: number; status: string; paidAt: Date | null; refundedAt?: Date | null; refundedAmountUSD?: number; paymentMethodType?: string | null; isDelete?: boolean }

export function postPlanInvoice(inv: PlanInvoiceInput, storeName?: string | null): RuleResult {
  if (inv.isDelete) return { skip: 'deleted invoice' };
  if (!['paid', 'refunded', 'partially_refunded'].includes(inv.status) || !inv.paidAt) return { skip: `invoice ${inv.status}` };
  const amt = round2(Number(inv.amountUSD) || 0);
  if (!amt) return { skip: 'zero amount' };
  const sub = { type: 'subscriber' as const, id: String(inv.storeId), name: storeName ?? null };
  const clearing = inv.paymentMethodType === 'card' || !inv.paymentMethodType ? A.stripeClearing : clearingAccountFor(inv.paymentMethodType);
  return {
    post: {
      date: new Date(inv.paidAt),
      currency: 'USD',
      memo: `Platform plan invoice ${inv.invoiceNumber}`,
      ref: inv.invoiceNumber,
      lines: [
        { accountCode: clearing, debit: amt, party: sub, storeId: inv.storeId },
        { accountCode: A.platformPlanIncome, credit: amt, party: sub, storeId: inv.storeId },
      ],
    },
  };
}

/** Refund delta not yet posted for an invoice (refunds can grow: partial, then full). */
export function postPlanRefund(inv: PlanInvoiceInput, alreadyPostedUSD: number, storeName?: string | null): RuleResult {
  const total = round2(Number(inv.refundedAmountUSD ?? 0));
  const delta = round2(total - alreadyPostedUSD);
  if (delta <= 0) return { skip: 'nothing new refunded' };
  const sub = { type: 'subscriber' as const, id: String(inv.storeId), name: storeName ?? null };
  const clearing = inv.paymentMethodType === 'card' || !inv.paymentMethodType ? A.stripeClearing : clearingAccountFor(inv.paymentMethodType);
  return {
    post: {
      date: new Date(inv.refundedAt ?? Date.now()),
      currency: 'USD',
      memo: `Refund of platform plan invoice ${inv.invoiceNumber}`,
      ref: inv.invoiceNumber,
      lines: [
        { accountCode: A.platformPlanIncome, debit: delta, party: sub, storeId: inv.storeId },
        { accountCode: clearing, credit: delta, party: sub, storeId: inv.storeId },
      ],
    },
  };
}

// ── Add-on purchases (charged on card at purchase time) ─────────────────────
export interface AddonInput { _id: string; storeId: string; addonType: string; priceUSD: number; quantity?: number; providerChargeId?: string | null; createdAt: Date }

export function postAddon(a: AddonInput, storeName?: string | null): RuleResult {
  if (!a.providerChargeId) return { skip: 'no card charge recorded' };
  const amt = round2(Number(a.priceUSD) || 0);
  if (!amt) return { skip: 'zero amount' };
  const sub = { type: 'subscriber' as const, id: String(a.storeId), name: storeName ?? null };
  return {
    post: {
      date: new Date(a.createdAt),
      currency: 'USD',
      memo: `Add-on: ${a.addonType.replace(/_/g, ' ')}${a.quantity && a.quantity > 1 ? ` x${a.quantity}` : ''}`,
      ref: a.providerChargeId,
      lines: [
        { accountCode: A.stripeClearing, debit: amt, party: sub, storeId: a.storeId },
        { accountCode: A.addonIncome, credit: amt, party: sub, storeId: a.storeId },
      ],
    },
  };
}

// ── Premium (buyer membership) payments approved by bank transfer ───────────
export interface PremiumPaymentInput { _id: string; userId: string; planName?: string; interval: string; amountUSD: number; amountPKR?: number | null; fxRateUsed?: number | null; status: string; reviewedAt?: Date | null; updatedAt?: Date | null }

export function postPremiumPayment(p: PremiumPaymentInput, userName?: string | null): RuleResult {
  if (p.status !== 'approved') return { skip: `payment ${p.status}` };
  const pkr = p.amountPKR != null && p.amountPKR > 0 ? round2(p.amountPKR) : null;
  const amount = pkr ?? round2(Number(p.amountUSD) || 0);
  if (!amount) return { skip: 'zero amount' };
  const sub = { type: 'subscriber' as const, id: String(p.userId), name: userName ?? null };
  return {
    post: {
      date: new Date(p.reviewedAt ?? p.updatedAt ?? Date.now()),
      currency: pkr ? 'PKR' : 'USD',
      memo: `Premium ${p.planName ?? ''} (${p.interval})`.replace(/\s+/g, ' '),
      ref: `Premium payment ${p._id}`,
      lines: [
        { accountCode: A.bank, debit: amount, party: sub },
        { accountCode: A.premiumIncome, credit: amount, party: sub },
      ],
    },
  };
}

// ── Currency conversion of a draft ──────────────────────────────────────────
/**
 * Converts every line at one rate (base units per 1 source unit) and absorbs the paisa rounding gap on the
 * largest line of the lighter side, so the converted journal still balances exactly.
 */
export function convertDraftLines(draft: PostingDraft, fxRate: number, baseCurrency = 'PKR'): LineInput[] {
  const same = draft.currency === baseCurrency;
  const lines: LineInput[] = draft.lines.map((l) => {
    const original = round2(Number(l.debit ?? 0) || Number(l.credit ?? 0));
    const base = same ? original : round2(original * fxRate);
    return {
      accountCode: l.accountCode,
      debit: l.debit ? base : 0,
      credit: l.credit ? base : 0,
      currency: draft.currency,
      amountOriginal: original,
      fxRate: same ? 1 : fxRate,
      party: l.party ?? null,
      storeId: l.storeId ?? null,
      description: l.description ?? null,
    };
  });
  const dr = lines.reduce((s, l) => s + toPaisa(l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + toPaisa(l.credit ?? 0), 0);
  const gap = dr - cr;
  if (gap !== 0) {
    const side: 'debit' | 'credit' = gap > 0 ? 'credit' : 'debit';
    const target = lines.filter((l) => (l[side] ?? 0) > 0).sort((a, b) => (b[side] ?? 0) - (a[side] ?? 0))[0];
    if (target) target[side] = round2((toPaisa(target[side] ?? 0) + Math.abs(gap)) / 100);
  }
  return lines;
}
