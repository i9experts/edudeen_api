/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { sendMail } from '../common/mailer.util';
import { PayrollClaim, PayrollRun, StaffAdvance, TaxYearConfig } from '../payroll/schemas/payroll.schemas';
import { mouStatus } from '../managed-stores/managed-stores.util';
import { BASE_CURRENCY } from './accounting.constants';
import { fiscalYearOf, fiscalYearStart, naturalBalance, periodOf, round2 } from './accounting.util';
import type { AcctActor } from './accounting.service';
import { ReportsService } from './reports.service';
import { PostingService } from './posting/posting.service';
import { toXlsx, type ReportTable } from './export.util';
import { AcctSettings, JournalEntry } from './schemas/accounting.schemas';
import {
  PAYROLL_EXPENSE_CODES, cleanRecipients, convertTotalsToPkr, expenseTotal, fiscalPeriodsUpTo, isCashLike, monthlySeries, packMonth, revenueMix,
  type PeriodAccountRow,
} from './dashboard.util';

const CACHE_MS = 2 * 60_000;

/** Seeing payroll queue items (run/advance/claim counts) needs a payroll right, like the payroll pages themselves. */
const seesPayroll = (a: AcctActor) => a.isOwner || ['payroll.view', 'payroll.approve', 'claims.approve'].some((p) => a.permissions?.has(p));

/** The finance pack: one xlsx per report for a month, zipped. Names are stable so finance can script against them. */
export const FINANCE_PACK_FILES = [
  'profit-and-loss', 'balance-sheet', 'trial-balance', 'general-ledger', 'seller-ledger', 'payouts', 'subscribers',
] as const;

@Injectable()
export class AccountingDashboardService {
  private readonly logger = new Logger(AccountingDashboardService.name);
  private cache = new Map<string, { at: number; data: unknown }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService,
    private readonly posting: PostingService,
    private readonly activity: ActivityLogService,
    @InjectModel(JournalEntry.name) private readonly journals: Model<JournalEntry>,
    @InjectModel(AcctSettings.name) private readonly settings: Model<AcctSettings>,
    @InjectModel(PayrollRun.name) private readonly runs: Model<PayrollRun>,
    @InjectModel(StaffAdvance.name) private readonly advances: Model<StaffAdvance>,
    @InjectModel(PayrollClaim.name) private readonly claims: Model<PayrollClaim>,
    @InjectModel(TaxYearConfig.name) private readonly taxYears: Model<TaxYearConfig>,
  ) {}

  // ── Dashboard ───────────────────────────────────────────────────────────────
  async dashboard(actor: AcctActor, refresh = false) {
    const key = seesPayroll(actor) ? 'full' : 'books';
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const data = await this.build(seesPayroll(actor));
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  private async build(withPayroll: boolean, now = new Date()) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const fyStart = fiscalYearStart(now);
    const [summary, monthRows, fyRows, beforeFy, byPeriod, subscribers, gmv, postingStatus, approvals, alerts] = await Promise.all([
      this.reports.summary(),
      this.reports.accountTotals(monthStart, now),
      this.reports.accountTotals(fyStart, now),
      this.reports.accountTotals(null, new Date(fyStart.getTime() - 1)),
      this.periodRows(fyStart, now),
      this.reports.subscribers().catch(() => null),
      this.gmv(monthStart, now),
      this.posting.status().catch(() => null),
      this.approvals(withPayroll),
      this.alerts(withPayroll, now),
    ]);
    const openingCash = round2(beforeFy.filter((r) => r.type === 'asset' && isCashLike(r)).reduce((s, r) => s + naturalBalance('asset', r.debit, r.credit), 0));
    const series = monthlySeries(fiscalPeriodsUpTo(fyStart, periodOf(now)), byPeriod, openingCash);
    return {
      asOf: now, currency: BASE_CURRENCY, period: periodOf(now), fiscalYear: fiscalYearOf(now),
      cash: { total: summary.cashTotal, accounts: summary.cash },
      revenueMonth: revenueMix(monthRows),
      revenueYear: revenueMix(fyRows),
      gmvMonth: gmv,
      sellerPayables: summary.sellerPayables,
      payoutsInTransit: summary.payoutsInTransit,
      payoutsDue: await this.payoutsDue(),
      payrollCost: { month: expenseTotal(monthRows, PAYROLL_EXPENSE_CODES), fiscalYearToDate: expenseTotal(fyRows, PAYROLL_EXPENSE_CODES) },
      profit: { month: summary.month, fiscalYearToDate: summary.fiscalYearToDate },
      subscribers: subscribers
        ? { sellerPlans: subscribers.sellerPlans.count, premiumMembers: subscribers.premium.members, mrrUSD: subscribers.totalMrrUSD, mrrPKR: subscribers.totalMrrPKR }
        : null,
      series,
      approvals,
      postingErrors: postingStatus ? { count: postingStatus.errors.length, latest: postingStatus.errors.slice(0, 5) } : null,
      alerts,
    };
  }

  /** Posted debit/credit per (period, account) since the fiscal year start, with account type/subtype. */
  private async periodRows(from: Date, to: Date): Promise<PeriodAccountRow[]> {
    const rows = await this.journals.aggregate<{ _id: { p: string; code: string }; debit: number; credit: number }>([
      { $match: { status: 'posted', date: { $gte: from, $lte: to } } },
      { $unwind: '$lines' },
      { $group: { _id: { p: '$period', code: '$lines.accountCode' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const totals = await this.reports.accountTotals(null, to);
    const meta = new Map(totals.map((t) => [t.code, t]));
    return rows.map((r) => {
      const m = meta.get(r._id.code);
      return { period: r._id.p, code: r._id.code, type: m?.type ?? 'asset', subtype: m?.subtype ?? 'other', debit: r.debit, credit: r.credit };
    });
  }

  /** Gross merchandise value this month: buyer orders placed (not free claims, deleted, failed or fully refunded), in PKR. */
  private async gmv(from: Date, to: Date) {
    const r = this.db.repositories;
    const byCurrency = await r.orderModel.aggregate<{ _id: string | null; total: number; count: number }>([
      { $match: { createdAt: { $gte: from, $lte: to }, isFreeClaim: { $ne: true }, isDelete: { $ne: true }, paymentStatus: { $nin: ['failed', 'refunded'] } } },
      { $group: { _id: '$currency', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]);
    const rates = await this.latestRates();
    return convertTotalsToPkr(byCurrency.map((x) => ({ currency: x._id ?? 'PKR', total: x.total ?? 0, count: x.count })), rates);
  }

  private async latestRates(): Promise<Record<string, number>> {
    const rows = await this.db.repositories.exchangeRateModel.aggregate<{ _id: string; rate: number }>([
      { $match: { isRejected: { $ne: true } } },
      { $sort: { effectiveFrom: -1 } },
      { $group: { _id: '$currency', rate: { $first: '$ratePerUSD' } } },
    ]);
    return Object.fromEntries(rows.map((x) => [String(x._id).toUpperCase(), Number(x.rate)]));
  }

  /** Seller payouts waiting to be paid (pending/processing), by currency. */
  private async payoutsDue() {
    const rows = await this.db.repositories.payoutModel.aggregate<{ _id: { cur: string; status: string }; amount: number; n: number }>([
      { $match: { status: { $in: ['pending', 'processing'] } } },
      { $group: { _id: { cur: { $ifNull: ['$currency', 'USD'] }, status: '$status' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]);
    return rows.map((x) => ({ currency: x._id.cur, status: x._id.status, amount: round2(x.amount), count: x.n }));
  }

  private async approvals(withPayroll: boolean) {
    const [journals, latest] = await Promise.all([
      this.journals.countDocuments({ status: 'submitted' }),
      this.journals.find({ status: 'submitted' }).sort({ submittedAt: -1, updatedAt: -1 }).limit(5).select('number date memo total').lean(),
    ]);
    const out: Record<string, unknown> = {
      journals: { count: journals, latest: latest.map((j: any) => ({ id: String(j._id), number: j.number ?? null, date: j.date, memo: j.memo, total: j.total ?? null })) },
    };
    if (withPayroll) {
      const [runs, advances, claims] = await Promise.all([
        this.runs.find({ status: 'submitted' }).select('month totals').lean(),
        this.advances.countDocuments({ status: 'submitted' }),
        this.claims.countDocuments({ status: 'submitted' }),
      ]);
      out.payrollRuns = (runs as any[]).map((r) => ({ id: String(r._id), month: r.month, net: r.totals?.net ?? null, people: r.totals?.people ?? null }));
      out.advances = advances;
      out.claims = claims;
    }
    return out;
  }

  private async alerts(withPayroll: boolean, now: Date) {
    const stores: any[] = await this.db.repositories.storeModel
      .find({ isDelete: { $ne: true }, managementType: 'managed', 'mou.endDate': { $ne: null } })
      .select('+mou name')
      .lean();
    const mou = stores
      .map((s) => ({ storeId: String(s._id), name: s.name, endDate: s.mou?.endDate ?? null, status: mouStatus(s.mou ?? null, now) }))
      .filter((s) => s.status === 'expired' || s.status === 'expiring_soon')
      .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())
      .slice(0, 10);
    const taxYears = withPayroll ? ((await this.taxYears.find({ needsVerification: true }).select('year').lean()) as any[]).map((t) => t.year) : [];
    return { mou, unverifiedTaxYears: taxYears };
  }

  // ── Finance pack ────────────────────────────────────────────────────────────
  /** The month's statements as xlsx files in one zip. Report math is the same as the individual exports. */
  async financePackTables(monthInput: unknown): Promise<{ month: string; tables: { file: string; table: ReportTable }[] }> {
    const { month, from, to } = packMonth(monthInput);
    if (from.getTime() > Date.now()) throw new BadRequestException('Choose a month that has started.');
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const range = { from: day(from), to: day(to) };
    const [pl, bs, tb, gl, sellers, payouts, subs] = await Promise.all([
      this.reports.table('profit-loss', range),
      this.reports.table('balance-sheet', { asOf: range.to }),
      this.reports.table('trial-balance', { asOf: range.to }),
      this.generalLedgerAll(from, to),
      this.reports.table('party-ledger', { partyType: 'seller', ...range }),
      this.reports.table('payouts', range),
      this.reports.table('subscribers', {}),
    ]);
    const tables: { file: string; table: ReportTable }[] = [
      { file: 'profit-and-loss', table: pl }, { file: 'balance-sheet', table: bs }, { file: 'trial-balance', table: tb },
      { file: 'general-ledger', table: gl }, { file: 'seller-ledger', table: sellers }, { file: 'payouts', table: payouts },
      { file: 'subscribers', table: { ...subs, subtitle: `${subs.subtitle} · as of today (subscriptions are not dated by month)` } },
    ];
    return { month, tables };
  }

  async financePack(actor: AcctActor, monthInput: unknown): Promise<{ body: Buffer; fileName: string }> {
    const { month, tables } = await this.financePackTables(monthInput);
    const zip = archiver('zip', { zlib: { level: 9 } });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => { out.on('end', () => resolve()); zip.on('error', reject); });
    zip.pipe(out);
    for (const t of tables) zip.append(await toXlsx(t.table), { name: `edudeen-${month}-${t.file}.xlsx` });
    await zip.finalize();
    await done;
    void this.activity.log({
      category: 'accounting', action: 'finance_pack_downloaded', description: `Finance pack downloaded for ${month}`, actorId: actor.id, actorRole: 'admin',
      targetId: null, targetType: 'accounting', ip: actor.ip, userAgent: actor.userAgent, metadata: { month },
    }).catch(() => undefined);
    return { body: Buffer.concat(chunks), fileName: `edudeen-finance-pack-${month}.zip` };
  }

  /** Every posted line in [from, to], grouped by account, with each account's opening and closing balance. */
  async generalLedgerAll(from: Date, to: Date): Promise<ReportTable> {
    const LIMIT = 20_000;
    const [opening, lines] = await Promise.all([
      this.reports.accountTotals(null, new Date(from.getTime() - 1)),
      this.journals.aggregate<any>([
        { $match: { status: 'posted', date: { $gte: from, $lte: to } } },
        { $unwind: '$lines' },
        { $sort: { 'lines.accountCode': 1, date: 1, number: 1 } },
        { $limit: LIMIT + 1 },
        { $project: { number: 1, date: 1, memo: 1, line: '$lines' } },
      ]),
    ]);
    const totals = await this.reports.accountTotals(null, to);
    const meta = new Map(totals.map((t) => [t.code, t]));
    const openMap = new Map(opening.map((o) => [o.code, naturalBalance(o.type, o.debit, o.credit)]));
    const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const rows: ReportTable['rows'] = [];
    let current: string | null = null;
    let running = 0;
    let sign = 1;
    const close = () => { if (current) rows.push({ memo: 'Closing balance', balance: round2(running), _bold: 1 }); };
    for (const l of lines.slice(0, LIMIT)) {
      const code = l.line.accountCode as string;
      if (code !== current) {
        close();
        current = code;
        const m = meta.get(code);
        sign = m && (m.type === 'asset' || m.type === 'expense') ? 1 : -1;
        running = openMap.get(code) ?? 0;
        rows.push({ account: `${code} ${m?.name ?? ''}`.trim(), memo: 'Opening balance', balance: round2(running), _bold: 1 });
      }
      running = round2(running + sign * ((l.line.debit ?? 0) - (l.line.credit ?? 0)));
      rows.push({ date: day(l.date), number: l.number, memo: l.line.description || l.memo, party: l.line.party?.name ?? null, debit: l.line.debit || null, credit: l.line.credit || null, balance: running });
    }
    close();
    const note = lines.length > LIMIT ? ` · first ${LIMIT} lines only (export the account's own ledger for the rest)` : '';
    return {
      title: 'General ledger — all accounts', subtitle: `${day(from)} to ${day(to)} · ${BASE_CURRENCY}${note}`,
      columns: [
        { key: 'account', label: 'Account', align: 'left', width: 30 }, { key: 'date', label: 'Date', align: 'left', width: 10 },
        { key: 'number', label: 'Entry', align: 'left', width: 16 }, { key: 'memo', label: 'Description', align: 'left', width: 40 },
        { key: 'party', label: 'Party', align: 'left', width: 20 }, { key: 'debit', label: 'Debit', align: 'right' },
        { key: 'credit', label: 'Credit', align: 'right' }, { key: 'balance', label: 'Balance', align: 'right' },
      ],
      rows,
    };
  }

  // ── Sharing settings + monthly notice ───────────────────────────────────────
  async getSettings() {
    const s: any = await this.settings.findOne({ key: 'default' }).lean();
    return { financePackEmailEnabled: !!s?.financePackEmailEnabled, financePackRecipients: s?.financePackRecipients ?? [], financePackLastSent: s?.financePackLastSent ?? null };
  }

  async saveSettings(actor: AcctActor, dto: { financePackEmailEnabled?: unknown; financePackRecipients?: unknown }) {
    if (!(actor.isOwner || actor.permissions?.has('accounting.approve'))) throw new ForbiddenException('Only an accounting approver can change who gets the finance pack.');
    const recipients = cleanRecipients(dto.financePackRecipients);
    const enabled = dto.financePackEmailEnabled === true;
    if (enabled && !recipients.length) throw new BadRequestException('Add at least one e-mail address, or turn the monthly e-mail off.');
    await this.settings.updateOne(
      { key: 'default' },
      { $set: { financePackEmailEnabled: enabled, financePackRecipients: recipients, updatedBy: actor.id } },
      { upsert: true },
    );
    void this.activity.log({
      category: 'accounting', action: 'finance_pack_settings', description: `Finance pack e-mail ${enabled ? 'on' : 'off'} (${recipients.length} recipient(s))`,
      actorId: actor.id, actorRole: 'admin', targetId: null, targetType: 'accounting', ip: actor.ip, userAgent: actor.userAgent, metadata: { enabled, recipients },
    }).catch(() => undefined);
    return this.getSettings();
  }

  /**
   * Monthly (3rd): tells the finance team last month's pack is ready. The e-mail carries only a sign-in link — never
   * the statements themselves — so the books stay behind the admin login. Each month goes out once.
   */
  async sendMonthlyNotice(now = new Date()): Promise<{ sent: number; month: string | null }> {
    const s: any = await this.settings.findOne({ key: 'default' }).lean();
    if (!s?.financePackEmailEnabled || !s.financePackRecipients?.length) return { sent: 0, month: null };
    const { month } = packMonth(undefined, now);
    const claimed = await this.settings.updateOne({ key: 'default', financePackLastSent: { $ne: month } }, { $set: { financePackLastSent: month } });
    if (!claimed.modifiedCount) return { sent: 0, month };
    const base = (process.env.WEB_APP_URL || 'https://edudeen.com').replace(/\/+$/, '');
    const link = `${base}/admin/accounting?pack=${month}`;
    const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    let sent = 0;
    for (const to of s.financePackRecipients as string[]) {
      try {
        await sendMail({
          to,
          subject: `Edudeen finance pack for ${label} is ready`,
          text: `The finance pack for ${label} (P&L, balance sheet, trial balance, general ledger, seller ledger, payouts, subscribers) is ready. Sign in to download it: ${link}`,
          html: `<p>The finance pack for <strong>${label}</strong> is ready: P&amp;L, balance sheet, trial balance, general ledger, seller ledger, payouts and subscribers (Excel).</p><p><a href="${link}">Sign in to download it</a></p><p style="color:#5B6973;font-size:12px">For security the statements are not attached. You need an Edudeen admin account with accounting access.</p>`,
        });
        sent++;
      } catch (err: any) {
        this.logger.warn(`Finance pack notice failed: ${err?.message}`);
      }
    }
    return { sent, month };
  }
}
