/* eslint-disable prettier/prettier */
/**
 * Pure rules for the Stripe settlement sync: one platform-account balance transaction in -> one journal draft
 * (in the balance currency) or a skip. Card RECEIPTS that another source already books (marketplace sales from the
 * seller ledger, plan invoices, add-ons) are skipped here so nothing is counted twice; what is new is everything
 * Stripe does with the money afterwards: payouts to the bank, its fees (one journal per day), disputes, Connect
 * transfers, and receipts no other source knows about. See docs/accounting-posting-rules.md (section 9).
 */
import { POSTING_ACCOUNTS as A } from '../accounting.constants';
import { round2 } from '../accounting.util';
import type { DraftLine, RuleResult } from '../posting/posting.rules';

/** Currencies Stripe counts in whole units (no cents). */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

/** Stripe minor units -> major units. */
export function toMajor(minor: number | null | undefined, currency: string): number {
  const n = Number(minor) || 0;
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? n : round2(n / 100);
}

export type ChargeClass = 'marketplace' | 'plan_invoice' | 'addon' | 'connect' | 'promotion' | 'gift_card' | 'unmatched';

export interface ChargeFacts {
  chargeId: string | null;
  paymentIntentId: string | null;
  /** transfer_data.destination of the charge (Stripe Connect destination charge). */
  destination: string | null;
  /** PaymentIntent metadata (only fetched when our own records don't recognise the payment). */
  metadata?: Record<string, string> | null;
}
export interface KnownPayments {
  planCharges: Set<string>;
  addonCharges: Set<string>;
  /** Marketplace PaymentIntent id -> settled through the seller's own Stripe account (Connect)? */
  marketplacePIs: Map<string, { connect: boolean }>;
}

/**
 * What a card receipt was for. Our own records win (they are what the other posting sources read); PaymentIntent
 * metadata is the fallback for flows with no ledger source (promotions, gift cards).
 */
export function classifyCharge(f: ChargeFacts, known: KnownPayments): ChargeClass {
  if (f.destination) return 'connect';
  if (f.chargeId && known.planCharges.has(f.chargeId)) return 'plan_invoice';
  if (f.chargeId && known.addonCharges.has(f.chargeId)) return 'addon';
  if (f.paymentIntentId) {
    const mp = known.marketplacePIs.get(f.paymentIntentId);
    if (mp) return mp.connect ? 'connect' : 'marketplace';
  }
  const md = f.metadata ?? {};
  if (md.promotionRequestId) return 'promotion';
  if (md.purpose === 'gift_card_purchase') return 'gift_card';
  if (md.checkoutId) return 'marketplace';
  return 'unmatched';
}

export interface BtxInput {
  btxId: string;
  type: string;
  reportingCategory?: string | null;
  /** Major units, signed like Stripe (+ into the balance). */
  amount: number;
  currency: string;
  created: Date;
  description?: string | null;
  classification?: string | null;
  chargeAmount?: number | null;
  applicationFee?: number | null;
}
export interface BtxContext {
  /** COA code Stripe payouts go to. */
  payoutBank: string;
  /** Destination charges: the connected seller (party) and which commission account their sales use. */
  store?: { id: string; name?: string | null; managed?: boolean } | null;
}

const SKIP_GROSS: Record<string, string> = {
  marketplace: 'marketplace sale: booked from the seller ledger when the order completes',
  plan_invoice: 'platform plan invoice: booked from the invoice',
  addon: 'add-on purchase: booked from the purchase',
};

export function postBalanceTxn(t: BtxInput, ctx: BtxContext): RuleResult {
  const amt = round2(Math.abs(Number(t.amount) || 0));
  const inflow = Number(t.amount) > 0;
  const currency = (t.currency || 'USD').toUpperCase();
  const date = new Date(t.created);
  const ref = t.btxId;
  const memo = (label: string) => `Stripe: ${label}${t.description ? ` — ${t.description}` : ''}`.slice(0, 300);
  const draft = (label: string, lines: DraftLine[]): RuleResult => ({ post: { date, currency, memo: memo(label), ref, lines } });
  /** Money in (+) or out (-) of Stripe against one other account. */
  const vsClearing = (label: string, other: string, desc?: string, party?: DraftLine['party']): RuleResult => draft(label, inflow
    ? [{ accountCode: A.stripeClearing, debit: amt }, { accountCode: other, credit: amt, description: desc ?? null, party: party ?? null }]
    : [{ accountCode: other, debit: amt, description: desc ?? null, party: party ?? null }, { accountCode: A.stripeClearing, credit: amt }]);
  const seller = ctx.store?.id ? { type: 'seller' as const, id: ctx.store.id, name: ctx.store.name ?? null } : null;
  const commission = ctx.store?.managed ? A.commissionManaged : A.commissionSelf;

  if (amt === 0) return { skip: 'zero amount (its fee, if any, is in the daily fee journal)' };

  switch (t.type) {
    case 'charge':
    case 'payment': {
      const cls = t.classification ?? 'unmatched';
      if (SKIP_GROSS[cls]) return { skip: SKIP_GROSS[cls] };
      if (cls === 'connect') {
        // Destination charge: the whole amount lands here, the seller's share leaves by transfer, the fee is ours.
        const fee = Math.min(round2(Number(t.applicationFee ?? 0)), amt);
        const lines: DraftLine[] = [{ accountCode: A.stripeClearing, debit: amt, description: 'Card payment (Stripe Connect destination charge)' }];
        if (amt - fee > 0) lines.push({ accountCode: A.connectInTransit, credit: round2(amt - fee), party: seller, storeId: ctx.store?.id ?? null, description: 'Seller share, transferred to their Stripe account' });
        if (fee > 0) lines.push({ accountCode: commission, credit: fee, storeId: ctx.store?.id ?? null, description: 'Application fee (commission)' });
        return draft('Connect card payment', lines);
      }
      if (cls === 'promotion') return vsClearing('promoted placement paid by card', A.promotionIncome);
      if (cls === 'gift_card') return vsClearing('gift card sold', A.suspense, 'Gift card sale: no automatic rule — reclassify (e.g. to a gift card liability)');
      return vsClearing('card payment not matched to any Edudeen record', A.suspense, 'Unmatched card receipt — find what it was for and reclassify');
    }
    case 'refund':
    case 'payment_refund':
    case 'payment_failure_refund': {
      const cls = t.classification ?? 'unmatched';
      if (SKIP_GROSS[cls]) return { skip: `refund of a ${SKIP_GROSS[cls]}` };
      if (cls === 'connect') {
        // Split like the original charge: seller share back out of in-transit, the fee share out of commission.
        const ratio = t.chargeAmount && t.chargeAmount > 0 ? Math.min(1, Math.max(0, Number(t.applicationFee ?? 0) / t.chargeAmount)) : 0;
        const feePart = round2(amt * ratio);
        const lines: DraftLine[] = [];
        if (amt - feePart > 0) lines.push({ accountCode: A.connectInTransit, debit: round2(amt - feePart), party: seller, storeId: ctx.store?.id ?? null, description: 'Seller share refunded (transfer reversal follows)' });
        if (feePart > 0) lines.push({ accountCode: commission, debit: feePart, storeId: ctx.store?.id ?? null, description: 'Application fee refunded' });
        lines.push({ accountCode: A.stripeClearing, credit: amt, description: 'Refund paid to the buyer' });
        return draft('Connect refund', lines);
      }
      if (cls === 'promotion') return vsClearing('promoted placement refunded', A.promotionIncome);
      return vsClearing(cls === 'gift_card' ? 'gift card refunded' : 'refund of an unmatched card payment', A.suspense, 'Refund with no automatic rule — reclassify');
    }
    case 'refund_failure':
      // A refund the books already paid out (via the seller ledger) bounced: the buyer is still owed it.
      return vsClearing('refund failed', A.buyerRefundsPayable, 'Refund bounced — the buyer must be repaid');
    case 'transfer':
    case 'transfer_cancel':
    case 'transfer_failure':
    case 'transfer_refund':
      return vsClearing(inflow ? 'Connect transfer returned' : 'Connect transfer to seller', A.connectInTransit);
    case 'application_fee':
    case 'application_fee_refund':
      if (t.classification === 'connect') return { skip: 'already booked with the destination charge' };
      return vsClearing(inflow ? 'application fee' : 'application fee refunded', commission);
    case 'payout':
    case 'payout_cancel':
    case 'payout_failure':
      return vsClearing(inflow ? 'payout returned' : 'payout to bank', ctx.payoutBank, inflow ? 'Payout failed or cancelled; money back in Stripe' : 'Stripe payout');
    case 'payout_minimum_balance_hold':
    case 'payout_minimum_balance_release':
    case 'reserved_funds':
    case 'reserve_transaction':
      return { skip: 'money held or released inside Stripe (still Edudeen\'s)' };
    case 'stripe_fee':
    case 'stripe_fx_fee':
    case 'tax_fee':
      return vsClearing(inflow ? 'Stripe fee refunded' : 'Stripe fee', A.gatewayFees);
    case 'adjustment': {
      const cat = String(t.reportingCategory ?? '');
      if (cat === 'dispute') return vsClearing('dispute (chargeback)', A.chargebackLoss);
      if (cat === 'dispute_reversal') return vsClearing('dispute won', A.chargebackLoss);
      return vsClearing('adjustment', A.suspense, 'Stripe adjustment — review and reclassify');
    }
    case 'topup':
    case 'topup_reversal':
      return vsClearing(inflow ? 'top-up from bank' : 'top-up reversed', ctx.payoutBank);
    default:
      return vsClearing(`${t.type.replace(/_/g, ' ')}`, A.suspense, `Stripe "${t.type}" has no automatic rule — review`);
  }
}

/** One journal for a day's Stripe processing fees in one currency (the `fee` of every balance transaction). */
export function postDailyFees(day: string, currency: string, totalFee: number): RuleResult {
  const fee = round2(totalFee);
  if (!fee) return { skip: 'no fees' };
  const amt = Math.abs(fee);
  const date = new Date(`${day}T12:00:00Z`);
  return {
    post: {
      date, currency: currency.toUpperCase(), memo: `Stripe processing fees ${day}`, ref: `stripe_fees:${day}`,
      lines: fee > 0
        ? [{ accountCode: A.gatewayFees, debit: amt, description: 'Stripe fees on card payments, refunds and payouts' }, { accountCode: A.stripeClearing, credit: amt }]
        : [{ accountCode: A.stripeClearing, debit: amt }, { accountCode: A.gatewayFees, credit: amt, description: 'Stripe fees returned' }],
    },
  };
}

/** UTC calendar day of a date. */
export const utcDay = (d: Date) => new Date(d).toISOString().slice(0, 10);
