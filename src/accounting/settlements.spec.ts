/* eslint-disable prettier/prettier, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy test */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { POSTING_ACCOUNTS as A } from './accounting.constants';
import { round2 } from './accounting.util';
import { convertDraftLines, type PostingDraft } from './posting/posting.rules';
import { toXlsx } from './export.util';
import { classifyCharge, postBalanceTxn, postDailyFees, toMajor, type BtxInput, type KnownPayments } from './stripe/stripe.rules';
import { StripeSettlementService } from './stripe/stripe-settlement.service';
import {
  agingBucket, detectColumns, extractLines, matchLines, packageCodAmount, parseAmount, parseCsv, readStatement, readXlsx, remittanceJournalLines,
  remittanceTotals, type ParcelInfo,
} from './cod/cod.util';
import { CodRemittanceService } from './cod/cod-remittance.service';

const D = (s: string) => new Date(`${s}T10:00:00Z`);
const sum = (lines: any[], k: 'debit' | 'credit') => round2(lines.reduce((s, l) => s + (l[k] ?? 0), 0));
const post = (r: any): PostingDraft => { if (!('post' in r)) throw new Error(`expected a journal, got skip: ${r.skip}`); return r.post; };
const balanced = (d: PostingDraft) => expect(sum(d.lines, 'debit')).toBe(sum(d.lines, 'credit'));
const line = (d: PostingDraft, code: string, side: 'debit' | 'credit') => round2(d.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + ((l as any)[side] ?? 0), 0));
const btx = (over: Partial<BtxInput>): BtxInput => ({ btxId: 'txn_1', type: 'charge', amount: 100, currency: 'USD', created: D('2026-08-05'), ...over });
const ctx = { payoutBank: A.bank };

describe('Stripe settlement rules', () => {
  it('converts minor units, including zero-decimal currencies', () => {
    expect(toMajor(12345, 'usd')).toBe(123.45);
    expect(toMajor(-500, 'PKR')).toBe(-5);
    expect(toMajor(1500, 'JPY')).toBe(1500);
  });

  it('classifies card receipts from our own records first', () => {
    const known: KnownPayments = { planCharges: new Set(['ch_plan']), addonCharges: new Set(['ch_add']), marketplacePIs: new Map([['pi_m', { connect: false }], ['pi_c', { connect: true }]]) };
    expect(classifyCharge({ chargeId: 'ch_plan', paymentIntentId: null, destination: null }, known)).toBe('plan_invoice');
    expect(classifyCharge({ chargeId: 'ch_add', paymentIntentId: null, destination: null }, known)).toBe('addon');
    expect(classifyCharge({ chargeId: 'ch_x', paymentIntentId: 'pi_m', destination: null }, known)).toBe('marketplace');
    expect(classifyCharge({ chargeId: 'ch_x', paymentIntentId: 'pi_c', destination: null }, known)).toBe('connect');
    expect(classifyCharge({ chargeId: 'ch_x', paymentIntentId: null, destination: 'acct_1' }, known)).toBe('connect');
    expect(classifyCharge({ chargeId: 'ch_x', paymentIntentId: 'pi_z', destination: null, metadata: { promotionRequestId: 'p1' } }, known)).toBe('promotion');
    expect(classifyCharge({ chargeId: 'ch_x', paymentIntentId: 'pi_z', destination: null, metadata: { purpose: 'gift_card_purchase' } }, known)).toBe('gift_card');
    expect(classifyCharge({ chargeId: 'ch_x', paymentIntentId: 'pi_z', destination: null }, known)).toBe('unmatched');
  });

  it('skips receipts another source already books (no double counting)', () => {
    for (const c of ['marketplace', 'plan_invoice', 'addon']) {
      expect('skip' in postBalanceTxn(btx({ classification: c }), ctx)).toBe(true);
      expect('skip' in postBalanceTxn(btx({ type: 'refund', amount: -40, classification: c }), ctx)).toBe(true);
    }
  });

  it('payout to the bank, and a failed payout coming back', () => {
    const p = post(postBalanceTxn(btx({ type: 'payout', amount: -2500 }), { payoutBank: '1020' }));
    expect(line(p, '1020', 'debit')).toBe(2500);
    expect(line(p, A.stripeClearing, 'credit')).toBe(2500);
    const f = post(postBalanceTxn(btx({ type: 'payout_failure', amount: 2500 }), { payoutBank: '1020' }));
    expect(line(f, A.stripeClearing, 'debit')).toBe(2500);
    expect(line(f, '1020', 'credit')).toBe(2500);
    balanced(p); balanced(f);
  });

  it('Connect destination charge: seller share in transit, application fee as commission (MOU when managed)', () => {
    const d = post(postBalanceTxn(btx({ classification: 'connect', applicationFee: 12, chargeAmount: 100 }), { ...ctx, store: { id: 's1', name: 'Shop', managed: false } }));
    expect(line(d, A.stripeClearing, 'debit')).toBe(100);
    expect(line(d, A.connectInTransit, 'credit')).toBe(88);
    expect(line(d, A.commissionSelf, 'credit')).toBe(12);
    expect(d.lines.find((l) => l.accountCode === A.connectInTransit)?.party).toEqual({ type: 'seller', id: 's1', name: 'Shop' });
    const m = post(postBalanceTxn(btx({ classification: 'connect', applicationFee: 30, chargeAmount: 100 }), { ...ctx, store: { id: 's2', managed: true } }));
    expect(line(m, A.commissionManaged, 'credit')).toBe(30);
    balanced(d); balanced(m);
  });

  it('Connect refund is split pro rata, transfers move in-transit, and the whole round trip nets to zero', () => {
    const charge = post(postBalanceTxn(btx({ classification: 'connect', applicationFee: 10, chargeAmount: 100 }), ctx));
    const transfer = post(postBalanceTxn(btx({ type: 'transfer', amount: -90 }), ctx));
    const refund = post(postBalanceTxn(btx({ type: 'refund', amount: -100, classification: 'connect', applicationFee: 10, chargeAmount: 100 }), ctx));
    const back = post(postBalanceTxn(btx({ type: 'transfer_refund', amount: 90 }), ctx));
    const half = post(postBalanceTxn(btx({ type: 'refund', amount: -50, classification: 'connect', applicationFee: 10, chargeAmount: 100 }), ctx));
    expect(line(half, A.connectInTransit, 'debit')).toBe(45);
    expect(line(half, A.commissionSelf, 'debit')).toBe(5);
    const all = [charge, transfer, refund, back];
    for (const code of [A.stripeClearing, A.connectInTransit, A.commissionSelf]) {
      const net = round2(all.reduce((s, d) => s + line(d, code, 'debit') - line(d, code, 'credit'), 0));
      expect(net).toBe(0);
    }
    all.forEach(balanced);
  });

  it('disputes, Stripe fees and unknown money', () => {
    const lost = post(postBalanceTxn(btx({ type: 'adjustment', reportingCategory: 'dispute', amount: -60 }), ctx));
    expect(line(lost, A.chargebackLoss, 'debit')).toBe(60);
    const won = post(postBalanceTxn(btx({ type: 'adjustment', reportingCategory: 'dispute_reversal', amount: 60 }), ctx));
    expect(line(won, A.chargebackLoss, 'credit')).toBe(60);
    const fee = post(postBalanceTxn(btx({ type: 'stripe_fee', amount: -2 }), ctx));
    expect(line(fee, A.gatewayFees, 'debit')).toBe(2);
    const odd = post(postBalanceTxn(btx({ type: 'adjustment', reportingCategory: 'other_adjustment', amount: 7 }), ctx));
    expect(line(odd, A.suspense, 'credit')).toBe(7);
    const unmatched = post(postBalanceTxn(btx({ classification: 'unmatched', amount: 15 }), ctx));
    expect(line(unmatched, A.suspense, 'credit')).toBe(15);
    const promo = post(postBalanceTxn(btx({ classification: 'promotion', amount: 20 }), ctx));
    expect(line(promo, A.promotionIncome, 'credit')).toBe(20);
    [lost, won, fee, odd, unmatched, promo].forEach(balanced);
    expect('skip' in postBalanceTxn(btx({ type: 'application_fee', amount: 5, classification: 'connect' }), ctx)).toBe(true);
    expect(line(post(postBalanceTxn(btx({ type: 'application_fee', amount: 5, classification: 'unmatched' }), ctx)), A.commissionSelf, 'credit')).toBe(5);
    expect('skip' in postBalanceTxn(btx({ type: 'payout', amount: 0 }), ctx)).toBe(true);
  });

  it('daily fee journal, both directions, and converts to PKR balanced', () => {
    const d = post(postDailyFees('2026-08-05', 'usd', 12.37));
    expect(line(d, A.gatewayFees, 'debit')).toBe(12.37);
    expect(d.currency).toBe('USD');
    const back = post(postDailyFees('2026-08-06', 'USD', -1.5));
    expect(line(back, A.gatewayFees, 'credit')).toBe(1.5);
    expect('skip' in postDailyFees('2026-08-07', 'USD', 0)).toBe(true);
    const pkr = convertDraftLines(d, 281.3333);
    expect(sum(pkr, 'debit')).toBe(sum(pkr, 'credit'));
    expect(pkr[0].amountOriginal).toBe(12.37);
  });
});

// ── Stripe sync with an in-memory fake (idempotency) ──────────────────────────
function memModel(rows: any[], key: string) {
  const match = (r: any, f: any): boolean => Object.entries(f ?? {}).every(([k, v]: any) => {
    const val = k.split('.').reduce((o: any, p: string) => o?.[p], r);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(val);
      if ('$lt' in v || '$gte' in v) return (v.$lt == null || val < v.$lt) && (v.$gte == null || val >= v.$gte);
      if ('$ne' in v) return val !== v.$ne;
      return true;
    }
    return val === v;
  });
  const q = (list: any[]) => { const o: any = { sort: () => o, limit: () => o, skip: () => o, select: () => o, lean: async () => list }; return o; };
  return {
    rows,
    find: (f: any) => q(rows.filter((r) => match(r, f))),
    findOne: (f: any) => q(rows.find((r) => match(r, f)) ?? null),
    countDocuments: async (f: any) => rows.filter((r) => match(r, f)).length,
    bulkWrite: async (ops: any[]) => { for (const op of ops) { const u = op.updateOne; if (!rows.some((r) => r[key] === u.filter[key])) rows.push({ ...u.update.$setOnInsert }); } },
    updateOne: async (f: any, u: any) => { let r = rows.find((x) => match(x, f)); if (!r) { r = { ...f }; rows.push(r); } Object.assign(r, u.$set ?? {}); for (const [k, v] of Object.entries(u.$inc ?? {})) r[k] = (r[k] ?? 0) + (v as number); return { modifiedCount: 1 }; },
    aggregate: async (pipe: any[]) => {
      // Only the fee-day grouping is exercised here.
      const m = pipe[0].$match;
      const g = new Map<string, any>();
      for (const r of rows.filter((x) => x.created >= m.created.$gte && x.created < m.created.$lt && x.fee !== 0)) {
        const day = r.created.toISOString().slice(0, 10); const id = `${day}:${r.currency}`;
        const cur = g.get(id) ?? { _id: { day, currency: r.currency }, fee: 0 }; cur.fee += r.fee; g.set(id, cur);
      }
      return [...g.values()];
    },
  };
}

describe('Stripe settlement sync', () => {
  const now = new Date('2026-08-10T08:00:00Z');
  beforeAll(() => { jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] }); });
  afterAll(() => jest.useRealTimers());

  it('posts each balance transaction once and each fee day once, across repeated runs', async () => {
    const stripeTxns = [
      { id: 'txn_p', type: 'payout', amount: -150000, fee: 0, net: -150000, currency: 'usd', created: Date.parse('2026-08-05T10:00:00Z') / 1000, source: { id: 'po_1', object: 'payout' } },
      { id: 'txn_c', type: 'charge', amount: 10000, fee: 320, net: 9680, currency: 'usd', created: Date.parse('2026-08-05T11:00:00Z') / 1000, source: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount: 10000, currency: 'usd' } },
    ];
    const reader: any = {
      balanceTransactions: { list: () => ({ async *[Symbol.asyncIterator]() { for (const t of stripeTxns) yield t; } }) },
      balance: { retrieve: async () => ({ available: [], pending: [] }) },
      charges: { retrieve: async () => { throw new Error('not used'); } },
      paymentIntents: { retrieve: jest.fn(async () => ({ metadata: {} })) },
    };
    const journals: any[] = [];
    const ledger: any = { postJournal: jest.fn(async (j: any) => {
      const dup = journals.find((x) => x.source.type === j.source.type && x.source.id === j.source.id);
      if (dup) return { entry: dup, duplicate: true };
      const entry = { _id: `j${journals.length + 1}`, ...j }; journals.push(entry); return { entry, duplicate: false };
    }) };
    const empty = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
    const db: any = { repositories: {
      platformPlanInvoiceModel: empty, platformPlanPaymentAttemptModel: empty, platformAddonPurchaseModel: empty,
      paymentTransactionModel: { find: () => ({ select: () => ({ lean: async () => [{ stripePaymentIntentId: 'pi_1', settledViaConnect: false }] }) }) },
      exchangeRateModel: { findOne: () => ({ sort: () => ({ lean: async () => ({ ratePerUSD: 280 }) }) }) },
    } };
    const rows = memModel([], 'btxId');
    const states = memModel([], 'sourceType');
    const journalModel: any = { find: (f: any) => ({ select: () => ({ lean: async () => journals.filter((j) => j.source.type === f['source.type'] && f['source.id'].$in.includes(j.source.id)) }) }) };
    const settings: any = { findOne: () => ({ select: () => ({ lean: async () => null }) }) };
    const svc = new StripeSettlementService(db, ledger, rows as any, journalModel, states as any, settings, reader, undefined);

    const first: any = await svc.sync();
    expect(first.fetched).toBe(2);
    expect(first.posted).toBe(1); // payout; the marketplace charge's gross is skipped
    expect(first.skipped).toBe(1);
    expect(first.feeDays).toBe(1);
    const second: any = await svc.sync();
    expect(second.posted).toBe(0);
    expect(second.feeDays).toBe(0);
    expect(journals.map((j) => `${j.source.type}:${j.source.id}`).sort()).toEqual(['stripe_btx:txn_p', 'stripe_fees:2026-08-05:USD']);
    const payout = journals.find((j) => j.source.id === 'txn_p');
    expect(sum(payout.lines, 'debit')).toBe(420000); // 1,500 USD x 280
    expect(payout.lines.find((l: any) => l.accountCode === A.bank).amountOriginal).toBe(1500);
    expect(rows.rows.find((r) => r.btxId === 'txn_c').status).toBe('skipped');
    expect(rows.rows.find((r) => r.btxId === 'txn_c').classification).toBe('marketplace');
  });

  it('does nothing without a Stripe key', async () => {
    const svc = new StripeSettlementService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, null, undefined);
    expect(await svc.sync()).toEqual({ skipped: 'not_configured' });
  });
});

// ── COD statements ────────────────────────────────────────────────────────────
describe('COD statement reading', () => {
  it('parses CSV with quotes, embedded commas and semicolon separators', () => {
    expect(parseCsv('﻿CN #,COD Amount,Charges\r\n"LE 123","1,250.00",150\n')).toEqual([['CN #', 'COD Amount', 'Charges'], ['LE 123', '1,250.00', '150']]);
    expect(parseCsv('a;b\n"x ""q""";2\n')).toEqual([['a', 'b'], ['x "q"', '2']]);
  });

  it('reads an .xlsx without any library (round trip through our own exporter)', async () => {
    const buf = await toXlsx({ title: 'TCS statement', subtitle: 'Aug', columns: [{ key: 't', label: 'CN #' }, { key: 'a', label: 'COD Amount' }, { key: 'c', label: 'Delivery Charges' }], rows: [{ t: 'TC1001', a: 2500, c: 180 }, { t: 'TC1002', a: 990.5, c: 180 }] });
    const rows = readXlsx(buf);
    expect(readStatement(buf)).toEqual(rows);
    const { headerRow, headers, mapping } = detectColumns(rows, 'tcs');
    expect(mapping).toEqual({ tracking: 'CN #', cod: 'COD Amount', charges: 'Delivery Charges' });
    expect(extractLines(rows, headerRow, headers, mapping!)).toEqual([
      { trackingNumber: 'TC1001', codCollected: 2500, charges: 180 },
      { trackingNumber: 'TC1002', codCollected: 990.5, charges: 180 },
    ]);
  });

  it('finds courier-specific columns and honours a chosen mapping', () => {
    const leo = [['Leopards remittance'], ['Booked Packet CN', 'Booked Packet Collect Amount', 'Shipment Charges'], ['LE 77', 'Rs. 3,100', '(200)'], ['Total', '3100', '200']];
    const d = detectColumns(leo, 'leopards');
    expect(d.headerRow).toBe(1);
    expect(extractLines(leo, d.headerRow, d.headers, d.mapping!)).toEqual([{ trackingNumber: 'LE77', codCollected: 3100, charges: 200 }]);
    const px = [['Tracking Number', 'Invoice Payment', 'Transaction Fee', 'Amount']];
    expect(detectColumns(px, 'postex').mapping).toEqual({ tracking: 'Tracking Number', cod: 'Invoice Payment', charges: 'Transaction Fee' });
    expect(detectColumns(px, 'postex', { cod: 'Amount' }).mapping?.cod).toBe('Amount');
    expect(detectColumns([['foo', 'bar']], 'tcs').mapping).toBeNull();
    expect(parseAmount('(150.50)')).toBe(-150.5);
    expect(parseAmount('PKR 1 250')).toBe(1250);
    expect(parseAmount('')).toBe(0);
  });
});

describe('COD matching and remittance journal', () => {
  const parcel = (o: Partial<ParcelInfo>): ParcelInfo => ({ orderId: 'o1', orderNumber: '1001', sellerOrderId: 'so1', storeId: 's1', customerId: 'u1', customerName: 'Ali', codExpected: 2500, ...o });
  const parcels = new Map<string, ParcelInfo>([['A1', parcel({})], ['A2', parcel({ sellerOrderId: 'so2', codExpected: 1000 })], ['A3', parcel({ sellerOrderId: 'so3', codExpected: 1000 })], ['A4', parcel({ sellerOrderId: 'so4', codExpected: 500 })]]);

  it('matched, short, over, unknown and both kinds of duplicate', () => {
    const lines = matchLines([
      { trackingNumber: 'A1', codCollected: 2500.4, charges: 150 },
      { trackingNumber: 'A2', codCollected: 900, charges: 150 },
      { trackingNumber: 'A3', codCollected: 1100, charges: 150 },
      { trackingNumber: 'ZZ', codCollected: 700, charges: 100 },
      { trackingNumber: 'A1', codCollected: 2500, charges: 150 },
      { trackingNumber: 'A4', codCollected: 500, charges: 50 },
    ], parcels, new Map([['A4', 'rem_old']]), 'rem_new');
    expect(lines.map((l) => l.status)).toEqual(['matched', 'short', 'over', 'unknown', 'duplicate', 'duplicate']);
    expect(lines[5].duplicateOf).toBe('rem_old');
    expect(lines[0].customerId).toBe('u1');
    // Re-matching a statement against its own claims is not a duplicate.
    expect(matchLines([{ trackingNumber: 'A4', codCollected: 500, charges: 0 }], parcels, new Map([['A4', 'rem_new']]), 'rem_new')[0].status).toBe('matched');
  });

  it('journal balances: bank net + charges + deductions = parcels cleared (+ suspense for unknown and differences)', () => {
    const lines = [
      { trackingNumber: 'A1', codCollected: 2500, charges: 150, status: 'matched', customerId: 'u1', customerName: 'Ali', storeId: 's1', orderNumber: '1001' },
      { trackingNumber: 'A2', codCollected: 900, charges: 150, status: 'short', customerId: 'u2' },
      { trackingNumber: 'ZZ', codCollected: 700, charges: 100, status: 'unknown' },
      { trackingNumber: 'A9', codCollected: -200, charges: 0, status: 'matched', customerId: 'u3' },
      { trackingNumber: 'DUP', codCollected: 999, charges: 0, status: 'duplicate' },
    ];
    const t = remittanceTotals(lines, 50, 3500);
    expect(t).toEqual({ gross: 3900, charges: 400, expectedNet: 3450, difference: 50 });
    for (const net of [3500, 3400, 3450, 0]) {
      const j = remittanceJournalLines({ courier: 'tcs', statementRef: 'S-1', bankAccount: '1010', otherDeductions: 50, netReceived: net, lines });
      expect(sum(j, 'debit')).toBe(sum(j, 'credit'));
      expect(j.some((l) => l.description?.includes('DUP'))).toBe(false);
    }
    const j = remittanceJournalLines({ courier: 'tcs', bankAccount: '1010', otherDeductions: 50, netReceived: 3500, lines });
    expect(round2(j.filter((l) => l.accountCode === A.codReceivable).reduce((s, l) => s + (l.credit ?? 0) - (l.debit ?? 0), 0))).toBe(3200);
    expect(j.find((l) => l.accountCode === A.codReceivable && l.credit === 2500)?.party).toEqual({ type: 'customer', id: 'u1', name: 'Ali' });
    expect(j.find((l) => l.accountCode === A.courierExpense)?.debit).toBe(400);
    expect(j.filter((l) => l.accountCode === A.suspense).map((l) => l.credit ?? -(l.debit ?? 0))).toEqual([700, 50]);
  });

  it('aging buckets and package COD amounts', () => {
    const now = D('2026-09-01');
    expect(agingBucket(D('2026-08-25'), now)).toEqual({ days: 7, bucket: '0-7' });
    expect(agingBucket(D('2026-08-24'), now).bucket).toBe('8-15');
    expect(agingBucket(D('2026-08-16'), now).bucket).toBe('16-30');
    expect(agingBucket(D('2026-08-01'), now)).toEqual({ days: 31, bucket: '30+' });
    expect(packageCodAmount({ totalAmount: 3000, sellerOrders: [{}] }, { codAmount: 0, subtotal: 2800 })).toBe(3000);
    expect(packageCodAmount({ totalAmount: 5000, sellerOrders: [{}, {}] }, { codAmount: 2100, subtotal: 2000 })).toBe(2100);
    expect(packageCodAmount({ totalAmount: 5000, sellerOrders: [{}, {}] }, { codAmount: 0, subtotal: 2000 })).toBe(2000);
  });
});

describe('COD remittance approval rules', () => {
  const actor = (id: string, perms: string[] | null) => ({ id, isOwner: perms === null, permissions: perms ? new Set(perms) : null });
  const make = (rem: any, claimed: any[] = []) => {
    const remittances: any = { findById: () => ({ lean: async () => rem }), updateOne: jest.fn(async () => ({ modifiedCount: 1 })) };
    const items: any = { find: () => ({ select: () => ({ lean: async () => claimed }) }), insertMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({})) };
    const ledger: any = { isClosed: async () => false, postJournal: jest.fn(async () => ({ entry: { _id: 'j1' } })) };
    const db: any = { repositories: { orderModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) }, userModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) } } };
    const svc = new CodRemittanceService(db, ledger, { log: async () => true } as any, remittances, items);
    return { svc, ledger, items };
  };
  const base = { _id: 'r1', courier: 'tcs', status: 'submitted', preparedBy: 'p1', submittedBy: 'p1', remittanceDate: D('2026-08-20'), bankAccount: '1010', otherDeductions: 0, netReceived: 600, lines: [{ trackingNumber: 'ZZ', codCollected: 700, charges: 100 }] };

  it('needs an approver who did not prepare it', async () => {
    await expect(make(base).svc.approve(actor('p2', ['accounting.prepare']), 'r1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make(base).svc.approve(actor('p1', ['accounting.approve']), 'r1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks approval while a parcel is already remitted elsewhere', async () => {
    const { svc, ledger } = make(base, [{ trackingNumber: 'ZZ', remittanceId: 'other' }]);
    await expect(svc.approve(actor('a1', ['accounting.approve']), 'r1')).rejects.toBeInstanceOf(ConflictException);
    expect(ledger.postJournal).not.toHaveBeenCalled();
  });

  it('posts one balanced journal with an idempotent source when approved', async () => {
    const { svc, ledger, items } = make(base);
    jest.spyOn(svc, 'get').mockResolvedValue({ ok: true } as any);
    await svc.approve(actor('a1', ['accounting.approve']), 'r1');
    const j = ledger.postJournal.mock.calls[0][0];
    expect(j.source).toEqual({ type: 'cod_remittance', id: 'r1', ref: null });
    expect(sum(j.lines, 'debit')).toBe(sum(j.lines, 'credit'));
    expect(items.insertMany).not.toHaveBeenCalled(); // unknown parcels are not claimed
  });
});
