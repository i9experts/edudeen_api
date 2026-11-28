/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { PremiumMembership, PremiumPlan } from '../premium/premium.schemas';
import { BASE_CURRENCY, BOOKS_START, PARTY_TYPES, type AccountType, type PartyType } from './accounting.constants';
import {
  ageBalance, balanceSheet, endOfDay, fiscalYearOf, fiscalYearStart, naturalBalance, parseDay, periodOf, profitAndLoss, round2, trialBalance,
  type AccountRow,
} from './accounting.util';
import { AccountingService } from './accounting.service';
import { JournalEntry } from './schemas/accounting.schemas';
import type { ReportTable } from './export.util';

type Q = Record<string, unknown>;

/** Control accounts a party's statement is read from (so the other side of the same entry isn't double counted). */
function partyLineFilter(type: PartyType): Record<string, unknown> {
  switch (type) {
    case 'seller': return { 'lines.accountCode': '2000' };
    case 'vendor': return { 'lines.accountCode': { $regex: '^2' } };
    case 'customer':
    case 'subscriber': return { 'lines.accountCode': { $regex: '^1' } };
    default: return {};
  }
}
/** A seller/vendor statement shows what Edudeen owes them (credit-normal); customers/subscribers what they paid. */
const partyCreditNormal = (type: PartyType) => type === 'seller' || type === 'vendor' || type === 'employee';

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: AccountingService,
    @InjectModel(JournalEntry.name) private readonly journals: Model<JournalEntry>,
    @InjectModel(PremiumMembership.name) private readonly memberships: Model<PremiumMembership>,
    @InjectModel(PremiumPlan.name) private readonly premiumPlans: Model<PremiumPlan>,
  ) {}

  private range(q: Q, defaultFrom?: Date) {
    const to = endOfDay(parseDay(q.to) ?? new Date());
    const from = parseDay(q.from) ?? defaultFrom ?? fiscalYearStart(to);
    if (from > to) throw new BadRequestException('"From" must be before "to".');
    return { from, to };
  }

  /** Debit/credit totals per account for posted entries in [from, to] (either bound optional). */
  async accountTotals(from: Date | null, to: Date | null): Promise<AccountRow[]> {
    const match: Record<string, any> = { status: 'posted' };
    if (from || to) match.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const rows = await this.journals.aggregate<{ _id: string; debit: number; credit: number }>([
      { $match: match },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.accountCode', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const accounts = await this.ledger.accountMap();
    return rows.map((r) => {
      const a = accounts.get(r._id);
      return { code: r._id, name: a?.name ?? `Unknown ${r._id}`, type: (a?.type ?? 'asset') as AccountType, subtype: a?.subtype ?? 'other', debit: round2(r.debit), credit: round2(r.credit) };
    });
  }

  private netProfit(rows: AccountRow[]) { return profitAndLoss(rows).netProfit; }

  // ── Trial balance ─────────────────────────────────────────────────────────
  async trialBalance(q: Q) {
    const asOf = endOfDay(parseDay(q.asOf) ?? new Date());
    const tb = trialBalance(await this.accountTotals(null, asOf));
    return { asOf, ...tb };
  }

  // ── Profit & loss ─────────────────────────────────────────────────────────
  async profitLoss(q: Q) {
    const { from, to } = this.range(q);
    const current = profitAndLoss(await this.accountTotals(from, to));
    const span = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - span);
    const previous = q.compare === 'false' ? null : profitAndLoss(await this.accountTotals(prevFrom, prevTo));
    let months: { period: string; income: number; expenses: number; net: number }[] | null = null;
    if (q.byMonth === 'true' || q.byMonth === '1') {
      const rows = await this.journals.aggregate<{ _id: { p: string; code: string }; debit: number; credit: number }>([
        { $match: { status: 'posted', date: { $gte: from, $lte: to } } },
        { $unwind: '$lines' },
        { $group: { _id: { p: '$period', code: '$lines.accountCode' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ]);
      const acc = await this.ledger.accountMap();
      const byP = new Map<string, { income: number; expenses: number }>();
      for (const r of rows) {
        const a = acc.get(r._id.code);
        if (!a || (a.type !== 'income' && a.type !== 'expense')) continue;
        const cur = byP.get(r._id.p) ?? { income: 0, expenses: 0 };
        if (a.type === 'income') cur.income += r.credit - r.debit; else cur.expenses += r.debit - r.credit;
        byP.set(r._id.p, cur);
      }
      months = [...byP.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({ period, income: round2(v.income), expenses: round2(v.expenses), net: round2(v.income - v.expenses) }));
    }
    return { from, to, ...current, previous: previous ? { from: prevFrom, to: prevTo, totalIncome: previous.totalIncome, totalExpenses: previous.totalExpenses, netProfit: previous.netProfit, byCode: Object.fromEntries([...previous.income, ...previous.expenses].map((l) => [l.code, l.amount])) } : null, months };
  }

  // ── Balance sheet ─────────────────────────────────────────────────────────
  async balanceSheet(q: Q) {
    const asOf = endOfDay(parseDay(q.asOf) ?? new Date());
    const fyStart = fiscalYearStart(asOf);
    const [all, prior, current] = await Promise.all([
      this.accountTotals(null, asOf),
      this.accountTotals(null, new Date(fyStart.getTime() - 1)),
      this.accountTotals(fyStart, asOf),
    ]);
    return { asOf, fiscalYear: fiscalYearOf(asOf), ...balanceSheet(all, this.netProfit(prior), this.netProfit(current)) };
  }

  // ── General ledger ────────────────────────────────────────────────────────
  async generalLedger(q: Q) {
    const code = String(q.account ?? '');
    const accounts = await this.ledger.accountMap();
    const acc = accounts.get(code);
    if (!acc) throw new BadRequestException('Choose an account.');
    const { from, to } = this.range(q, parseDay(BOOKS_START)!);
    const [openRow] = await this.journals.aggregate<{ debit: number; credit: number }>([
      { $match: { status: 'posted', 'lines.accountCode': code, date: { $lt: from } } },
      { $unwind: '$lines' }, { $match: { 'lines.accountCode': code } },
      { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const opening = naturalBalance(acc.type, openRow?.debit ?? 0, openRow?.credit ?? 0);
    const LIMIT = 5000;
    const entries = await this.journals.aggregate<any>([
      { $match: { status: 'posted', 'lines.accountCode': code, date: { $gte: from, $lte: to } } },
      { $sort: { date: 1, number: 1 } },
      { $unwind: '$lines' }, { $match: { 'lines.accountCode': code } },
      { $limit: LIMIT + 1 },
      { $project: { _id: 1, number: 1, date: 1, memo: 1, source: 1, line: '$lines' } },
    ]);
    let running = opening;
    const sign = acc.type === 'asset' || acc.type === 'expense' ? 1 : -1;
    const lines = entries.slice(0, LIMIT).map((e) => {
      running = round2(running + sign * (e.line.debit - e.line.credit));
      return {
        journalId: String(e._id), number: e.number, date: e.date, memo: e.line.description || e.memo, source: e.source ?? null,
        party: e.line.party?.name ?? null, debit: e.line.debit, credit: e.line.credit, currency: e.line.currency, amountOriginal: e.line.amountOriginal, balance: running,
      };
    });
    const debit = round2(lines.reduce((s, l) => s + l.debit, 0));
    const credit = round2(lines.reduce((s, l) => s + l.credit, 0));
    return { account: { code, name: acc.name, type: acc.type }, from, to, opening, debit, credit, closing: running, lines, truncated: entries.length > LIMIT };
  }

  // ── Party ledgers (customer / seller / vendor / subscriber / employee) ───
  async partyLedger(q: Q) {
    const type = String(q.partyType ?? '') as PartyType;
    if (!PARTY_TYPES.includes(type)) throw new BadRequestException('Choose a party type.');
    const { from, to } = this.range(q, parseDay(BOOKS_START)!);
    const lineMatch = { 'lines.party.type': type, ...partyLineFilter(type) };
    const creditNormal = partyCreditNormal(type);
    const signed = (d: number, c: number) => round2(creditNormal ? c - d : d - c);
    if (q.partyId) {
      const id = String(q.partyId);
      const match = { status: 'posted', 'lines.party.type': type, 'lines.party.id': id };
      const [openRow] = await this.journals.aggregate<{ debit: number; credit: number }>([
        { $match: { ...match, date: { $lt: from } } }, { $unwind: '$lines' }, { $match: { ...lineMatch, 'lines.party.id': id } },
        { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ]);
      const rows = await this.journals.aggregate<any>([
        { $match: { ...match, date: { $gte: from, $lte: to } } }, { $sort: { date: 1, number: 1 } },
        { $unwind: '$lines' }, { $match: { ...lineMatch, 'lines.party.id': id } }, { $limit: 5000 },
        { $project: { number: 1, date: 1, memo: 1, source: 1, line: '$lines' } },
      ]);
      const opening = signed(openRow?.debit ?? 0, openRow?.credit ?? 0);
      let running = opening;
      const lines = rows.map((e) => {
        running = round2(running + signed(e.line.debit, e.line.credit));
        return { journalId: String(e._id), number: e.number, date: e.date, memo: e.line.description || e.memo, ref: e.source?.ref ?? null, account: e.line.accountCode, debit: e.line.debit, credit: e.line.credit, balance: running };
      });
      const name = rows.find((r) => r.line.party?.name)?.line.party.name ?? null;
      return { partyType: type, partyId: id, name, from, to, opening, closing: running, lines };
    }
    // Summary: one row per party.
    const rows = await this.journals.aggregate<{ _id: string; name: string | null; openD: number; openC: number; d: number; c: number }>([
      { $match: { status: 'posted', 'lines.party.type': type, date: { $lte: to } } },
      { $unwind: '$lines' }, { $match: lineMatch },
      { $group: {
        _id: '$lines.party.id', name: { $last: '$lines.party.name' },
        openD: { $sum: { $cond: [{ $lt: ['$date', from] }, '$lines.debit', 0] } }, openC: { $sum: { $cond: [{ $lt: ['$date', from] }, '$lines.credit', 0] } },
        d: { $sum: { $cond: [{ $gte: ['$date', from] }, '$lines.debit', 0] } }, c: { $sum: { $cond: [{ $gte: ['$date', from] }, '$lines.credit', 0] } },
      } },
      { $sort: { name: 1 } }, { $limit: 5000 },
    ]);
    const parties = rows.map((r) => {
      const opening = signed(r.openD, r.openC);
      return { partyId: r._id, name: r.name, opening, debit: round2(r.d), credit: round2(r.c), closing: round2(opening + signed(r.d, r.c)) };
    }).filter((p) => p.opening !== 0 || p.debit !== 0 || p.credit !== 0);
    const total = (k: 'opening' | 'debit' | 'credit' | 'closing') => round2(parties.reduce((s, p) => s + p[k], 0));
    return { partyType: type, from, to, balanceMeaning: creditNormal ? 'owed by Edudeen' : 'paid to Edudeen (net)', parties, totals: { opening: total('opening'), debit: total('debit'), credit: total('credit'), closing: total('closing') } };
  }

  // ── Aging ─────────────────────────────────────────────────────────────────
  async aging(q: Q) {
    const kind = q.kind === 'payables' ? 'payables' : 'receivables';
    const asOf = endOfDay(parseDay(q.asOf) ?? new Date());
    const accounts = await this.ledger.accountMap();
    const codes = [...accounts.values()].filter((a) => (kind === 'receivables' ? a.subtype === 'receivable' : a.subtype === 'payable' && a.code !== '2010')).map((a) => a.code);
    const rows = await this.journals.aggregate<any>([
      { $match: { status: 'posted', date: { $lte: asOf }, 'lines.accountCode': { $in: codes } } },
      { $unwind: '$lines' }, { $match: { 'lines.accountCode': { $in: codes }, 'lines.party.id': { $type: 'string' } } },
      { $project: { date: 1, party: '$lines.party', debit: '$lines.debit', credit: '$lines.credit' } },
    ]);
    const byParty = new Map<string, { name: string | null; type: string; moves: { date: Date; increase: number; decrease: number }[] }>();
    for (const r of rows) {
      const key = `${r.party.type}:${r.party.id}`;
      const cur = byParty.get(key) ?? { name: r.party.name ?? null, type: r.party.type, moves: [] as { date: Date; increase: number; decrease: number }[] };
      cur.moves.push(kind === 'receivables' ? { date: r.date, increase: r.debit, decrease: r.credit } : { date: r.date, increase: r.credit, decrease: r.debit });
      if (r.party.name) cur.name = r.party.name;
      byParty.set(key, cur);
    }
    const items = [...byParty.entries()].map(([key, v]) => ({ key, partyType: v.type, partyId: key.split(':')[1], name: v.name, ...ageBalance(v.moves, asOf) }))
      .filter((i) => i.total !== 0).sort((a, b) => b.total - a.total);
    const sum = (k: 'current' | 'd31_60' | 'd61_90' | 'over90' | 'total') => round2(items.reduce((s, i) => s + i[k], 0));
    return { kind, asOf, accounts: codes, items, totals: { current: sum('current'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), over90: sum('over90'), total: sum('total') } };
  }

  // ── Payouts ───────────────────────────────────────────────────────────────
  async payouts(q: Q) {
    const { from, to } = this.range(q, parseDay(BOOKS_START)!);
    const filter: Record<string, any> = { createdAt: { $gte: from, $lte: to } };
    if (q.status) filter.status = String(q.status);
    const rows: any[] = await this.db.repositories.payoutModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    const storeIds = [...new Set(rows.map((r) => String(r.storeId)))];
    const stores: any[] = storeIds.length ? await this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name managementType').lean() : [];
    const sm = new Map(stores.map((s) => [String(s._id), s]));
    const items = rows.map((r) => ({
      id: String(r._id), date: r.createdAt, processedAt: r.processedAt ?? null, store: sm.get(String(r.storeId))?.name ?? r.storeId, storeId: String(r.storeId),
      managed: sm.get(String(r.storeId))?.managementType === 'managed', amount: r.amount, currency: r.currency || 'USD', status: r.status,
      method: r.payoutMethodSnapshot?.bankName || r.payoutMethodSnapshot?.type || null, source: r.source ?? null,
    }));
    const totals: Record<string, Record<string, number>> = {};
    for (const i of items) { totals[i.currency] ??= {}; totals[i.currency][i.status] = round2((totals[i.currency][i.status] ?? 0) + i.amount); }
    return { from, to, items, totals };
  }

  // ── Subscribers (seller platform plans + Premium members) ─────────────────
  async subscribers() {
    const r = this.db.repositories;
    const subs: any[] = await r.sellerPlatformSubscriptionModel.find({ status: { $in: ['trialing', 'active', 'past_due'] }, isDelete: { $ne: true } }).lean();
    const planIds = [...new Set(subs.map((s) => String(s.platformPlanId)))].filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const plans: any[] = planIds.length ? await r.platformPlanModel.find({ _id: { $in: planIds } }).select('name').lean() : [];
    const pm = new Map(plans.map((p) => [String(p._id), p.name]));
    const storeIds = [...new Set(subs.map((s) => String(s.storeId)))].filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const stores: any[] = storeIds.length ? await r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean() : [];
    const sm = new Map(stores.map((s) => [String(s._id), s.name]));
    const monthly = (amount: number, interval: string) => round2(interval === 'yearly' ? amount / 12 : amount);
    const sellerItems = subs.map((s) => ({
      id: String(s._id), store: sm.get(String(s.storeId)) ?? String(s.storeId), storeId: String(s.storeId), plan: pm.get(String(s.platformPlanId)) ?? 'Plan',
      status: s.status, interval: s.billingInterval, amountUSD: s.amountUSD, mrrUSD: s.status === 'trialing' || s.complimentary ? 0 : monthly(s.amountUSD, s.billingInterval),
      nextBillingDate: s.nextBillingDate, totalPaidUSD: s.totalPaidUSD ?? 0, provider: s.paymentProvider, complimentary: !!s.complimentary,
    }));
    const members: any[] = await this.memberships.find({ status: 'active' }).select('planId interval source currentPeriodEnd').lean();
    const pplans: any[] = await this.premiumPlans.find({}).select('name monthlyPriceUSD yearlyPriceUSD').lean();
    const pp = new Map(pplans.map((p) => [String(p._id), p]));
    let premiumMrr = 0;
    const premiumByPlan = new Map<string, { plan: string; members: number; mrrUSD: number }>();
    for (const m of members) {
      const plan = pp.get(String(m.planId));
      const mrr = m.source === 'admin_grant' || !plan ? 0 : m.interval === 'yearly' && plan.yearlyPriceUSD ? plan.yearlyPriceUSD / 12 : plan.monthlyPriceUSD;
      premiumMrr += mrr;
      const key = plan?.name ?? 'Plan';
      const cur = premiumByPlan.get(key) ?? { plan: key, members: 0, mrrUSD: 0 };
      cur.members += 1; cur.mrrUSD = round2(cur.mrrUSD + mrr);
      premiumByPlan.set(key, cur);
    }
    const rate = await this.db.repositories.exchangeRateModel.findOne({ currency: BASE_CURRENCY, isRejected: false }).sort({ effectiveFrom: -1 }).lean();
    const pkrPerUsd = rate ? Number((rate as any).ratePerUSD) : null;
    const sellerMrr = round2(sellerItems.reduce((s, i) => s + i.mrrUSD, 0));
    return {
      sellerPlans: { count: sellerItems.length, mrrUSD: sellerMrr, items: sellerItems },
      premium: { members: members.length, mrrUSD: round2(premiumMrr), byPlan: [...premiumByPlan.values()] },
      totalMrrUSD: round2(sellerMrr + premiumMrr),
      totalMrrPKR: pkrPerUsd ? round2((sellerMrr + premiumMrr) * pkrPerUsd) : null,
      pkrPerUsd,
    };
  }

  // ── Dashboard-lite ────────────────────────────────────────────────────────
  async summary() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [all, month, fy, pendingApprovals, drafts] = await Promise.all([
      this.accountTotals(null, now),
      this.accountTotals(monthStart, now),
      this.accountTotals(fiscalYearStart(now), now),
      this.journals.countDocuments({ status: 'submitted' }),
      this.journals.countDocuments({ status: 'draft' }),
    ]);
    const cash = all.filter((r) => ['cash', 'bank', 'clearing'].includes(r.subtype) || r.code === '1110')
      .map((r) => ({ code: r.code, name: r.name, balance: naturalBalance(r.type, r.debit, r.credit) })).sort((a, b) => a.code.localeCompare(b.code));
    const sellerPayable = all.find((r) => r.code === '2000');
    const inTransit = all.find((r) => r.code === '2010');
    const m = profitAndLoss(month);
    const y = profitAndLoss(fy);
    return {
      asOf: now, period: periodOf(now), fiscalYear: fiscalYearOf(now),
      cash, cashTotal: round2(cash.reduce((s, c) => s + c.balance, 0)),
      sellerPayables: sellerPayable ? naturalBalance('liability', sellerPayable.debit, sellerPayable.credit) : 0,
      payoutsInTransit: inTransit ? naturalBalance('liability', inTransit.debit, inTransit.credit) : 0,
      month: { income: m.totalIncome, expenses: m.totalExpenses, net: m.netProfit },
      fiscalYearToDate: { income: y.totalIncome, expenses: y.totalExpenses, net: y.netProfit },
      pendingApprovals, drafts,
    };
  }

  // ── Export tables ─────────────────────────────────────────────────────────
  async table(name: string, q: Q): Promise<ReportTable> {
    const d = (x: Date) => new Date(x).toISOString().slice(0, 10);
    const R = (key: string, label: string, width?: number) => ({ key, label, align: 'right' as const, width });
    const L = (key: string, label: string, width?: number) => ({ key, label, align: 'left' as const, width });
    switch (name) {
      case 'trial-balance': {
        const tb = await this.trialBalance(q);
        return { title: 'Trial balance', subtitle: `As of ${d(tb.asOf)} · ${BASE_CURRENCY}`, columns: [L('code', 'Code', 8), L('name', 'Account', 40), L('type', 'Type', 12), R('debit', 'Debit'), R('credit', 'Credit')],
          rows: [...tb.items, { code: '', name: 'Total', type: '', debit: tb.totalDebit, credit: tb.totalCredit, _bold: 1 }] };
      }
      case 'profit-loss': {
        const pl = await this.profitLoss(q);
        const prev = pl.previous?.byCode ?? {};
        const rows: ReportTable['rows'] = [{ name: 'Income', _bold: 1 }, ...pl.income.map((l) => ({ code: l.code, name: l.name, amount: l.amount, previous: prev[l.code] ?? 0 })),
          { name: 'Total income', amount: pl.totalIncome, previous: pl.previous?.totalIncome ?? null, _bold: 1 },
          { name: 'Expenses', _bold: 1 }, ...pl.expenses.map((l) => ({ code: l.code, name: l.name, amount: l.amount, previous: prev[l.code] ?? 0 })),
          { name: 'Total expenses', amount: pl.totalExpenses, previous: pl.previous?.totalExpenses ?? null, _bold: 1 },
          { name: 'Net profit', amount: pl.netProfit, previous: pl.previous?.netProfit ?? null, _bold: 1 }];
        return { title: 'Profit and loss', subtitle: `${d(pl.from)} to ${d(pl.to)} · ${BASE_CURRENCY}`, columns: [L('code', 'Code', 8), L('name', 'Account', 40), R('amount', 'This period'), R('previous', 'Previous period')], rows };
      }
      case 'balance-sheet': {
        const bs = await this.balanceSheet(q);
        const sec = (label: string, lines: { code: string; name: string; amount: number }[], total: number) => [{ name: label, _bold: 1 }, ...lines.map((l) => ({ code: l.code, name: l.name, amount: l.amount })), { name: `Total ${label.toLowerCase()}`, amount: total, _bold: 1 }];
        return { title: 'Balance sheet', subtitle: `As of ${d(bs.asOf)} · FY ${bs.fiscalYear} · ${BASE_CURRENCY}`, columns: [L('code', 'Code', 8), L('name', 'Account', 44), R('amount', 'Amount')],
          rows: [...sec('Assets', bs.assets, bs.totalAssets), ...sec('Liabilities', bs.liabilities, bs.totalLiabilities), ...sec('Equity', bs.equity, bs.totalEquity), { name: 'Liabilities + equity', amount: round2(bs.totalLiabilities + bs.totalEquity), _bold: 1 }] };
      }
      case 'general-ledger': {
        const gl = await this.generalLedger(q);
        return { title: `General ledger — ${gl.account.code} ${gl.account.name}`, subtitle: `${d(gl.from)} to ${d(gl.to)} · ${BASE_CURRENCY}`,
          columns: [L('date', 'Date', 10), L('number', 'Entry', 16), L('memo', 'Description', 40), L('party', 'Party', 20), R('debit', 'Debit'), R('credit', 'Credit'), R('balance', 'Balance')],
          rows: [{ memo: 'Opening balance', balance: gl.opening, _bold: 1 }, ...gl.lines.map((l) => ({ date: d(l.date), number: l.number, memo: l.memo, party: l.party, debit: l.debit || null, credit: l.credit || null, balance: l.balance })),
            { memo: 'Closing balance', debit: gl.debit, credit: gl.credit, balance: gl.closing, _bold: 1 }] };
      }
      case 'party-ledger': {
        const pl: any = await this.partyLedger(q);
        if (pl.partyId) {
          return { title: `${pl.partyType} statement — ${pl.name ?? pl.partyId}`, subtitle: `${d(pl.from)} to ${d(pl.to)} · ${BASE_CURRENCY}`,
            columns: [L('date', 'Date', 10), L('number', 'Entry', 16), L('memo', 'Description', 40), L('ref', 'Reference', 18), R('debit', 'Debit'), R('credit', 'Credit'), R('balance', 'Balance')],
            rows: [{ memo: 'Opening balance', balance: pl.opening, _bold: 1 }, ...pl.lines.map((l: any) => ({ date: d(l.date), number: l.number, memo: l.memo, ref: l.ref, debit: l.debit || null, credit: l.credit || null, balance: l.balance })), { memo: 'Closing balance', balance: pl.closing, _bold: 1 }] };
        }
        return { title: `${pl.partyType[0].toUpperCase()}${pl.partyType.slice(1)} ledger`, subtitle: `${d(pl.from)} to ${d(pl.to)} · balance = ${pl.balanceMeaning} · ${BASE_CURRENCY}`,
          columns: [L('name', 'Name', 40), R('opening', 'Opening'), R('debit', 'Debit'), R('credit', 'Credit'), R('closing', 'Closing')],
          rows: [...pl.parties.map((p: any) => ({ name: p.name ?? p.partyId, opening: p.opening, debit: p.debit, credit: p.credit, closing: p.closing })), { name: 'Total', ...pl.totals, _bold: 1 }] };
      }
      case 'aging': {
        const ag = await this.aging(q);
        return { title: ag.kind === 'payables' ? 'Payables aging' : 'Receivables aging', subtitle: `As of ${d(ag.asOf)} · ${BASE_CURRENCY}`,
          columns: [L('name', 'Party', 36), L('partyType', 'Type', 12), R('current', '0-30 days'), R('d31_60', '31-60'), R('d61_90', '61-90'), R('over90', '90+'), R('total', 'Total')],
          rows: [...ag.items.map((i) => ({ name: i.name ?? i.partyId, partyType: i.partyType, current: i.current, d31_60: i.d31_60, d61_90: i.d61_90, over90: i.over90, total: i.total })), { name: 'Total', ...ag.totals, _bold: 1 }] };
      }
      case 'payouts': {
        const p = await this.payouts(q);
        return { title: 'Seller payouts', subtitle: `${d(p.from)} to ${d(p.to)}`,
          columns: [L('date', 'Requested', 10), L('store', 'Store', 30), L('managed', 'Type', 10), L('method', 'Method', 16), L('status', 'Status', 12), L('currency', 'Cur.', 6), R('amount', 'Amount')],
          rows: p.items.map((i) => ({ date: d(i.date), store: i.store, managed: i.managed ? 'Managed' : 'Self', method: i.method, status: i.status, currency: i.currency, amount: i.amount })) };
      }
      case 'subscribers': {
        const s = await this.subscribers();
        return { title: 'Subscribers', subtitle: `Seller plans: ${s.sellerPlans.count} · Premium members: ${s.premium.members} · MRR USD ${s.totalMrrUSD.toFixed(2)}${s.totalMrrPKR != null ? ` (PKR ${s.totalMrrPKR.toFixed(2)})` : ''}`,
          columns: [L('store', 'Store', 30), L('plan', 'Plan', 20), L('status', 'Status', 10), L('interval', 'Billing', 10), R('amountUSD', 'Price USD'), R('mrrUSD', 'MRR USD'), L('next', 'Next bill', 12)],
          rows: [...s.sellerPlans.items.map((i) => ({ store: i.store, plan: i.plan, status: i.status, interval: i.interval, amountUSD: i.amountUSD, mrrUSD: i.mrrUSD, next: i.nextBillingDate ? d(i.nextBillingDate) : '' })),
            ...s.premium.byPlan.map((p) => ({ store: `Premium members (${p.members})`, plan: p.plan, status: 'active', interval: '', amountUSD: null, mrrUSD: p.mrrUSD, next: '' })),
            { store: 'Total MRR', mrrUSD: s.totalMrrUSD, _bold: 1 }] };
      }
      default:
        throw new BadRequestException('Unknown report.');
    }
  }
}

export const REPORT_NAMES = ['trial-balance', 'profit-loss', 'balance-sheet', 'general-ledger', 'party-ledger', 'aging', 'payouts', 'subscribers'] as const;
