/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  ACCOUNT_SUBTYPES, ACCOUNT_TYPES, ASSET_CATEGORIES, BASE_CURRENCY, BOOKS_START, PARTY_TYPES, POSTING_ACCOUNTS, SEED_ACCOUNTS,
  type AccountSubtype, type AccountType, type SourceType,
} from './accounting.constants';
import {
  depreciationMonthIndex, fiscalYearOf, monthlyDepreciation, normaliseLines, parseDay, periodEnd, periodOf, periodsBetween, round2,
  type LineInput,
} from './accounting.util';
import {
  Account, AcctCounter, AccountingPeriod, FixedAsset, JournalEntry, Vendor,
} from './schemas/accounting.schemas';

/** Who is acting: the owner (no staff permissions) or a staff member with their permission set. */
export interface AcctActor { id: string; isOwner: boolean; permissions: Set<string> | null; ip?: string; userAgent?: string }

export interface PostJournalInput {
  date: Date;
  memo: string;
  lines: LineInput[];
  source?: { type: SourceType; id: string; ref?: string | null } | null;
  kind?: 'manual' | 'auto' | 'opening';
  preparedBy?: string | null;
  approvedBy?: string | null;
  flags?: string[];
}

const isDupKey = (e: any) => e?.code === 11000;

@Injectable()
export class AccountingService implements OnModuleInit {
  private readonly logger = new Logger(AccountingService.name);

  constructor(
    @InjectModel(Account.name) private readonly accounts: Model<Account>,
    @InjectModel(JournalEntry.name) private readonly journals: Model<JournalEntry>,
    @InjectModel(AccountingPeriod.name) private readonly periods: Model<AccountingPeriod>,
    @InjectModel(FixedAsset.name) private readonly assets: Model<FixedAsset>,
    @InjectModel(Vendor.name) private readonly vendors: Model<Vendor>,
    @InjectModel(AcctCounter.name) private readonly counters: Model<AcctCounter>,
    private readonly activity: ActivityLogService,
  ) {}

  async onModuleInit() {
    try {
      const n = await this.seedAccounts();
      if (n) this.logger.log(`Chart of accounts: ${n} account(s) added`);
    } catch (err: any) {
      this.logger.error(`Chart of accounts seed failed: ${err?.message}`);
    }
  }

  /** Idempotent: adds missing seeded accounts, never touches an existing one (admins may have renamed it). */
  async seedAccounts(): Promise<number> {
    const res = await this.accounts.bulkWrite(SEED_ACCOUNTS.map((a) => ({
      updateOne: {
        filter: { code: a.code },
        update: { $setOnInsert: { code: a.code, name: a.name, type: a.type, subtype: a.subtype, parentCode: a.parent ?? null, description: a.description ?? null, isSystem: true, isActive: true, currency: null } },
        upsert: true,
      },
    })), { ordered: false });
    return res.upsertedCount ?? 0;
  }

  private log(actor: AcctActor, action: string, description: string, targetId?: string | null, metadata?: Record<string, unknown>) {
    void this.activity.log({
      category: 'accounting', action, description, actorId: actor.id, actorRole: 'admin',
      targetId: targetId ?? null, targetType: 'accounting', ip: actor.ip, userAgent: actor.userAgent, metadata,
    }).catch(() => undefined);
  }

  private canApprove(actor: AcctActor) {
    return actor.isOwner || !!actor.permissions?.has('accounting.approve');
  }

  // ── Accounts ────────────────────────────────────────────────────────────────
  async listAccounts(includeInactive = true) {
    const rows = await this.accounts.find(includeInactive ? {} : { isActive: true }).sort({ code: 1 }).lean();
    const used = new Set<string>(await this.journals.distinct('lines.accountCode', { status: 'posted' }));
    return rows.map((a) => ({ ...a, inUse: used.has(a.code) }));
  }

  async accountMap(): Promise<Map<string, { code: string; name: string; type: AccountType; subtype: AccountSubtype; isActive: boolean }>> {
    const rows = await this.accounts.find({}).select('code name type subtype isActive').lean();
    return new Map(rows.map((r) => [r.code, r as any]));
  }

  async createAccount(actor: AcctActor, dto: { code: string; name: string; type: string; subtype: string; parentCode?: string | null; description?: string | null; currency?: string | null }) {
    const code = String(dto.code ?? '').trim();
    if (!/^\d{3,6}$/.test(code)) throw new BadRequestException('Account code must be 3 to 6 digits.');
    if (!ACCOUNT_TYPES.includes(dto.type as AccountType)) throw new BadRequestException('Unknown account type.');
    if (!ACCOUNT_SUBTYPES.includes(dto.subtype as AccountSubtype)) throw new BadRequestException('Unknown account subtype.');
    if (!dto.name?.trim()) throw new BadRequestException('Give the account a name.');
    if (['current_earnings'].includes(dto.subtype)) throw new BadRequestException('That subtype is reserved.');
    try {
      const doc = await this.accounts.create({
        code, name: dto.name.trim(), type: dto.type as AccountType, subtype: dto.subtype as AccountSubtype, parentCode: dto.parentCode || null,
        description: dto.description?.trim() || null, currency: dto.currency ? dto.currency.toUpperCase() : null, isSystem: false, isActive: true,
      });
      this.log(actor, 'account_created', `Account ${code} ${dto.name} created`, String(doc._id));
      return doc.toObject();
    } catch (e) {
      if (isDupKey(e)) throw new ConflictException(`Account code ${code} already exists.`);
      throw e;
    }
  }

  async updateAccount(actor: AcctActor, code: string, dto: { name?: string; description?: string | null; parentCode?: string | null; isActive?: boolean; subtype?: string; currency?: string | null }) {
    const acc = await this.accounts.findOne({ code });
    if (!acc) throw new NotFoundException('Account not found.');
    if (dto.isActive === false && acc.isSystem) throw new BadRequestException('Automatic postings use this account, so it cannot be deactivated. Rename it instead.');
    if (dto.subtype !== undefined) {
      if (!ACCOUNT_SUBTYPES.includes(dto.subtype as AccountSubtype) || dto.subtype === 'current_earnings') throw new BadRequestException('Unknown account subtype.');
      if (acc.isSystem && dto.subtype !== acc.subtype) throw new BadRequestException('The subtype of a system account cannot change.');
      acc.subtype = dto.subtype as AccountSubtype;
    }
    if (dto.name !== undefined) { if (!dto.name.trim()) throw new BadRequestException('Give the account a name.'); acc.name = dto.name.trim(); }
    if (dto.description !== undefined) acc.description = dto.description?.trim() || null;
    if (dto.parentCode !== undefined) acc.parentCode = dto.parentCode || null;
    if (dto.isActive !== undefined) acc.isActive = dto.isActive;
    if (dto.currency !== undefined) acc.currency = dto.currency ? dto.currency.toUpperCase() : null;
    await acc.save();
    this.log(actor, 'account_updated', `Account ${code} updated`, String(acc._id));
    return acc.toObject();
  }

  /** Only an unused, non-system account can be deleted; anything else is deactivated instead. */
  async deleteAccount(actor: AcctActor, code: string) {
    const acc = await this.accounts.findOne({ code }).lean();
    if (!acc) throw new NotFoundException('Account not found.');
    if (acc.isSystem) throw new BadRequestException('System accounts cannot be deleted.');
    if (await this.journals.exists({ 'lines.accountCode': code })) throw new BadRequestException('This account has journal lines. Deactivate it instead.');
    if (await this.assets.exists({ $or: [{ assetAccount: code }, { depreciationExpenseAccount: code }, { accumulatedDepreciationAccount: code }] })) throw new BadRequestException('A fixed asset uses this account.');
    await this.accounts.deleteOne({ code });
    this.log(actor, 'account_deleted', `Account ${code} ${acc.name} deleted`);
    return { deleted: true };
  }

  // ── Periods ─────────────────────────────────────────────────────────────────
  async isClosed(period: string): Promise<boolean> {
    return !!(await this.periods.exists({ period, status: 'closed' }));
  }

  async listPeriods() {
    const now = periodOf(new Date());
    const start = periodOf(parseDay(BOOKS_START)!);
    const stored = await this.periods.find({}).lean();
    const byKey = new Map(stored.map((p) => [p.period, p]));
    const keys = new Set<string>([...periodsBetween(start, now), ...stored.map((p) => p.period)]);
    const counts = await this.journals.aggregate<{ _id: string; n: number }>([{ $match: { status: 'posted' } }, { $group: { _id: '$period', n: { $sum: 1 } } }]);
    const n = new Map(counts.map((c) => [c._id, c.n]));
    return [...keys].sort().reverse().map((k) => ({
      period: k, fiscalYear: fiscalYearOf(parseDay(`${k}-01`)!), status: byKey.get(k)?.status ?? 'open',
      closedBy: byKey.get(k)?.closedBy ?? null, closedAt: byKey.get(k)?.closedAt ?? null, entries: n.get(k) ?? 0, history: byKey.get(k)?.history ?? [],
    }));
  }

  async closePeriod(actor: AcctActor, period: string) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('Period must look like 2026-07.');
    if (period >= periodOf(new Date())) throw new BadRequestException('Only a finished month can be closed.');
    if (await this.journals.exists({ period, status: 'submitted' })) throw new BadRequestException('Approve or reject the entries waiting for approval in this month first.');
    await this.periods.updateOne(
      { period },
      { $set: { status: 'closed', closedBy: actor.id, closedAt: new Date() }, $push: { history: { action: 'closed', by: actor.id, at: new Date() } } },
      { upsert: true },
    );
    this.log(actor, 'period_closed', `Accounting period ${period} closed`);
    return { period, status: 'closed' };
  }

  async reopenPeriod(actor: AcctActor, period: string, note?: string | null) {
    if (!actor.isOwner) throw new ForbiddenException('Only the owner can reopen a closed month.');
    const res = await this.periods.updateOne(
      { period, status: 'closed' },
      { $set: { status: 'open', closedBy: null, closedAt: null }, $push: { history: { action: 'reopened', by: actor.id, at: new Date(), note: note ?? null } } },
    );
    if (!res.modifiedCount) throw new BadRequestException('That month is not closed.');
    this.log(actor, 'period_reopened', `Accounting period ${period} reopened${note ? `: ${note}` : ''}`);
    return { period, status: 'open' };
  }

  // ── Journals ────────────────────────────────────────────────────────────────
  private async nextNumber(fiscalYear: string): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: `JV-${fiscalYear}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
    return `JV-${fiscalYear}-${String(c!.seq).padStart(6, '0')}`;
  }

  private async checkAccounts(lines: { accountCode: string }[], allowInactive = false) {
    const map = await this.accountMap();
    for (const l of lines) {
      const a = map.get(l.accountCode);
      if (!a) throw new BadRequestException(`Unknown account ${l.accountCode}.`);
      if (!allowInactive && !a.isActive) throw new BadRequestException(`Account ${a.code} ${a.name} is inactive.`);
      if (a.subtype === 'current_earnings') throw new BadRequestException('Current year earnings is computed in reports and cannot be posted to.');
    }
  }

  /**
   * Posts a journal immediately (status 'posted'). THE entry point for automatic postings (and Phase B payroll):
   * with a `source`, the same source can only ever be posted once (unique index) — a repeat returns the existing
   * entry with `duplicate: true`. Auto entries dated in a closed month are moved to the first open day after it
   * (and flagged); manual callers get an error instead.
   */
  async postJournal(input: PostJournalInput): Promise<{ entry: any; duplicate: boolean }> {
    let lines;
    try { lines = normaliseLines(input.lines, BASE_CURRENCY); } catch (e: any) { throw new BadRequestException(e.message); }
    await this.checkAccounts(lines, input.kind === 'auto');
    if (input.source) {
      const existing = await this.journals.findOne({ 'source.type': input.source.type, 'source.id': input.source.id }).lean();
      if (existing) return { entry: existing, duplicate: true };
    }
    let date = new Date(input.date);
    const flags = [...(input.flags ?? [])];
    if (await this.isClosed(periodOf(date))) {
      if (input.kind !== 'auto') throw new BadRequestException(`${periodOf(date)} is closed. Reopen it or date the entry in an open month.`);
      const original = date;
      date = await this.firstOpenDayAfter(date);
      flags.push(`Month ${periodOf(original)} was closed: posted on ${date.toISOString().slice(0, 10)} instead of ${original.toISOString().slice(0, 10)}`);
    }
    const fiscalYear = fiscalYearOf(date);
    const total = round2(lines.reduce((s, l) => s + l.debit, 0));
    try {
      const entry = await this.journals.create({
        number: await this.nextNumber(fiscalYear), date, period: periodOf(date), fiscalYear, memo: (input.memo ?? '').slice(0, 500),
        status: 'posted', kind: input.kind ?? 'manual', source: input.source ? { type: input.source.type, id: input.source.id, ref: input.source.ref ?? null } : null,
        lines, total, preparedBy: input.preparedBy ?? 'system', approvedBy: input.approvedBy ?? (input.kind === 'auto' ? 'system' : null),
        approvedAt: new Date(), postedAt: new Date(), flags,
      });
      return { entry: entry.toObject(), duplicate: false };
    } catch (e) {
      if (isDupKey(e) && input.source) {
        const existing = await this.journals.findOne({ 'source.type': input.source.type, 'source.id': input.source.id }).lean();
        if (existing) return { entry: existing, duplicate: true };
      }
      throw e;
    }
  }

  private async firstOpenDayAfter(date: Date): Promise<Date> {
    let p = periodOf(date);
    for (let i = 0; i < 240; i++) {
      const [y, m] = p.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      p = next;
      if (!(await this.isClosed(p))) return parseDay(`${p}-01`)!;
    }
    throw new BadRequestException('No open accounting period found.');
  }

  async listJournals(q: { status?: string; kind?: string; from?: string; to?: string; account?: string; search?: string; sourceType?: string; page?: number; limit?: number }) {
    const filter: Record<string, any> = {};
    if (q.status) filter.status = q.status;
    if (q.kind) filter.kind = q.kind;
    if (q.sourceType) filter['source.type'] = q.sourceType;
    const from = parseDay(q.from);
    const to = parseDay(q.to);
    if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: new Date(to.getTime() + 86_399_999) } : {}) };
    if (q.account) filter['lines.accountCode'] = q.account;
    if (q.search) {
      const s = String(q.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
      filter.$or = [{ number: { $regex: s, $options: 'i' } }, { memo: { $regex: s, $options: 'i' } }, { 'source.ref': { $regex: s, $options: 'i' } }, { 'lines.party.name': { $regex: s, $options: 'i' } }];
    }
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const page = Math.max(1, Number(q.page) || 1);
    const [items, total] = await Promise.all([
      this.journals.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.journals.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  async getJournal(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Journal entry not found.');
    const e = await this.journals.findById(id).lean();
    if (!e) throw new NotFoundException('Journal entry not found.');
    return e;
  }

  /** Manual entry as a draft. Opening-balance drafts auto-balance against Opening balance equity. */
  async createDraft(actor: AcctActor, dto: { date: string; memo?: string; lines: LineInput[]; kind?: 'manual' | 'opening' }) {
    const kind = dto.kind === 'opening' ? 'opening' : 'manual';
    const date = kind === 'opening' ? parseDay(BOOKS_START)! : parseDay(dto.date);
    if (!date) throw new BadRequestException('Choose a valid date.');
    if (date < parseDay(BOOKS_START)!) throw new BadRequestException(`The books start on ${BOOKS_START}. Use opening balances for earlier amounts.`);
    const lines = kind === 'opening' ? this.balanceOpening(dto.lines) : dto.lines;
    let clean;
    try { clean = normaliseLines(lines, BASE_CURRENCY); } catch (e: any) { throw new BadRequestException(e.message); }
    await this.checkAccounts(clean);
    const entry = await this.journals.create({
      number: `DRAFT-${new Types.ObjectId().toHexString()}`, date, period: periodOf(date), fiscalYear: fiscalYearOf(date),
      memo: (dto.memo ?? (kind === 'opening' ? `Opening balances as at ${BOOKS_START}` : '')).slice(0, 500),
      status: 'draft', kind, source: null, lines: clean, total: round2(clean.reduce((s, l) => s + l.debit, 0)), preparedBy: actor.id, flags: [],
    });
    this.log(actor, 'journal_drafted', `${kind === 'opening' ? 'Opening balances' : 'Journal'} draft created`, String(entry._id));
    return entry.toObject();
  }

  /** Opening balances: whatever the entered lines don't balance goes to Opening balance equity (3900). */
  private balanceOpening(lines: LineInput[]): LineInput[] {
    const rest = (lines ?? []).filter((l) => l.accountCode !== POSTING_ACCOUNTS.openingEquity);
    const dr = rest.reduce((s, l) => s + Math.round(round2(Number(l.debit ?? 0)) * 100), 0);
    const cr = rest.reduce((s, l) => s + Math.round(round2(Number(l.credit ?? 0)) * 100), 0);
    const gap = dr - cr;
    if (gap === 0) return rest;
    return [...rest, { accountCode: POSTING_ACCOUNTS.openingEquity, debit: gap < 0 ? -gap / 100 : 0, credit: gap > 0 ? gap / 100 : 0, description: 'Balancing figure' }];
  }

  async updateDraft(actor: AcctActor, id: string, dto: { date?: string; memo?: string; lines?: LineInput[] }) {
    const e = await this.journals.findById(id);
    if (!e) throw new NotFoundException('Journal entry not found.');
    if (e.status !== 'draft') throw new BadRequestException('Only a draft can be edited.');
    if (!actor.isOwner && e.preparedBy !== actor.id) throw new ForbiddenException('Only the person who prepared this draft can edit it.');
    if (dto.date !== undefined && e.kind !== 'opening') {
      const d = parseDay(dto.date);
      if (!d || d < parseDay(BOOKS_START)!) throw new BadRequestException('Choose a valid date on or after the books start.');
      e.date = d; e.period = periodOf(d); e.fiscalYear = fiscalYearOf(d);
    }
    if (dto.memo !== undefined) e.memo = dto.memo.slice(0, 500);
    if (dto.lines) {
      const lines = e.kind === 'opening' ? this.balanceOpening(dto.lines) : dto.lines;
      let clean;
      try { clean = normaliseLines(lines, BASE_CURRENCY); } catch (err: any) { throw new BadRequestException(err.message); }
      await this.checkAccounts(clean);
      e.lines = clean as any;
      e.total = round2(clean.reduce((s, l) => s + l.debit, 0));
    }
    await e.save();
    return e.toObject();
  }

  async submit(actor: AcctActor, id: string) {
    const e = await this.journals.findOneAndUpdate(
      { _id: id, status: 'draft' },
      { $set: { status: 'submitted', submittedBy: actor.id, submittedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (!e) throw new BadRequestException('Only a draft can be submitted.');
    this.log(actor, 'journal_submitted', `Journal ${e.memo || e.number} submitted for approval`, id);
    return e;
  }

  /** Approve = post. The approver must be a different person from the preparer, unless the owner approves. */
  async approve(actor: AcctActor, id: string) {
    if (!this.canApprove(actor)) throw new ForbiddenException('Your role cannot approve journal entries.');
    const e = await this.journals.findById(id).lean();
    if (!e) throw new NotFoundException('Journal entry not found.');
    if (e.status !== 'submitted') throw new BadRequestException('Only a submitted entry can be approved.');
    if (!actor.isOwner && e.preparedBy === actor.id) throw new ForbiddenException('You prepared this entry; someone else must approve it.');
    if (await this.isClosed(e.period)) throw new BadRequestException(`${e.period} is closed. Reopen it first.`);
    if (e.kind === 'opening' && (await this.journals.exists({ 'source.type': 'opening_balance', 'source.id': BOOKS_START }))) {
      throw new BadRequestException('Opening balances are already posted. Post a correcting journal instead.');
    }
    let lines;
    try { lines = normaliseLines(e.lines as LineInput[], BASE_CURRENCY); } catch (err: any) { throw new BadRequestException(err.message); }
    await this.checkAccounts(lines);
    const number = await this.nextNumber(e.fiscalYear);
    try {
      const posted = await this.journals.findOneAndUpdate(
        { _id: id, status: 'submitted' },
        { $set: { status: 'posted', number, approvedBy: actor.id, approvedAt: new Date(), postedAt: new Date(), ...(e.kind === 'opening' ? { source: { type: 'opening_balance', id: BOOKS_START, ref: 'Opening balances' } } : {}) } },
        { returnDocument: 'after' },
      ).lean();
      if (!posted) throw new BadRequestException('This entry changed meanwhile. Refresh and try again.');
      this.log(actor, 'journal_posted', `Journal ${number} approved and posted (${Number(posted.total ?? 0).toFixed(2)} ${BASE_CURRENCY})`, id);
      return posted;
    } catch (err) {
      if (isDupKey(err)) throw new BadRequestException('Opening balances are already posted.');
      throw err;
    }
  }

  /** Reject (back to draft) or void a draft/submitted entry. Posted entries are corrected by reversal. */
  async reject(actor: AcctActor, id: string, reason?: string | null) {
    if (!this.canApprove(actor)) throw new ForbiddenException('Your role cannot reject journal entries.');
    const e = await this.journals.findOneAndUpdate({ _id: id, status: 'submitted' }, { $set: { status: 'draft', voidReason: reason ?? null } }, { returnDocument: 'after' }).lean();
    if (!e) throw new BadRequestException('Only a submitted entry can be sent back.');
    this.log(actor, 'journal_rejected', `Journal sent back to draft${reason ? `: ${reason}` : ''}`, id);
    return e;
  }

  async voidEntry(actor: AcctActor, id: string, reason?: string | null) {
    const e = await this.journals.findById(id).lean();
    if (!e) throw new NotFoundException('Journal entry not found.');
    if (!['draft', 'submitted'].includes(e.status)) throw new BadRequestException('A posted entry cannot be voided; reverse it instead.');
    if (!actor.isOwner && e.preparedBy !== actor.id && !this.canApprove(actor)) throw new ForbiddenException('You cannot void this entry.');
    await this.journals.updateOne({ _id: id }, { $set: { status: 'void', voidReason: reason ?? null } });
    this.log(actor, 'journal_voided', `Journal draft voided${reason ? `: ${reason}` : ''}`, id);
    return { voided: true };
  }

  /** Posts the mirror image of a posted entry (approver only). Each entry can be reversed once. */
  async reverse(actor: AcctActor, id: string, dateStr?: string | null, memo?: string | null) {
    if (!this.canApprove(actor)) throw new ForbiddenException('Your role cannot reverse journal entries.');
    const e = await this.journals.findById(id).lean();
    if (!e) throw new NotFoundException('Journal entry not found.');
    if (e.status !== 'posted') throw new BadRequestException('Only a posted entry can be reversed.');
    if (e.reversedBy) throw new BadRequestException('This entry is already reversed.');
    const date = dateStr ? parseDay(dateStr) : new Date();
    if (!date) throw new BadRequestException('Choose a valid date.');
    const lines = (e.lines as any[]).map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    const { entry, duplicate } = await this.postJournal({
      date, memo: memo || `Reversal of ${e.number}${e.memo ? ` — ${e.memo}` : ''}`, lines, kind: 'manual',
      source: { type: 'reversal', id: String(e._id), ref: e.number }, preparedBy: actor.id, approvedBy: actor.id,
    });
    if (duplicate) throw new BadRequestException('This entry is already reversed.');
    await this.journals.updateOne({ _id: e._id }, { $set: { reversedBy: String(entry._id) } });
    await this.journals.updateOne({ _id: entry._id }, { $set: { reversalOf: String(e._id) } });
    this.log(actor, 'journal_reversed', `Journal ${e.number} reversed by ${entry.number}`, id);
    return { ...entry, reversalOf: String(e._id) };
  }

  // ── Vendors ─────────────────────────────────────────────────────────────────
  listVendors() { return this.vendors.find({}).sort({ name: 1 }).lean(); }

  async upsertVendor(actor: AcctActor, id: string | null, dto: { name?: string; contact?: string | null; email?: string | null; phone?: string | null; taxId?: string | null; isActive?: boolean }) {
    const set: Record<string, unknown> = {};
    for (const k of ['contact', 'email', 'phone', 'taxId'] as const) if (dto[k] !== undefined) set[k] = dto[k]?.toString().trim() || null;
    if (dto.isActive !== undefined) set.isActive = !!dto.isActive;
    if (dto.name !== undefined) { if (!dto.name.trim()) throw new BadRequestException('Give the vendor a name.'); set.name = dto.name.trim(); }
    if (!id) {
      if (!set.name) throw new BadRequestException('Give the vendor a name.');
      const v = await this.vendors.create(set);
      this.log(actor, 'vendor_created', `Vendor ${String(set.name)} added`, String(v._id));
      return v.toObject();
    }
    const v = await this.vendors.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean();
    if (!v) throw new NotFoundException('Vendor not found.');
    return v;
  }

  // ── Fixed assets ────────────────────────────────────────────────────────────
  listAssets() { return this.assets.find({}).sort({ purchaseDate: -1 }).lean(); }

  /** Accumulated depreciation posted so far per asset id. */
  async depreciationTotals(): Promise<Map<string, number>> {
    const rows = await this.journals.aggregate<{ _id: string; total: number }>([
      { $match: { status: 'posted', 'source.type': 'depreciation' } },
      { $project: { asset: { $arrayElemAt: [{ $split: ['$source.id', ':'] }, 0] }, total: 1 } },
      { $group: { _id: '$asset', total: { $sum: '$total' } } },
    ]);
    return new Map(rows.map((r) => [r._id, round2(r.total)]));
  }

  async createAsset(actor: AcctActor, dto: any) {
    const purchaseDate = parseDay(dto.purchaseDate);
    const cost = round2(Number(dto.cost));
    const salvage = round2(Number(dto.salvage ?? 0));
    const life = Math.round(Number(dto.usefulLifeMonths));
    if (!dto.name?.trim()) throw new BadRequestException('Give the asset a name.');
    if (!purchaseDate) throw new BadRequestException('Choose the purchase date.');
    if (!(cost > 0)) throw new BadRequestException('Cost must be more than zero.');
    if (salvage < 0 || salvage >= cost) throw new BadRequestException('Salvage value must be at least 0 and less than the cost.');
    if (!(life >= 1 && life <= 600)) throw new BadRequestException('Useful life must be 1 to 600 months.');
    const category = ASSET_CATEGORIES.includes(dto.category) ? dto.category : 'other';
    const defaults: Record<string, string> = { computers: '1500', furniture: '1510', vehicles: '1520', other: '1500' };
    const assetAccount = dto.assetAccount || defaults[category];
    const doc = {
      name: dto.name.trim(), category, tag: dto.tag?.trim() || null, purchaseDate, cost, salvage, usefulLifeMonths: life, method: 'straight_line' as const,
      assetAccount, depreciationExpenseAccount: dto.depreciationExpenseAccount || POSTING_ACCOUNTS.depreciationExpense,
      accumulatedDepreciationAccount: dto.accumulatedDepreciationAccount || POSTING_ACCOUNTS.accumulatedDepreciation, notes: dto.notes?.trim() || null, createdBy: actor.id,
    };
    await this.checkAccounts([{ accountCode: doc.assetAccount }, { accountCode: doc.depreciationExpenseAccount }, { accountCode: doc.accumulatedDepreciationAccount }]);
    const asset = await this.assets.create(doc);
    // Bought on/after the books start: optionally post the purchase (Dr asset / Cr bank or payable).
    if (dto.postPurchase && dto.purchaseCreditAccount) {
      if (purchaseDate < parseDay(BOOKS_START)!) throw new BadRequestException('Assets bought before the books start belong in the opening balances.');
      await this.postJournal({
        date: purchaseDate, memo: `Purchase of ${doc.name}`, kind: 'manual', preparedBy: actor.id, approvedBy: actor.id,
        source: { type: 'asset_purchase', id: String(asset._id), ref: doc.name },
        lines: [
          { accountCode: doc.assetAccount, debit: cost, description: doc.name },
          { accountCode: String(dto.purchaseCreditAccount), credit: cost, description: doc.name },
        ],
      });
    }
    this.log(actor, 'asset_created', `Fixed asset ${doc.name} added (${cost.toFixed(2)} ${BASE_CURRENCY})`, String(asset._id));
    return asset.toObject();
  }

  async updateAsset(actor: AcctActor, id: string, dto: any) {
    const a = await this.assets.findById(id);
    if (!a) throw new NotFoundException('Asset not found.');
    const depreciated = (await this.depreciationTotals()).get(id) ?? 0;
    if (dto.name !== undefined) a.name = String(dto.name).trim() || a.name;
    if (dto.tag !== undefined) a.tag = dto.tag?.trim() || null;
    if (dto.notes !== undefined) a.notes = dto.notes?.trim() || null;
    const financial = ['cost', 'salvage', 'usefulLifeMonths', 'purchaseDate'].some((k) => dto[k] !== undefined);
    if (financial) {
      if (depreciated > 0) throw new BadRequestException('Depreciation has been posted for this asset, so its cost, life and dates can no longer change.');
      if (dto.cost !== undefined) a.cost = round2(Number(dto.cost));
      if (dto.salvage !== undefined) a.salvage = round2(Number(dto.salvage));
      if (dto.usefulLifeMonths !== undefined) a.usefulLifeMonths = Math.round(Number(dto.usefulLifeMonths));
      if (dto.purchaseDate !== undefined) { const d = parseDay(dto.purchaseDate); if (d) a.purchaseDate = d; }
      if (!(a.cost > 0) || a.salvage < 0 || a.salvage >= a.cost || a.usefulLifeMonths < 1) throw new BadRequestException('Check cost, salvage and useful life.');
    }
    await a.save();
    this.log(actor, 'asset_updated', `Fixed asset ${a.name} updated`, id);
    return a.toObject();
  }

  /**
   * Monthly straight-line depreciation for every active asset, one journal per asset per finished month, from the
   * later of (purchase month + 1) and the books start. Idempotent per asset+month. Assets bought before the books
   * start are expected in the opening balances at their net book value (cost and accumulated depreciation).
   */
  async runDepreciation(upTo = new Date()): Promise<{ posted: number }> {
    const lastMonth = periodOf(new Date(Date.UTC(upTo.getUTCFullYear(), upTo.getUTCMonth(), 0)));
    const booksStart = periodOf(parseDay(BOOKS_START)!);
    let posted = 0;
    for (const a of await this.assets.find({ status: 'active' }).lean()) {
      const firstMonth = periodOf(new Date(Date.UTC(a.purchaseDate.getUTCFullYear(), a.purchaseDate.getUTCMonth() + 1, 1)));
      const from = firstMonth > booksStart ? firstMonth : booksStart;
      if (from > lastMonth) continue;
      for (const period of periodsBetween(from, lastMonth)) {
        const idx = depreciationMonthIndex(a.purchaseDate, period);
        const amount = monthlyDepreciation({ cost: a.cost, salvage: a.salvage, usefulLifeMonths: a.usefulLifeMonths, purchaseDate: a.purchaseDate }, idx);
        if (amount <= 0) continue;
        const { duplicate } = await this.postJournal({
          date: periodEnd(period), memo: `Depreciation ${period} — ${a.name}`, kind: 'auto',
          source: { type: 'depreciation', id: `${String(a._id)}:${period}`, ref: a.name },
          lines: [
            { accountCode: a.depreciationExpenseAccount, debit: amount, description: a.name },
            { accountCode: a.accumulatedDepreciationAccount, credit: amount, description: a.name },
          ],
        });
        if (!duplicate) posted++;
      }
    }
    return { posted };
  }

  /** Disposal: remove cost and accumulated depreciation, book proceeds, gain to Other income / loss to Misc. */
  async disposeAsset(actor: AcctActor, id: string, dto: { date: string; proceeds?: number; proceedsAccount?: string }) {
    if (!this.canApprove(actor)) throw new ForbiddenException('Your role cannot dispose assets.');
    const a = await this.assets.findById(id);
    if (!a) throw new NotFoundException('Asset not found.');
    if (a.status === 'disposed') throw new BadRequestException('This asset is already disposed.');
    const date = parseDay(dto.date);
    if (!date) throw new BadRequestException('Choose the disposal date.');
    await this.runDepreciation(date);
    const accumulated = (await this.depreciationTotals()).get(id) ?? 0;
    const proceeds = round2(Number(dto.proceeds ?? 0));
    const nbv = round2(a.cost - accumulated);
    const gain = round2(proceeds - nbv);
    const lines: LineInput[] = [{ accountCode: a.assetAccount, credit: a.cost, description: `${a.name} (cost)` }];
    if (accumulated > 0) lines.push({ accountCode: a.accumulatedDepreciationAccount, debit: accumulated, description: `${a.name} (accumulated depreciation)` });
    if (proceeds > 0) lines.push({ accountCode: dto.proceedsAccount || POSTING_ACCOUNTS.bank, debit: proceeds, description: 'Sale proceeds' });
    if (gain > 0) lines.push({ accountCode: '4800', credit: gain, description: 'Gain on disposal' });
    if (gain < 0) lines.push({ accountCode: '6900', debit: -gain, description: 'Loss on disposal' });
    await this.postJournal({ date, memo: `Disposal of ${a.name}`, kind: 'manual', preparedBy: actor.id, approvedBy: actor.id, source: { type: 'asset_disposal', id: String(a._id), ref: a.name }, lines });
    a.status = 'disposed'; a.disposedAt = date; a.disposalProceeds = proceeds;
    await a.save();
    this.log(actor, 'asset_disposed', `Fixed asset ${a.name} disposed (proceeds ${proceeds.toFixed(2)})`, id);
    return a.toObject();
  }

  /** Lookup names for party ids (used by the journal editor). */
  partyTypes() { return PARTY_TYPES; }
}
