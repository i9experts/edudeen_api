import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { sendMail } from '../common/mailer.util';
import { AccountingService } from '../accounting/accounting.service';
import { BASE_CURRENCY, BOOKS_START } from '../accounting/accounting.constants';
import { parseDay, round2 } from '../accounting/accounting.util';
import type { ReportTable } from '../accounting/export.util';
import {
  AcctSettings,
  JournalEntry,
} from '../accounting/schemas/accounting.schemas';
import {
  CompensationProfile,
  PayrollRun,
  TaxYearConfig,
} from '../payroll/schemas/payroll.schemas';
import { decryptKycValue } from '../kyc/kyc.util';
import {
  StatutoryPayment,
  type StatutoryPaymentDocument,
} from './schemas/statutory.schemas';
import {
  AUTHORITIES,
  AUTHORITY_ACCOUNT,
  AUTHORITY_LABEL,
  LIABILITY_AGING,
  PAYROLL_AUTHORITIES,
  accruedOnAccount,
  agingOf,
  cleanDueDays,
  contractorWithholdingTable,
  dueDateFor,
  dueState,
  eobiTable,
  isMonth,
  maskId,
  paymentJournalLines,
  paymentTotals,
  reminderDue,
  salaryTaxTable,
  statementsFromRun,
  statusFor,
  taxYearMonths,
  taxYearOf,
  type Authority,
  type DueDays,
  type FilingRow,
  type ProfileIds,
  type StatementLine,
} from './statutory.util';
import { renderSalaryCertificatePdf } from './certificate.pdf';

export interface StatActor {
  id: string;
  isOwner: boolean;
  permissions: Set<string> | null;
  ip?: string;
  userAgent?: string;
}

const RECEIPT_FOLDER = 'private/statutory-receipts';
const str = (v: unknown, max = 200) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const has = (a: StatActor, ...perms: string[]) =>
  a.isOwner || perms.some((p) => a.permissions?.has(p));

/** Preparing or approving implies seeing what you prepare / approve. */
export const canView = (a: StatActor) =>
  has(
    a,
    'payroll.view',
    'accounting.view',
    'payroll.prepare',
    'accounting.prepare',
    'payroll.approve',
    'accounting.approve',
  );
export const canPrepare = (a: StatActor) =>
  has(a, 'payroll.prepare', 'accounting.prepare');
export const canApprove = (a: StatActor) =>
  has(a, 'payroll.approve', 'accounting.approve');
/** Full CNIC / NTN in filing exports: payroll approvers only (as for revealing identity on a pay profile). */
export const canSeeFullIds = (a: StatActor) => has(a, 'payroll.approve');

export const FILING_KINDS = [
  'salary-tax',
  'contractor-withholding',
  'eobi',
] as const;
export type FilingKind = (typeof FILING_KINDS)[number];
const FILING_AUTHORITY: Record<FilingKind, Authority> = {
  'salary-tax': 'fbr_salary',
  'contractor-withholding': 'fbr_withholding',
  eobi: 'eobi',
};

@Injectable()
export class StatutoryService {
  private readonly logger = new Logger(StatutoryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: AccountingService,
    private readonly activity: ActivityLogService,
    private readonly upload: UploadService,
    @InjectModel(StatutoryPayment.name)
    private readonly statements: Model<StatutoryPaymentDocument>,
    @InjectModel(PayrollRun.name) private readonly runs: Model<PayrollRun>,
    @InjectModel(CompensationProfile.name)
    private readonly profiles: Model<CompensationProfile>,
    @InjectModel(TaxYearConfig.name)
    private readonly taxYears: Model<TaxYearConfig>,
    @InjectModel(JournalEntry.name)
    private readonly journals: Model<JournalEntry>,
    @InjectModel(AcctSettings.name)
    private readonly settings: Model<AcctSettings>,
  ) {}

  private needView(a: StatActor) {
    if (!canView(a))
      throw new ForbiddenException(
        'You need payroll or accounting view rights.',
      );
  }
  private needPrepare(a: StatActor) {
    if (!canPrepare(a))
      throw new ForbiddenException(
        'You need payroll or accounting prepare rights.',
      );
  }
  private needApprove(a: StatActor) {
    if (!canApprove(a))
      throw new ForbiddenException(
        'Only a payroll or accounting approver can do this.',
      );
  }

  private log(
    a: StatActor | null,
    action: string,
    description: string,
    targetId?: string | null,
    metadata?: Record<string, unknown>,
    category: 'accounting' | 'payroll' = 'accounting',
  ) {
    void this.activity
      .log({
        category,
        action,
        description,
        actorId: a?.id ?? 'system',
        actorRole: a ? 'admin' : 'system',
        targetId: targetId ?? null,
        targetType: 'statutory_payment',
        ip: a?.ip,
        userAgent: a?.userAgent,
        metadata,
      } as any)
      .catch(() => undefined);
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  async dueDays(): Promise<DueDays> {
    const s: any = await this.settings
      .findOne({ key: 'default' })
      .select('statutoryDueDays')
      .lean();
    return cleanDueDays(s?.statutoryDueDays ?? null);
  }

  async getSettings(actor: StatActor) {
    this.needView(actor);
    const s: any = await this.settings
      .findOne({ key: 'default' })
      .select(
        'statutoryDueDays statutoryRemindersEnabled financePackRecipients',
      )
      .lean();
    return {
      dueDays: cleanDueDays(s?.statutoryDueDays ?? null),
      remindersEnabled: s?.statutoryRemindersEnabled !== false,
      recipients: (s?.financePackRecipients ?? []) as string[],
      note: 'Defaults only (15th of the following month). Check the current FBR and EOBI rules and adjust if needed.',
    };
  }

  /** Changing due days moves the due date of every unpaid statement. */
  async saveSettings(
    actor: StatActor,
    dto: { dueDays?: Record<string, unknown>; remindersEnabled?: boolean },
  ) {
    this.needApprove(actor);
    const set: Record<string, unknown> = { updatedBy: actor.id };
    let days: DueDays | null = null;
    if (dto.dueDays) {
      for (const [k, v] of Object.entries(dto.dueDays)) {
        const n = Number(v);
        if (
          !(AUTHORITIES as readonly string[]).includes(k) ||
          !Number.isInteger(n) ||
          n < 1 ||
          n > 28
        )
          throw new BadRequestException(
            'Due days must be a whole number from 1 to 28 for each authority.',
          );
      }
      days = cleanDueDays(dto.dueDays);
      set.statutoryDueDays = days;
    }
    if (dto.remindersEnabled !== undefined)
      set.statutoryRemindersEnabled = !!dto.remindersEnabled;
    await this.settings.updateOne(
      { key: 'default' },
      { $set: set },
      { upsert: true },
    );
    if (days) {
      const open: any[] = await this.statements
        .find({ status: { $nin: ['paid', 'void'] } })
        .select('month authority')
        .lean();
      for (const s of open)
        await this.statements.updateOne(
          { _id: s._id },
          { $set: { dueDate: dueDateFor(s.month, s.authority, days) } },
        );
    }
    this.log(
      actor,
      'statutory_settings',
      `Tax & EOBI payment settings changed${days ? `: due days ${AUTHORITIES.map((a) => `${a} ${days[a]}`).join(', ')}` : ''}`,
    );
    return this.getSettings(actor);
  }

  // ── Generation from approved payroll runs ──────────────────────────────────
  /** Creates the statements for every approved / paid run that has none yet. Safe to run any number of times. */
  async generateFromRuns(): Promise<{ created: number }> {
    const done = new Set<string>(
      (
        await this.statements.distinct('runId', { runId: { $type: 'string' } })
      ).map(String),
    );
    const runs: any[] = await this.runs
      .find({ status: { $in: ['approved', 'paid'] } })
      .select('month taxYear status lines accrualJournalId')
      .lean();
    const todo = runs.filter((r) => !done.has(String(r._id)));
    if (!todo.length) return { created: 0 };
    const days = await this.dueDays();
    let created = 0;
    for (const run of todo) {
      try {
        created += await this.generateForRun(run, days);
      } catch (err: any) {
        this.logger.warn(
          `Statutory statements for payroll ${run.month} failed: ${err?.message}`,
        );
      }
    }
    if (created)
      this.log(
        null,
        'statutory_generated',
        `${created} tax / EOBI payment statement(s) created from approved payroll`,
      );
    return { created };
  }

  private async generateForRun(run: any, days: DueDays): Promise<number> {
    const ids = (run.lines ?? []).map((l: any) => l.adminId);
    const [profs, tax, journal]: [any[], any, any] = await Promise.all([
      this.profiles
        .find({ adminId: { $in: ids } })
        .select('adminId cnicLast4 ntnLast4 eobiNumber')
        .lean(),
      this.taxYears.findOne({ year: run.taxYear }).select('eobi').lean(),
      run.accrualJournalId && Types.ObjectId.isValid(run.accrualJournalId)
        ? this.journals.findById(run.accrualJournalId).select('lines').lean()
        : null,
    ]);
    const map = new Map<string, ProfileIds>(
      profs.map((p) => [
        p.adminId,
        {
          cnicLast4: p.cnicLast4 ?? null,
          ntnLast4: p.ntnLast4 ?? null,
          eobiNumber: p.eobiNumber ?? null,
        },
      ]),
    );
    let n = 0;
    for (const st of statementsFromRun(
      run,
      map,
      tax?.eobi?.minimumWage ?? null,
    )) {
      const account = AUTHORITY_ACCOUNT[st.authority];
      try {
        await this.statements.create({
          authority: st.authority,
          liabilityAccount: account,
          month: run.month,
          taxYear: run.taxYear ?? taxYearOf(run.month),
          dueDate: dueDateFor(run.month, st.authority, days),
          origin: 'payroll_run',
          runId: String(run._id),
          title: `${AUTHORITY_LABEL[st.authority]} — ${run.month}`,
          lines: st.lines,
          amount: st.amount,
          ledgerAccrued: accruedOnAccount(journal, account),
          accrualJournalId: run.accrualJournalId ?? null,
          status: 'pending',
          createdBy: 'system',
          history: [
            { at: new Date(), by: 'system', action: 'created_from_payroll' },
          ],
        });
        n++;
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // already there: another instance got it first
      }
    }
    return n;
  }

  // ── Read ────────────────────────────────────────────────────────────────────
  private view(s: any, now = new Date()) {
    const t = paymentTotals(s.amount, s.payments ?? []);
    const difference =
      s.ledgerAccrued == null ? null : round2(s.amount - s.ledgerAccrued);
    return {
      ...s,
      authorityLabel: AUTHORITY_LABEL[s.authority as Authority],
      totals: t,
      dueState: dueState(s, now),
      ledgerDifference: difference,
      payments: (s.payments ?? []).map((p: any) => ({
        ...p,
        receipt: p.receipt
          ? { fileName: p.receipt.fileName, mimeType: p.receipt.mimeType }
          : null,
      })),
    };
  }

  async list(actor: StatActor, q: Record<string, string>) {
    this.needView(actor);
    await this.generateFromRuns().catch((err) =>
      this.logger.warn(`generate on list failed: ${err?.message}`),
    );
    const filter: Record<string, unknown> = {};
    if (q.authority && (AUTHORITIES as readonly string[]).includes(q.authority))
      filter.authority = q.authority;
    if (q.status)
      filter.status =
        q.status === 'open' ? { $nin: ['paid', 'void'] } : q.status;
    if (isMonth(q.month)) filter.month = q.month;
    if (q.taxYear && /^\d{4}-\d{2}$/.test(q.taxYear))
      filter.taxYear = q.taxYear;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const page = Math.max(1, Number(q.page) || 1);
    const [rows, total, open] = await Promise.all([
      this.statements
        .find(filter)
        .select('-lines -history')
        .sort({ dueDate: -1, authority: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.statements.countDocuments(filter),
      this.statements
        .find({ status: { $nin: ['paid', 'void'] } })
        .select('authority month amount payments dueDate status')
        .lean(),
    ]);
    const now = new Date();
    const upcoming = (open as any[])
      .map((s) => this.view(s, now))
      .filter((s) => s.dueState === 'due_soon' || s.dueState === 'overdue')
      .sort(
        (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
      );
    return {
      items: rows.map((r) => this.view(r, now)),
      total,
      page,
      limit,
      upcoming,
    };
  }

  async get(actor: StatActor, id: string) {
    this.needView(actor);
    const s: any = await this.statements.findById(id).lean();
    if (!s) throw new NotFoundException('Statement not found.');
    const names = await this.adminNames([
      s.createdBy,
      ...(s.payments ?? []).flatMap((p: any) => [p.preparedBy, p.approvedBy]),
    ]);
    const v = this.view(s);
    return {
      ...v,
      payments: v.payments.map((p: any) => ({
        ...p,
        preparedByName: names.get(p.preparedBy) ?? null,
        approvedByName: p.approvedBy ? (names.get(p.approvedBy) ?? null) : null,
      })),
      canSeeFullIds: canSeeFullIds(actor),
    };
  }

  private async adminNames(
    ids: (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const clean = [
      ...new Set(
        ids.filter((x): x is string => !!x && Types.ObjectId.isValid(x)),
      ),
    ];
    if (!clean.length) return new Map();
    const rows: any[] = await this.db.repositories.adminModel
      .find({ _id: { $in: clean } })
      .select('name email')
      .lean();
    return new Map(rows.map((r) => [String(r._id), r.name ?? r.email ?? '']));
  }

  // ── Manual statements ───────────────────────────────────────────────────────
  async createManual(actor: StatActor, dto: any) {
    this.needPrepare(actor);
    const authority = String(dto?.authority ?? 'fbr_other') as Authority;
    if (!(AUTHORITIES as readonly string[]).includes(authority))
      throw new BadRequestException('Choose an authority.');
    const month = String(dto?.month ?? '');
    if (!isMonth(month))
      throw new BadRequestException(
        'Choose the month the tax was deducted in.',
      );
    if (month < BOOKS_START.slice(0, 7))
      throw new BadRequestException(
        `The books start on ${BOOKS_START}; earlier amounts belong in the opening balances.`,
      );
    const account =
      str(dto?.liabilityAccount, 10) || AUTHORITY_ACCOUNT[authority];
    const acc = (await this.ledger.accountMap()).get(account);
    if (!acc || !acc.isActive || acc.type !== 'liability')
      throw new BadRequestException(
        'Choose an active liability account (e.g. Withholding tax payable).',
      );
    const raw: any[] = Array.isArray(dto?.lines)
      ? dto.lines.slice(0, 1000)
      : [];
    const lines: StatementLine[] = raw.map((l) => {
      const amount = round2(Number(l?.amount));
      if (!Number.isFinite(amount) || amount <= 0)
        throw new BadRequestException('Every line needs an amount above 0.');
      const digits = (v: unknown) => str(v, 40).replace(/[\s-]/g, '');
      return {
        adminId: null,
        name: str(l?.name, 120) || 'Unnamed',
        workerType: null,
        cnicLast4: digits(l?.cnic).slice(-4) || null,
        ntnLast4: digits(l?.ntn).slice(-4) || null,
        eobiNumber: null,
        taxableIncome:
          l?.taxableIncome != null && l.taxableIncome !== ''
            ? round2(Number(l.taxableIncome) || 0)
            : null,
        wageBase: null,
        employeeShare: amount,
        employerShare: 0,
        amount,
        description: str(l?.description, 200) || null,
      };
    });
    if (!lines.length) throw new BadRequestException('Add at least one line.');
    const amount = round2(lines.reduce((s, l) => s + l.amount, 0));
    const doc = await this.statements.create({
      authority,
      liabilityAccount: account,
      month,
      taxYear: taxYearOf(month),
      dueDate: dueDateFor(month, authority, await this.dueDays()),
      origin: 'manual',
      runId: null,
      title: str(dto?.title, 120) || `${AUTHORITY_LABEL[authority]} — ${month}`,
      lines,
      amount,
      ledgerAccrued: null,
      status: 'pending',
      createdBy: actor.id,
      notes: str(dto?.notes, 500) || null,
      history: [{ at: new Date(), by: actor.id, action: 'created' }],
    });
    this.log(
      actor,
      'statutory_created',
      `${AUTHORITY_LABEL[authority]} ${month} statement created (${amount} PKR)`,
      String(doc._id),
    );
    return this.get(actor, String(doc._id));
  }

  /** Void a statement nothing has been paid on (manual ones; payroll ones only by an approver). */
  async voidStatement(actor: StatActor, id: string, reason?: string | null) {
    const s: any = await this.statements.findById(id).lean();
    if (!s) throw new NotFoundException('Statement not found.');
    if (s.origin === 'payroll_run') this.needApprove(actor);
    else this.needPrepare(actor);
    if ((s.payments ?? []).some((p: any) => p.status !== 'rejected'))
      throw new ConflictException(
        'Payments are recorded on this statement. Reject or remove them first.',
      );
    await this.statements.updateOne(
      { _id: id },
      {
        $set: { status: 'void' },
        $push: {
          history: {
            at: new Date(),
            by: actor.id,
            action: 'voided',
            note: str(reason, 300) || null,
          },
        },
      },
    );
    this.log(
      actor,
      'statutory_voided',
      `${AUTHORITY_LABEL[s.authority as Authority]} ${s.month} statement voided${reason ? `: ${reason}` : ''}`,
      id,
    );
    return this.get(actor, id);
  }

  // ── Payments ────────────────────────────────────────────────────────────────
  async recordPayment(actor: StatActor, id: string, dto: any) {
    this.needPrepare(actor);
    const s = await this.statements.findById(id);
    if (!s) throw new NotFoundException('Statement not found.');
    if (s.status === 'void' || s.status === 'paid')
      throw new ConflictException('This statement is already settled.');
    const amount = round2(Number(dto?.amount));
    const penalty = round2(Math.max(0, Number(dto?.penalty) || 0));
    if (!Number.isFinite(amount) || amount <= 0)
      throw new BadRequestException('Enter the amount paid.');
    const t = paymentTotals(s.amount, s.payments as any);
    if (amount > t.unclaimed + 0.004)
      throw new BadRequestException(
        `Only ${t.unclaimed} PKR is left to pay on this statement (payments waiting for approval included).`,
      );
    const paymentDate = parseDay(dto?.paymentDate);
    if (!paymentDate) throw new BadRequestException('Enter the payment date.');
    if (paymentDate < parseDay(BOOKS_START)!)
      throw new BadRequestException(`The books start on ${BOOKS_START}.`);
    if (paymentDate.getTime() > Date.now() + 86_400_000)
      throw new BadRequestException('The payment date is in the future.');
    const cprNumber = str(dto?.cprNumber, 60);
    if (!cprNumber)
      throw new BadRequestException(
        'Enter the CPR / challan number from the bank receipt.',
      );
    const bank = str(dto?.bankAccount, 10);
    const acc = (await this.ledger.accountMap()).get(bank);
    if (!acc || !acc.isActive || !['bank', 'cash'].includes(acc.subtype))
      throw new BadRequestException(
        'Choose the bank or cash account it was paid from.',
      );
    s.payments.push({
      psid: str(dto?.psid, 40) || null,
      cprNumber,
      paymentDate,
      bankAccount: bank,
      amount,
      penalty,
      receipt: null,
      note: str(dto?.note, 300) || null,
      status: 'submitted',
      preparedBy: actor.id,
      submittedAt: new Date(),
      approvedBy: null,
      approvedAt: null,
      rejectReason: null,
      journalId: null,
    } as any);
    s.status = statusFor(s.amount, s.payments as any, s.status);
    s.history.push({
      at: new Date(),
      by: actor.id,
      action: 'payment_submitted',
      note: `${amount} PKR, CPR ${cprNumber}`,
    });
    await s.save();
    this.log(
      actor,
      'statutory_payment_submitted',
      `${AUTHORITY_LABEL[s.authority]} ${s.month}: payment of ${amount} PKR (CPR ${cprNumber}) submitted for approval`,
      id,
    );
    return this.get(actor, id);
  }

  private payment(s: StatutoryPaymentDocument, paymentId: string) {
    const p = (s.payments as any[]).find((x) => String(x._id) === paymentId);
    if (!p) throw new NotFoundException('Payment not found.');
    return p;
  }

  async uploadReceipt(
    actor: StatActor,
    id: string,
    paymentId: string,
    file: Express.Multer.File,
  ) {
    this.needPrepare(actor);
    if (!file) throw new BadRequestException('Choose a file.');
    const okType =
      /^image\/(jpeg|png|webp|heic|heif)$/i.test(file.mimetype) ||
      file.mimetype === 'application/pdf';
    if (!okType)
      throw new BadRequestException(
        'Upload a photo (JPG, PNG, WebP) or a PDF of the CPR / challan.',
      );
    const s = await this.statements.findById(id);
    if (!s) throw new NotFoundException('Statement not found.');
    const p = this.payment(s, paymentId);
    if (p.status !== 'submitted')
      throw new ConflictException(
        'The receipt can be changed while the payment waits for approval.',
      );
    const up = await this.upload.uploadPrivateFile(file, RECEIPT_FOLDER);
    p.receipt = {
      publicId: up.publicId,
      resourceType: up.resourceType,
      fileName: up.fileName,
      mimeType: up.mimeType,
    };
    s.markModified('payments');
    await s.save();
    return this.get(actor, id);
  }

  async receiptUrl(actor: StatActor, id: string, paymentId: string) {
    this.needView(actor);
    const s = await this.statements.findById(id);
    if (!s) throw new NotFoundException('Statement not found.');
    const p = this.payment(s, paymentId);
    if (!p.receipt)
      throw new NotFoundException('No receipt uploaded for this payment.');
    return {
      url: this.upload.generateSignedUrl(
        p.receipt.publicId,
        p.receipt.resourceType,
        600,
        p.receipt.fileName,
        true,
      ),
      fileName: p.receipt.fileName,
    };
  }

  /** Preparer withdraws a payment still waiting for approval. */
  async removePayment(actor: StatActor, id: string, paymentId: string) {
    this.needPrepare(actor);
    const s = await this.statements.findById(id);
    if (!s) throw new NotFoundException('Statement not found.');
    const p = this.payment(s, paymentId);
    if (p.status !== 'submitted')
      throw new ConflictException(
        'Only a payment waiting for approval can be removed.',
      );
    s.payments = (s.payments as any[]).filter(
      (x) => String(x._id) !== paymentId,
    ) as any;
    s.status = statusFor(s.amount, s.payments as any, s.status);
    s.history.push({
      at: new Date(),
      by: actor.id,
      action: 'payment_removed',
      note: `CPR ${p.cprNumber}`,
    });
    await s.save();
    return this.get(actor, id);
  }

  async rejectPayment(
    actor: StatActor,
    id: string,
    paymentId: string,
    reason?: string | null,
  ) {
    this.needApprove(actor);
    const s = await this.statements.findById(id);
    if (!s) throw new NotFoundException('Statement not found.');
    const p = this.payment(s, paymentId);
    if (p.status !== 'submitted')
      throw new ConflictException(
        'Only a payment waiting for approval can be rejected.',
      );
    p.status = 'rejected';
    p.rejectReason = str(reason, 300) || null;
    s.status = statusFor(s.amount, s.payments as any, s.status);
    s.history.push({
      at: new Date(),
      by: actor.id,
      action: 'payment_rejected',
      note: p.rejectReason,
    });
    s.markModified('payments');
    await s.save();
    this.log(
      actor,
      'statutory_payment_rejected',
      `${AUTHORITY_LABEL[s.authority]} ${s.month}: payment CPR ${p.cprNumber} sent back${reason ? `: ${reason}` : ''}`,
      id,
    );
    return this.get(actor, id);
  }

  /** Approve: posts Dr liability (+ Dr penalties) / Cr bank, once per payment (source statutory_payment:<id>:<paymentId>). */
  async approvePayment(actor: StatActor, id: string, paymentId: string) {
    this.needApprove(actor);
    const s = await this.statements.findById(id);
    if (!s) throw new NotFoundException('Statement not found.');
    const p = this.payment(s, paymentId);
    if (p.status !== 'submitted')
      throw new ConflictException(
        'Only a payment waiting for approval can be approved.',
      );
    if (!actor.isOwner && p.preparedBy === actor.id)
      throw new ForbiddenException(
        'Someone other than the person who recorded the payment must approve it.',
      );
    const period = new Date(p.paymentDate).toISOString().slice(0, 7);
    if (await this.ledger.isClosed(period))
      throw new BadRequestException(
        `${period} is closed. Reopen it or correct the payment date.`,
      );
    const label = `${AUTHORITY_LABEL[s.authority]} ${s.month} — CPR ${p.cprNumber}`;
    const { entry } = await this.ledger.postJournal({
      date: new Date(p.paymentDate),
      memo: label,
      kind: 'auto',
      preparedBy: p.preparedBy,
      approvedBy: actor.id,
      source: {
        type: 'statutory_payment',
        id: `${id}:${paymentId}`,
        ref: p.psid || p.cprNumber,
      },
      lines: paymentJournalLines({
        liabilityAccount: s.liabilityAccount,
        bankAccount: p.bankAccount,
        amount: p.amount,
        penalty: p.penalty ?? 0,
        label,
      }).map((l) => ({ ...l, currency: BASE_CURRENCY })),
    });
    p.status = 'approved';
    p.approvedBy = actor.id;
    p.approvedAt = new Date();
    p.journalId = String(entry._id);
    s.status = statusFor(s.amount, s.payments as any, s.status);
    s.history.push({
      at: new Date(),
      by: actor.id,
      action: 'payment_approved',
      note: `${p.amount} PKR, journal ${entry.number ?? entry._id}`,
    });
    s.markModified('payments');
    await s.save();
    this.log(
      actor,
      'statutory_payment_approved',
      `${label}: ${p.amount} PKR approved and posted`,
      id,
      { journalId: String(entry._id) },
    );
    return this.get(actor, id);
  }

  // ── Liability overview ──────────────────────────────────────────────────────
  async overview(actor: StatActor, now = new Date()) {
    this.needView(actor);
    const rows: any[] = await this.statements
      .find({ status: { $ne: 'void' } })
      .select('authority month liabilityAccount amount payments dueDate status')
      .sort({ month: -1 })
      .lean();
    const byAuthority = AUTHORITIES.map((authority) => {
      const mine = rows.filter((r) => r.authority === authority);
      const months = mine.map((r) => {
        const t = paymentTotals(r.amount, r.payments ?? []);
        return {
          id: String(r._id),
          month: r.month,
          accrued: t.amount,
          paid: t.paid,
          outstanding: t.remaining,
          dueDate: r.dueDate,
          status: r.status,
          aging: t.remaining > 0 ? agingOf(r.dueDate, now) : null,
        };
      });
      const aging = Object.fromEntries(
        LIABILITY_AGING.map((b) => [
          b,
          round2(
            months
              .filter((m) => m.aging === b)
              .reduce((s, m) => s + m.outstanding, 0),
          ),
        ]),
      );
      return {
        authority,
        label: AUTHORITY_LABEL[authority],
        account: AUTHORITY_ACCOUNT[authority],
        accrued: round2(months.reduce((s, m) => s + m.accrued, 0)),
        paid: round2(months.reduce((s, m) => s + m.paid, 0)),
        outstanding: round2(months.reduce((s, m) => s + m.outstanding, 0)),
        aging,
        months,
      };
    }).filter(
      (a) =>
        a.months.length || PAYROLL_AUTHORITIES.includes(a.authority as any),
    );

    // Ledger check: each liability account's balance vs what the statements on it still say is owed.
    const accounts = [
      ...new Set(
        rows
          .map((r) => r.liabilityAccount)
          .concat(Object.values(AUTHORITY_ACCOUNT)),
      ),
    ];
    const balances = await this.journals.aggregate<{
      _id: string;
      bal: number;
    }>([
      { $match: { status: 'posted', 'lines.accountCode': { $in: accounts } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $in: accounts } } },
      {
        $group: {
          _id: '$lines.accountCode',
          bal: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } },
        },
      },
    ]);
    const bal = new Map(balances.map((b) => [b._id, round2(b.bal)]));
    const names = await this.ledger.accountMap();
    const reconciliation = accounts.sort().map((code) => {
      const outstanding = round2(
        rows
          .filter((r) => r.liabilityAccount === code)
          .reduce(
            (s, r) => s + paymentTotals(r.amount, r.payments ?? []).remaining,
            0,
          ),
      );
      const ledgerBalance = bal.get(code) ?? 0;
      const difference = round2(ledgerBalance - outstanding);
      return {
        account: code,
        name: names.get(code)?.name ?? code,
        ledgerBalance,
        statementsOutstanding: outstanding,
        difference,
        matches: Math.abs(difference) < 0.01,
      };
    });
    return { byAuthority, reconciliation };
  }

  // ── Dashboard / reminders ───────────────────────────────────────────────────
  /** Counts for the finance dashboard: due within 5 days and overdue, with amounts still unpaid. */
  async dueSummary(now = new Date()) {
    const open: any[] = await this.statements
      .find({ status: { $nin: ['paid', 'void'] } })
      .select('authority month amount payments dueDate status')
      .lean();
    const out = {
      dueSoon: { count: 0, amount: 0 },
      overdue: { count: 0, amount: 0 },
    };
    for (const s of open) {
      const st = dueState(s, now);
      const left = paymentTotals(s.amount, s.payments ?? []).remaining;
      if (st === 'due_soon') {
        out.dueSoon.count++;
        out.dueSoon.amount = round2(out.dueSoon.amount + left);
      }
      if (st === 'overdue') {
        out.overdue.count++;
        out.overdue.amount = round2(out.overdue.amount + left);
      }
    }
    return out;
  }

  /**
   * Daily: e-mail the finance recipients about statements newly due within 5 days or newly overdue. Each statement
   * is claimed atomically per reminder kind before sending, so it is mailed once even with several instances.
   */
  async sendReminders(
    now = new Date(),
  ): Promise<{ sent: number; statements: number }> {
    const s: any = await this.settings
      .findOne({ key: 'default' })
      .select('statutoryRemindersEnabled financePackRecipients')
      .lean();
    const to: string[] = s?.financePackRecipients ?? [];
    if (s?.statutoryRemindersEnabled === false || !to.length)
      return { sent: 0, statements: 0 };
    const open: any[] = await this.statements
      .find({ status: { $nin: ['paid', 'void'] } })
      .select('authority month amount payments dueDate status reminders')
      .lean();
    const claimed: { kind: 'due_soon' | 'overdue'; s: any }[] = [];
    for (const st of open) {
      const kind = reminderDue(st, now);
      if (!kind) continue;
      const field =
        kind === 'overdue'
          ? 'reminders.overdueSentAt'
          : 'reminders.dueSoonSentAt';
      const res = await this.statements.updateOne(
        { _id: st._id, [field]: null },
        { $set: { [field]: now } },
      );
      if (res.modifiedCount) claimed.push({ kind, s: st });
    }
    if (!claimed.length) return { sent: 0, statements: 0 };
    const base = (process.env.WEB_APP_URL || 'https://edudeen.com').replace(
      /\/+$/,
      '',
    );
    const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const item = (c: { kind: string; s: any }) =>
      `${c.kind === 'overdue' ? 'OVERDUE' : 'Due soon'}: ${AUTHORITY_LABEL[c.s.authority as Authority]} for ${c.s.month}, ${paymentTotals(c.s.amount, c.s.payments ?? []).remaining.toLocaleString('en-US')} PKR, due ${day(c.s.dueDate)}`;
    const items = claimed.map(item);
    const overdue = claimed.some((c) => c.kind === 'overdue');
    let sent = 0;
    for (const addr of to) {
      try {
        await sendMail({
          to: addr,
          subject: overdue
            ? 'Edudeen: tax / EOBI payment overdue'
            : 'Edudeen: tax / EOBI payment due soon',
          text: `${items.join('\n')}\n\nRecord the payment (PSID, CPR) in Edudeen: ${base}/admin/statutory-payments\nDue dates are settings: check them against current FBR and EOBI rules.`,
          html: `<p>${items.map((i) => i.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>')}</p><p><a href="${base}/admin/statutory-payments">Open Tax &amp; EOBI payments</a> to record the PSID and CPR once paid.</p><p style="color:#5B6973;font-size:12px">Due dates come from Edudeen's accounting settings; check them against current FBR and EOBI rules.</p>`,
        });
        sent++;
      } catch (err: any) {
        this.logger.warn(`Statutory reminder failed: ${err?.message}`);
      }
    }
    return { sent, statements: claimed.length };
  }

  // ── Filing working files ────────────────────────────────────────────────────
  /** period: 'YYYY-MM' (one month) or 'YYYY-YY' (a July–June tax year). Full CNIC / NTN only with payroll.approve. */
  async filingTable(
    actor: StatActor,
    kind: string,
    period: string,
    full: boolean,
  ): Promise<ReportTable> {
    this.needView(actor);
    if (!(FILING_KINDS as readonly string[]).includes(kind))
      throw new BadRequestException(
        `Export must be one of: ${FILING_KINDS.join(', ')}`,
      );
    const months = isMonth(period)
      ? [period]
      : /^\d{4}-\d{2}$/.test(period)
        ? taxYearMonths(period)
        : null;
    if (!months)
      throw new BadRequestException(
        'Choose a month (YYYY-MM) or a tax year (e.g. 2026-27).',
      );
    if (full && !canSeeFullIds(actor))
      throw new ForbiddenException(
        'Full CNIC / NTN exports need payroll approval rights.',
      );
    const authority = FILING_AUTHORITY[kind as FilingKind];
    const rows: any[] = await this.statements
      .find({ authority, month: { $in: months }, status: { $ne: 'void' } })
      .sort({ month: 1 })
      .lean();
    const adminIds = [
      ...new Set(
        rows.flatMap((r) =>
          (r.lines ?? []).map((l: any) => l.adminId).filter(Boolean),
        ),
      ),
    ];
    let ids = new Map<string, { cnic: string; ntn: string }>();
    if (full && adminIds.length) {
      const profs: any[] = await this.profiles
        .find({ adminId: { $in: adminIds } })
        .select('+cnicEnc +ntnEnc adminId')
        .lean();
      ids = new Map(
        profs.map((p) => [
          p.adminId,
          {
            cnic: decryptKycValue(p.cnicEnc) ?? '',
            ntn: decryptKycValue(p.ntnEnc) ?? '',
          },
        ]),
      );
    }
    const out: FilingRow[] = [];
    for (const r of rows) {
      const paid = (r.payments ?? []).filter(
        (p: any) => p.status === 'approved',
      );
      const join = (f: (p: any) => string) =>
        paid.map(f).filter(Boolean).join(' / ');
      for (const l of r.lines ?? []) {
        const full_ = l.adminId ? ids.get(l.adminId) : undefined;
        out.push({
          month: r.month,
          name: l.name,
          cnic: full_?.cnic || maskId(l.cnicLast4),
          ntn: full_?.ntn || maskId(l.ntnLast4),
          eobiNumber: l.eobiNumber ?? '',
          taxableIncome: l.taxableIncome ?? null,
          wageBase: l.wageBase ?? null,
          employeeShare: l.employeeShare ?? 0,
          employerShare: l.employerShare ?? 0,
          amount: l.amount ?? 0,
          psid: join((p) => p.psid ?? ''),
          cpr: join((p) => p.cprNumber ?? ''),
          paymentDate: join((p) =>
            new Date(p.paymentDate).toISOString().slice(0, 10),
          ),
        });
      }
    }
    const label =
      months.length === 1
        ? months[0]
        : `Tax year ${period} (${months[0]} to ${months[months.length - 1]})`;
    if (full)
      this.log(
        actor,
        'statutory_export_full_ids',
        `Filing export with full CNIC/NTN: ${kind} ${period}`,
        null,
        { kind, period },
        'payroll',
      );
    if (kind === 'salary-tax') return salaryTaxTable(out, label);
    if (kind === 'contractor-withholding')
      return contractorWithholdingTable(out, label);
    return eobiTable(out, label);
  }

  // ── Annual salary certificate ───────────────────────────────────────────────
  async salaryCertificate(
    actor: StatActor,
    adminId: string,
    taxYear: string,
  ): Promise<{ body: Buffer; fileName: string }> {
    if (!/^\d{4}-\d{2}$/.test(taxYear))
      throw new BadRequestException('Choose a tax year, e.g. 2026-27.');
    const self = actor.id === adminId;
    if (!self && !has(actor, 'payroll.view'))
      throw new ForbiddenException(
        'You can only download your own salary certificate.',
      );
    const months = taxYearMonths(taxYear);
    const runs: any[] = await this.runs
      .find({
        month: { $in: months },
        status: { $in: ['approved', 'paid'] },
        'lines.adminId': adminId,
      })
      .select('month lines')
      .sort({ month: 1 })
      .lean();
    const rows = runs
      .map((r) => {
        const l = (r.lines ?? []).find(
          (x: any) => x.adminId === adminId && !x.excluded,
        );
        if (!l) return null;
        const tax = round2(
          (l.deductions ?? [])
            .filter((d: any) => d.kind === 'income_tax')
            .reduce((s: number, d: any) => s + d.amount, 0),
        );
        return {
          month: r.month,
          name: l.name ?? l.email ?? adminId,
          gross: round2(l.gross ?? 0),
          taxable: round2(l.taxableIncome ?? 0),
          tax,
        };
      })
      .filter(
        (
          x,
        ): x is {
          month: string;
          name: string;
          gross: number;
          taxable: number;
          tax: number;
        } => !!x,
      );
    if (!rows.length)
      throw new NotFoundException(
        'No approved payroll for this person in that tax year.',
      );
    const st: any[] = await this.statements
      .find({
        authority: 'fbr_salary',
        month: { $in: rows.map((r) => r.month) },
        status: { $ne: 'void' },
      })
      .select('month payments')
      .lean();
    const cprBy = new Map(
      st.map((s) => [
        s.month,
        (s.payments ?? [])
          .filter((p: any) => p.status === 'approved')
          .map(
            (p: any) =>
              `${p.cprNumber} (${new Date(p.paymentDate).toISOString().slice(0, 10)})`,
          )
          .join(', '),
      ]),
    );
    const p: any = await this.profiles
      .findOne({ adminId })
      .select('cnicLast4 ntnLast4 designation')
      .lean();
    const body = await renderSalaryCertificatePdf({
      taxYear,
      name: rows[0].name,
      designation: p?.designation ?? null,
      cnic: maskId(p?.cnicLast4),
      ntn: maskId(p?.ntnLast4),
      months: rows.map((r) => ({ ...r, cpr: cprBy.get(r.month) || '' })),
    });
    if (!self)
      this.log(
        actor,
        'salary_certificate',
        `Salary certificate ${taxYear} downloaded for ${rows[0].name}`,
        adminId,
        { taxYear },
        'payroll',
      );
    return {
      body,
      fileName: `salary-certificate-${taxYear}-${String(rows[0].name)
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()}.pdf`,
    };
  }
}
