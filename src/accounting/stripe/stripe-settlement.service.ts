/* eslint-disable prettier/prettier */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../../database/databaseservice';
import { RedisService } from '../../redis/redis.service';
import { BASE_CURRENCY, BOOKS_START, POSTING_ACCOUNTS as A } from '../accounting.constants';
import { parseDay, round2 } from '../accounting.util';
import { AccountingService } from '../accounting.service';
import { FxResolver } from '../posting/posting.service';
import { convertDraftLines, type PostingDraft } from '../posting/posting.rules';
import { AcctPostingState, AcctSettings, JournalEntry } from '../schemas/accounting.schemas';
import { StripeBalanceTxn } from '../schemas/settlement.schemas';
import { classifyCharge, postBalanceTxn, postDailyFees, toMajor, utcDay, type KnownPayments } from './stripe.rules';

/** Read-only slice of the Stripe SDK the sync uses (the real client is injected; tests pass a fake). */
export interface StripeReader {
  balanceTransactions: { list(params: Record<string, unknown>): AsyncIterable<any> };
  balance: { retrieve(): Promise<any> };
  charges: { retrieve(id: string): Promise<any> };
  paymentIntents: { retrieve(id: string): Promise<any> };
}
export const ACCT_STRIPE_READER = 'ACCT_STRIPE_READER';

const STATE_KEY = 'stripe_btx';
const LOCK_KEY = 'acct-stripe-sync';
/** Re-read this much before the last sync start: balance transactions are immutable, so overlap is free. */
const OVERLAP_MS = 2 * 24 * 3600_000;
const MAX_PER_RUN = 20_000;
const MAX_PI_LOOKUPS = 300;

export interface StripeSyncStats { fetched: number; posted: number; skipped: number; errors: number; feeDays: number; ms: number; complete: boolean }

@Injectable()
export class StripeSettlementService {
  private readonly logger = new Logger(StripeSettlementService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: AccountingService,
    @InjectModel(StripeBalanceTxn.name) private readonly rows: Model<StripeBalanceTxn>,
    @InjectModel(JournalEntry.name) private readonly journals: Model<JournalEntry>,
    @InjectModel(AcctPostingState.name) private readonly states: Model<AcctPostingState>,
    @InjectModel(AcctSettings.name) private readonly settings: Model<AcctSettings>,
    @Optional() @Inject(ACCT_STRIPE_READER) private readonly stripe?: StripeReader | null,
    @Optional() private readonly redis?: RedisService,
  ) {}

  get configured(): boolean { return !!this.stripe; }

  /** Pulls new platform balance transactions and posts them. Redis lock when available; journals are idempotent anyway. */
  async sync(opts: { from?: Date | null } = {}): Promise<StripeSyncStats | { skipped: 'locked' | 'not_configured' }> {
    if (!this.stripe) return { skipped: 'not_configured' };
    let out: StripeSyncStats | null = null;
    const work = async () => { out = await this.syncUnlocked(opts.from ?? null); };
    if (this.redis?.isConnected) {
      const r = await this.redis.withLock(LOCK_KEY, 30 * 60_000, work);
      if (r === 'lock_not_acquired') return { skipped: 'locked' };
    } else {
      await work();
    }
    return out!;
  }

  private async syncUnlocked(from: Date | null): Promise<StripeSyncStats> {
    const started = Date.now();
    const runStart = new Date();
    const stats: StripeSyncStats = { fetched: 0, posted: 0, skipped: 0, errors: 0, feeDays: 0, ms: 0, complete: true };
    const booksStart = parseDay(BOOKS_START)!;
    const st: any = await this.states.findOne({ sourceType: STATE_KEY }).lean();
    let since = from ?? (st?.watermark ? new Date(new Date(st.watermark).getTime() - OVERLAP_MS) : booksStart);
    if (since < booksStart) since = booksStart;

    // 1) Mirror the balance transactions (immutable at Stripe; upsert keeps our status fields).
    let lastCreated: Date | null = null;
    const fresh: any[] = [];
    for await (const b of this.stripe!.balanceTransactions.list({ created: { gte: Math.floor(since.getTime() / 1000) }, limit: 100, expand: ['data.source'] })) {
      const row = this.toRow(b);
      fresh.push({ raw: b, row });
      lastCreated = row.created;
      if (++stats.fetched >= MAX_PER_RUN) { stats.complete = false; break; }
    }
    if (fresh.length) {
      await this.rows.bulkWrite(fresh.map(({ row }) => ({
        updateOne: {
          filter: { btxId: row.btxId },
          update: { $setOnInsert: { ...row, status: 'pending', attempts: 0 } },
          upsert: true,
        },
      })), { ordered: false });
    }

    // 2) Classify and post everything not posted yet (new rows + earlier errors).
    const todo: any[] = await this.rows.find({ status: { $in: ['pending', 'error'] }, attempts: { $lt: 50 } }).sort({ created: 1 }).limit(MAX_PER_RUN).lean();
    if (todo.length) {
      await this.classify(todo);
      const fx = new FxResolver(this.db);
      const payoutBank = await this.payoutBank();
      const stores = await this.connectStores(todo);
      for (const r of todo) {
        if (new Date(r.created) < booksStart) { await this.setStatus(r.btxId, 'skipped', 'before the books start (in the opening balances)'); stats.skipped++; continue; }
        try {
          const res = postBalanceTxn(r, { payoutBank, store: r.paymentIntentId ? stores.get(r.paymentIntentId) ?? null : null });
          if ('skip' in res) { await this.setStatus(r.btxId, 'skipped', res.skip, null, r); stats.skipped++; continue; }
          const entry = await this.save(`${r.btxId}`, 'stripe_btx', res.post, fx);
          await this.setStatus(r.btxId, 'posted', null, String(entry._id), r);
          stats.posted++;
        } catch (err: any) {
          stats.errors++;
          await this.rows.updateOne({ btxId: r.btxId }, { $set: { status: 'error', reason: String(err?.message ?? err).slice(0, 300), classification: r.classification ?? null }, $inc: { attempts: 1 } });
        }
      }
    }

    // 3) One fee journal per finished UTC day and currency.
    stats.feeDays = await this.postFeeDays(runStart);

    // The watermark only moves past what was actually read.
    const watermark = stats.complete ? runStart : lastCreated;
    if (watermark && (!st?.watermark || from === null || watermark > new Date(st.watermark))) {
      await this.states.updateOne({ sourceType: STATE_KEY }, { $set: { watermark } }, { upsert: true });
    }
    stats.ms = Date.now() - started;
    await this.states.updateOne({ sourceType: STATE_KEY }, { $set: { lastRunAt: new Date(), lastRun: { posted: stats.posted, skipped: stats.skipped, errors: stats.errors, ms: stats.ms } } }, { upsert: true });
    if (stats.posted || stats.errors) this.logger.log(`Stripe settlements: ${stats.fetched} fetched, ${stats.posted} posted, ${stats.errors} error(s)`);
    return stats;
  }

  /** Stripe balance transaction -> our row (major units, upper-case currency). */
  toRow(b: any) {
    const currency = String(b.currency ?? 'usd').toUpperCase();
    const src = b.source && typeof b.source === 'object' ? b.source : null;
    const sourceId = src ? String(src.id ?? '') || null : (typeof b.source === 'string' ? b.source : null);
    // Charge-like sources carry the charge id themselves; refunds and application fees point at it.
    const chargeId = src?.object === 'charge' ? String(src.id)
      : typeof src?.charge === 'string' ? src.charge : src?.charge?.id ? String(src.charge.id) : null;
    const paymentIntentId = typeof src?.payment_intent === 'string' ? src.payment_intent : src?.payment_intent?.id ?? null;
    const destination = src?.object === 'charge' ? (typeof src.transfer_data?.destination === 'string' ? src.transfer_data.destination : src.transfer_data?.destination?.id ?? null) : null;
    return {
      btxId: String(b.id),
      type: String(b.type),
      reportingCategory: b.reporting_category ?? null,
      amount: toMajor(b.amount, currency),
      fee: toMajor(b.fee, currency),
      net: toMajor(b.net, currency),
      currency,
      created: new Date(Number(b.created) * 1000),
      availableOn: b.available_on ? new Date(Number(b.available_on) * 1000) : null,
      description: b.description ? String(b.description).slice(0, 300) : null,
      sourceId,
      chargeId,
      paymentIntentId,
      connectDestination: destination,
      chargeAmount: src?.object === 'charge' ? toMajor(src.amount, String(src.currency ?? currency)) : null,
      applicationFee: src?.object === 'charge' && src.application_fee_amount != null ? toMajor(src.application_fee_amount, String(src.currency ?? currency)) : null,
    };
  }

  /** Sets `classification` (and Connect split facts) on charge-like rows, in place. */
  private async classify(todo: any[]) {
    const chargeLike = todo.filter((r) => ['charge', 'payment', 'refund', 'payment_refund', 'payment_failure_refund', 'application_fee', 'application_fee_refund'].includes(r.type));
    if (!chargeLike.length) return;
    const r = this.db.repositories;

    // Refunds/fees point at a charge: use the charge's own row when we have it, else ask Stripe once.
    const chargeIds = [...new Set(chargeLike.map((x) => x.chargeId).filter(Boolean))] as string[];
    const chargeRows = new Map<string, any>();
    for (const c of await this.rows.find({ chargeId: { $in: chargeIds }, type: { $in: ['charge', 'payment'] } }).lean()) chargeRows.set(String(c.chargeId), c);
    for (const x of chargeLike) if (['charge', 'payment'].includes(x.type) && x.chargeId) chargeRows.set(x.chargeId, x);
    for (const id of chargeIds) {
      if (chargeRows.has(id)) continue;
      try {
        const ch = await this.stripe!.charges.retrieve(id);
        const raw = this.toRow({ id: `ch:${id}`, type: 'charge', amount: ch.amount, currency: ch.currency, created: ch.created, source: ch });
        chargeRows.set(id, raw);
      } catch { /* left unclassified -> unmatched */ }
    }
    for (const x of chargeLike) {
      const c = x.chargeId ? chargeRows.get(x.chargeId) : null;
      if (c && !x.paymentIntentId) x.paymentIntentId = c.paymentIntentId ?? null;
      if (c && !x.connectDestination) x.connectDestination = c.connectDestination ?? null;
      if (c && x.chargeAmount == null) x.chargeAmount = c.chargeAmount ?? null;
      if (c && x.applicationFee == null) x.applicationFee = c.applicationFee ?? null;
    }

    const allCharges = [...new Set(chargeLike.map((x) => x.chargeId).filter(Boolean))] as string[];
    const pis = [...new Set(chargeLike.map((x) => x.paymentIntentId).filter(Boolean))] as string[];
    const [plan, attempts, addons, txs] = await Promise.all([
      allCharges.length ? r.platformPlanInvoiceModel.find({ providerChargeId: { $in: allCharges } }).select('providerChargeId').lean() : [],
      allCharges.length ? r.platformPlanPaymentAttemptModel.find({ providerChargeId: { $in: allCharges } }).select('providerChargeId').lean() : [],
      allCharges.length ? r.platformAddonPurchaseModel.find({ providerChargeId: { $in: allCharges } }).select('providerChargeId').lean() : [],
      pis.length ? r.paymentTransactionModel.find({ stripePaymentIntentId: { $in: pis } }).select('stripePaymentIntentId settledViaConnect').lean() : [],
    ]);
    const known: KnownPayments = {
      planCharges: new Set([...(plan as any[]), ...(attempts as any[])].map((p) => String(p.providerChargeId))),
      addonCharges: new Set((addons as any[]).map((a) => String(a.providerChargeId))),
      marketplacePIs: new Map((txs as any[]).map((t) => [String(t.stripePaymentIntentId), { connect: !!t.settledViaConnect }])),
    };

    let lookups = 0;
    const metaCache = new Map<string, Record<string, string> | null>();
    for (const x of chargeLike) {
      const facts = { chargeId: x.chargeId ?? null, paymentIntentId: x.paymentIntentId ?? null, destination: x.connectDestination ?? null, metadata: null as Record<string, string> | null };
      let cls = classifyCharge(facts, known);
      if (cls === 'unmatched' && x.paymentIntentId && lookups < MAX_PI_LOOKUPS) {
        if (!metaCache.has(x.paymentIntentId)) {
          lookups++;
          try { metaCache.set(x.paymentIntentId, (await this.stripe!.paymentIntents.retrieve(x.paymentIntentId))?.metadata ?? null); } catch { metaCache.set(x.paymentIntentId, null); }
        }
        cls = classifyCharge({ ...facts, metadata: metaCache.get(x.paymentIntentId) ?? null }, known);
      }
      x.classification = cls;
    }
  }

  /** PaymentIntent -> the connected seller's store, for Connect rows (party + MOU vs self-managed commission). */
  private async connectStores(todo: any[]): Promise<Map<string, { id: string; name: string | null; managed: boolean }>> {
    const out = new Map<string, { id: string; name: string | null; managed: boolean }>();
    const pis = [...new Set(todo.filter((t) => t.classification === 'connect' && t.paymentIntentId).map((t) => String(t.paymentIntentId)))];
    if (!pis.length) return out;
    const r = this.db.repositories;
    const txs: any[] = await r.paymentTransactionModel.find({ stripePaymentIntentId: { $in: pis } }).select('stripePaymentIntentId storeId checkoutId').lean();
    const checkoutIds = txs.filter((t) => !t.storeId && t.checkoutId).map((t) => String(t.checkoutId)).filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const checkouts: any[] = checkoutIds.length ? await r.checkoutModel.find({ _id: { $in: checkoutIds } }).select('items.storeId').lean() : [];
    const checkoutStore = new Map(checkouts.map((c) => [String(c._id), c.items?.[0]?.storeId ? String(c.items[0].storeId) : null]));
    const storeIds = [...new Set(txs.map((t) => t.storeId ? String(t.storeId) : checkoutStore.get(String(t.checkoutId)) ?? null).filter(Boolean))] as string[];
    const stores: any[] = storeIds.length ? await r.storeModel.find({ _id: { $in: storeIds } }).select('name managementType').lean() : [];
    const byId = new Map(stores.map((s) => [String(s._id), s]));
    for (const t of txs) {
      const sid = t.storeId ? String(t.storeId) : checkoutStore.get(String(t.checkoutId)) ?? null;
      const s = sid ? byId.get(sid) : null;
      if (sid) out.set(String(t.stripePaymentIntentId), { id: sid, name: s?.name ?? null, managed: s?.managementType === 'managed' });
    }
    return out;
  }

  private async postFeeDays(runStart: Date): Promise<number> {
    const booksStart = parseDay(BOOKS_START)!;
    const todayStart = parseDay(utcDay(runStart))!;
    const groups = await this.rows.aggregate<{ _id: { day: string; currency: string }; fee: number }>([
      { $match: { created: { $gte: booksStart, $lt: todayStart }, fee: { $ne: 0 } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$created' } }, currency: '$currency' }, fee: { $sum: '$fee' } } },
    ]);
    if (!groups.length) return 0;
    const ids = groups.map((g) => `${g._id.day}:${g._id.currency}`);
    const done = new Set((await this.journals.find({ 'source.type': 'stripe_fees', 'source.id': { $in: ids } }).select('source.id').lean()).map((j: any) => j.source.id));
    const fx = new FxResolver(this.db);
    let posted = 0;
    for (const g of groups) {
      const id = `${g._id.day}:${g._id.currency}`;
      if (done.has(id)) continue;
      const res = postDailyFees(g._id.day, g._id.currency, g.fee);
      if ('skip' in res) continue;
      try { await this.save(id, 'stripe_fees', res.post, fx); posted++; } catch (err: any) { this.logger.warn(`Stripe fee journal ${id} failed: ${err?.message}`); }
    }
    return posted;
  }

  private async save(id: string, type: 'stripe_btx' | 'stripe_fees', draft: PostingDraft, fx: FxResolver) {
    const { fxRate, flag } = await fx.rate(draft.currency, draft.date);
    const lines = convertDraftLines(draft, fxRate, BASE_CURRENCY);
    const { entry } = await this.ledger.postJournal({
      date: draft.date, memo: draft.memo, lines, kind: 'auto', preparedBy: 'system', approvedBy: 'system',
      source: { type, id, ref: draft.ref }, flags: flag ? [flag] : [],
    });
    return entry;
  }

  private async setStatus(btxId: string, status: 'posted' | 'skipped', reason: string | null, journalId: string | null = null, r?: any) {
    await this.rows.updateOne({ btxId }, {
      $set: {
        status, reason, journalId,
        ...(r ? { classification: r.classification ?? null, paymentIntentId: r.paymentIntentId ?? null, connectDestination: r.connectDestination ?? null, chargeAmount: r.chargeAmount ?? null, applicationFee: r.applicationFee ?? null } : {}),
      },
    });
  }

  private async payoutBank(): Promise<string> {
    const s: any = await this.settings.findOne({ key: 'default' }).select('stripePayoutBankAccount').lean();
    return s?.stripePayoutBankAccount || A.bank;
  }

  // ── Screens ─────────────────────────────────────────────────────────────────
  async status() {
    const [st, byStatus, byClass, payouts, feeJournals] = await Promise.all([
      this.states.findOne({ sourceType: STATE_KEY }).lean(),
      this.rows.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      this.rows.aggregate<{ _id: string; n: number; amount: number }>([{ $match: { classification: { $ne: null } } }, { $group: { _id: '$classification', n: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
      this.rows.find({ type: { $in: ['payout', 'payout_cancel', 'payout_failure'] } }).sort({ created: -1 }).limit(20).lean(),
      this.journals.find({ 'source.type': 'stripe_fees', status: 'posted' }).sort({ date: -1 }).limit(14).select('date total memo source lines').lean(),
    ]);
    return {
      configured: this.configured,
      booksStart: BOOKS_START,
      watermark: (st as any)?.watermark ?? null,
      lastRunAt: (st as any)?.lastRunAt ?? null,
      lastRun: (st as any)?.lastRun ?? null,
      payoutBank: await this.payoutBank(),
      counts: Object.fromEntries(byStatus.map((x) => [x._id, x.n])),
      byClassification: byClass.map((x) => ({ classification: x._id, count: x.n, amount: round2(x.amount) })),
      payouts: payouts.map((p: any) => ({ btxId: p.btxId, type: p.type, amount: p.amount, currency: p.currency, created: p.created, status: p.status, journalId: p.journalId })),
      feeDays: feeJournals.map((j: any) => ({ id: j.source?.id, date: j.date, totalPkr: j.total, currency: j.lines?.[0]?.currency ?? BASE_CURRENCY, amountOriginal: j.lines?.[0]?.amountOriginal ?? null })),
    };
  }

  async list(q: { status?: string; type?: string; classification?: string; page?: number; limit?: number }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.type) filter.type = q.type;
    if (q.classification) filter.classification = q.classification;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const page = Math.max(Number(q.page) || 1, 1);
    const [items, total] = await Promise.all([
      this.rows.find(filter).sort({ created: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.rows.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  /**
   * Books vs Stripe: the Stripe clearing account's balance per original currency (from the journal lines' original
   * amounts) next to Stripe's available + pending balance. Differences come from receipts booked before Stripe
   * settles them (order completed vs paid), FX rounding, and anything still waiting for review.
   */
  async reconciliation() {
    const ledger = await this.journals.aggregate<{ _id: string; original: number; pkr: number }>([
      { $match: { status: 'posted' } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': A.stripeClearing } },
      {
        $group: {
          _id: { $ifNull: ['$lines.currency', BASE_CURRENCY] },
          original: { $sum: { $multiply: [{ $ifNull: ['$lines.amountOriginal', { $add: ['$lines.debit', '$lines.credit'] }] }, { $cond: [{ $gt: ['$lines.debit', 0] }, 1, -1] }] } },
          pkr: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        },
      },
    ]);
    let stripeBalances: { currency: string; available: number; pending: number }[] = [];
    let stripeError: string | null = null;
    if (this.stripe) {
      try {
        const bal = await this.stripe.balance.retrieve();
        const map = new Map<string, { available: number; pending: number }>();
        for (const a of bal?.available ?? []) { const c = String(a.currency).toUpperCase(); const m = map.get(c) ?? { available: 0, pending: 0 }; m.available += toMajor(a.amount, c); map.set(c, m); }
        for (const p of bal?.pending ?? []) { const c = String(p.currency).toUpperCase(); const m = map.get(c) ?? { available: 0, pending: 0 }; m.pending += toMajor(p.amount, c); map.set(c, m); }
        stripeBalances = [...map.entries()].map(([currency, v]) => ({ currency, available: round2(v.available), pending: round2(v.pending) }));
      } catch (err: any) { stripeError = String(err?.message ?? err).slice(0, 200); }
    }
    const currencies = [...new Set([...ledger.map((l) => l._id), ...stripeBalances.map((s) => s.currency)])].sort();
    const rows = currencies.map((c) => {
      const l = ledger.find((x) => x._id === c);
      const s = stripeBalances.find((x) => x.currency === c);
      const books = round2(l?.original ?? 0);
      const stripe = s ? round2(s.available + s.pending) : null;
      return { currency: c, books, booksPkr: round2(l?.pkr ?? 0), stripeAvailable: s?.available ?? null, stripePending: s?.pending ?? null, stripe, difference: stripe == null ? null : round2(stripe - books) };
    });
    const review = await this.rows.find({ $or: [{ status: { $in: ['error', 'pending'] } }, { classification: { $in: ['unmatched', 'gift_card'] } }, { status: 'posted', type: { $in: ['adjustment'] } }] })
      .sort({ created: -1 }).limit(100).lean();
    const suspense = await this.journals.aggregate<{ _id: null; pkr: number }>([
      { $match: { status: 'posted', 'source.type': 'stripe_btx' } }, { $unwind: '$lines' }, { $match: { 'lines.accountCode': A.suspense } },
      { $group: { _id: null, pkr: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]);
    return { configured: this.configured, stripeError, rows, suspensePkr: round2(suspense[0]?.pkr ?? 0), review };
  }
}
