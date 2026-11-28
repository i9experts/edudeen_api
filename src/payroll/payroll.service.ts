/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UploadService } from '../upload/upload.service';
import { AccountingService } from '../accounting/accounting.service';
import { BOOKS_START } from '../accounting/accounting.constants';
import { parseDay, round2 } from '../accounting/accounting.util';
import type { ReportTable } from '../accounting/export.util';
import { decryptKycValue, encryptKycValue } from '../kyc/kyc.util';
import {
  BONUS_METRICS, CLAIM_TYPES, INCENTIVE_METRICS, PAYROLL_ACCOUNTS, RECEIPT_FOLDER, RULE_UNITS, WORKER_TYPES,
  type ClaimType, type IncentiveMetric, type RuleUnit,
} from './payroll.constants';
import {
  accrualLines, addMonths, buildPayslip, emptyCounts, isMonth, maskValue, monthBounds, monthOf, taxYearOf, versionFor,
  type ManualLine, type PayVersion, type Payslip, type TaxRules,
} from './payroll.util';
import { PayrollMetricsService } from './payroll-metrics.service';
import { renderPayslipPdf } from './payslip.pdf';
import {
  CompensationProfile, CompensationProfileDocument, PayrollClaim, PayrollClaimDocument, PayrollRun, PayrollRunDocument,
  StaffAdvance, StaffAdvanceDocument, TaxYearConfig, TaxYearConfigDocument,
} from './schemas/payroll.schemas';

export interface PayActor { id: string; isOwner: boolean; permissions: Set<string> | null; ip?: string; userAgent?: string }

const OID = /^[a-f0-9]{24}$/i;
const num = (v: unknown, label: string, { min = 0, max = 100_000_000 }: { min?: number; max?: number } = {}): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`${label} must be a number between ${min} and ${max}.`);
  return round2(n);
};
const optNum = (v: unknown, label: string, opts?: { min?: number; max?: number }) => (v === null || v === undefined || v === '' ? null : num(v, label, opts));
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateOrNull = (v: unknown, label: string): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = parseDay(v);
  if (!d) throw new BadRequestException(`${label} is not a valid date.`);
  return d;
};
const BOOKS_MONTH = BOOKS_START.slice(0, 7);

/**
 * Tax years seeded on first start. 2025-26 = Finance Act 2025 salaried slabs as given by the owner; 2026-27 is a COPY
 * that stays "needs verification" (approving a run in that year is blocked) until finance confirms it against the
 * Finance Act 2026. Edudeen never claims these are current law.
 */
const SLABS_2025_26 = [
  { from: 0, to: 600_000, fixed: 0, rate: 0 },
  { from: 600_000, to: 1_200_000, fixed: 0, rate: 1 },
  { from: 1_200_000, to: 2_200_000, fixed: 6_000, rate: 11 },
  { from: 2_200_000, to: 3_200_000, fixed: 116_000, rate: 23 },
  { from: 3_200_000, to: 4_100_000, fixed: 346_000, rate: 30 },
  { from: 4_100_000, to: null, fixed: 616_000, rate: 35 },
];
const SEED_TAX_YEARS = [
  { year: '2025-26', slabs: SLABS_2025_26, surcharge: { threshold: 10_000_000, pct: 9 }, eobi: { minimumWage: 37_000, employeePct: 1, employerPct: 5 }, needsVerification: false, source: 'Finance Act 2025 salaried slabs (entered by Edudeen). Check before use.' },
  { year: '2026-27', slabs: SLABS_2025_26, surcharge: { threshold: 10_000_000, pct: 9 }, eobi: { minimumWage: 37_000, employeePct: 1, employerPct: 5 }, needsVerification: true, source: 'Copy of 2025-26. Verify against Finance Act 2026 before running payroll.' },
];

@Injectable()
export class PayrollService implements OnModuleInit {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly upload: UploadService,
    private readonly ledger: AccountingService,
    private readonly metrics: PayrollMetricsService,
    @InjectModel(CompensationProfile.name) private readonly profiles: Model<CompensationProfileDocument>,
    @InjectModel(TaxYearConfig.name) private readonly taxYears: Model<TaxYearConfigDocument>,
    @InjectModel(PayrollClaim.name) private readonly claims: Model<PayrollClaimDocument>,
    @InjectModel(StaffAdvance.name) private readonly advances: Model<StaffAdvanceDocument>,
    @InjectModel(PayrollRun.name) private readonly runs: Model<PayrollRunDocument>,
  ) {}

  async onModuleInit() {
    try {
      await this.taxYears.bulkWrite(SEED_TAX_YEARS.map((t) => ({ updateOne: { filter: { year: t.year }, update: { $setOnInsert: t }, upsert: true } })), { ordered: false });
    } catch (e: any) {
      this.logger.error(`Tax year seed failed: ${e?.message}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private can(actor: PayActor, perm: string) { return actor.isOwner || !!actor.permissions?.has(perm); }
  private need(actor: PayActor, perm: string) { if (!this.can(actor, perm)) throw new ForbiddenException('Your role does not allow this.'); }

  private log(actor: PayActor | { id: string }, action: string, description: string, targetId?: string | null, metadata?: Record<string, unknown>) {
    const a = actor as PayActor;
    void this.activity.log({
      category: 'payroll', action, description, actorId: actor.id, actorRole: 'admin', targetId: targetId ?? null, targetType: 'payroll',
      ip: a.ip, userAgent: a.userAgent, metadata,
    }).catch(() => undefined);
  }

  private async adminNames(ids: string[]): Promise<Map<string, { name: string | null; email: string | null }>> {
    const valid = [...new Set(ids.filter((id) => OID.test(id)))];
    if (!valid.length) return new Map();
    const rows: any[] = await this.db.repositories.adminModel.find({ _id: { $in: valid } }).select('name email').lean();
    return new Map(rows.map((r) => [String(r._id), { name: r.name ?? null, email: r.email ?? null }]));
  }

  // ── Compensation profiles ───────────────────────────────────────────────────
  async listProfiles() {
    const [admins, profs]: [any[], any[]] = await Promise.all([
      this.db.repositories.adminModel.find({ isDelete: { $ne: true } }).select('name email isStaff staffStatus').sort({ name: 1 }).lean(),
      this.profiles.find({}).lean(),
    ]);
    const byId = new Map(profs.map((p) => [p.adminId, p]));
    const month = monthOf(new Date());
    return admins.map((a) => {
      const p = byId.get(String(a._id));
      const v = p ? versionFor<any>(p.versions ?? [], month) ?? (p.versions ?? []).slice(-1)[0] ?? null : null;
      return {
        adminId: String(a._id), name: a.name ?? null, email: a.email ?? null, isStaff: !!a.isStaff, staffStatus: a.staffStatus ?? null,
        hasProfile: !!p, active: p?.active ?? false, designation: p?.designation ?? null, managerId: p?.managerId ?? null,
        joiningDate: p?.joiningDate ?? null, exitDate: p?.exitDate ?? null,
        current: v ? {
          effectiveFrom: v.effectiveFrom, workerType: v.workerType, baseMonthlySalary: v.baseMonthlySalary, monthlyRetainer: v.monthlyRetainer,
          allowancesTotal: round2((v.allowances ?? []).reduce((s: number, x: any) => s + (x.amount || 0), 0)),
          incentiveRules: (v.incentiveRules ?? []).length, bonusTiers: (v.bonusTiers ?? []).length,
        } : null,
      };
    });
  }

  private publicProfile(p: any, names?: Map<string, { name: string | null; email: string | null }>) {
    if (!p) return null;
    const rest = { ...p };
    delete rest.cnicEnc;
    delete rest.ntnEnc;
    delete rest.bankAccountEnc;
    return {
      ...rest,
      cnic: p.cnicLast4 ? maskValue(`000000000${p.cnicLast4}`) : null,
      ntn: p.ntnLast4 ? maskValue(`00000${p.ntnLast4}`) : null,
      bankAccount: p.bankAccountLast4 ? maskValue(`0000000000${p.bankAccountLast4}`) : null,
      managerName: p.managerId ? names?.get(p.managerId)?.name ?? null : null,
      versions: [...(p.versions ?? [])].sort((a: any, b: any) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)),
    };
  }

  async getProfile(adminId: string) {
    const [p, names]: [any, any] = await Promise.all([this.profiles.findOne({ adminId }).lean(), this.adminNames([adminId])]);
    const self = names.get(adminId);
    if (!self) throw new NotFoundException('Team member not found.');
    const mgr = p?.managerId ? await this.adminNames([p.managerId]) : new Map();
    const lastApproved: any = await this.runs.findOne({ status: { $in: ['approved', 'paid'] }, 'lines.adminId': adminId }).sort({ month: -1 }).select('month').lean();
    return { adminId, name: self.name, email: self.email, profile: this.publicProfile(p, mgr), lockedThrough: lastApproved?.month ?? null };
  }

  private cleanVersion(v: any): PayVersion & { note: string | null } {
    if (!v || typeof v !== 'object') throw new BadRequestException('Pay details are missing.');
    if (!isMonth(v.effectiveFrom)) throw new BadRequestException('Choose the month the pay applies from (YYYY-MM).');
    if (!WORKER_TYPES.includes(v.workerType)) throw new BadRequestException('Choose employee or contractor.');
    const list = (x: unknown, max: number, label: string): any[] => {
      if (x === undefined || x === null) return [];
      if (!Array.isArray(x) || x.length > max) throw new BadRequestException(`Up to ${max} ${label}.`);
      return x;
    };
    const allowances = list(v.allowances, 20, 'allowances').map((a, i) => {
      const name = str(a?.name, 60);
      if (!name) throw new BadRequestException(`Allowance ${i + 1} needs a name.`);
      return { name, amount: num(a?.amount, `${name} amount`, { max: 10_000_000 }), taxable: a?.taxable !== false };
    });
    const incentiveRules = list(v.incentiveRules, 30, 'incentive rules').map((r, i) => {
      if (!INCENTIVE_METRICS.includes(r?.metric)) throw new BadRequestException(`Incentive rule ${i + 1}: choose what it counts.`);
      const metric = r.metric as IncentiveMetric;
      const unit: RuleUnit = metric === 'managed_store_commission' ? 'percent' : 'per_unit';
      if (r?.unit && (!(RULE_UNITS as readonly string[]).includes(r.unit) || r.unit !== unit)) throw new BadRequestException(`Incentive rule ${i + 1}: ${metric === 'managed_store_commission' ? 'commission is paid as a %' : 'paid per unit'}.`);
      return {
        metric, unit, rate: num(r?.rate, `Incentive rule ${i + 1} rate`, { max: unit === 'percent' ? 100 : 1_000_000 }),
        minThreshold: optNum(r?.minThreshold, `Incentive rule ${i + 1} minimum`, { max: 1_000_000_000 }),
        cap: optNum(r?.cap, `Incentive rule ${i + 1} cap`, { max: 100_000_000 }), label: str(r?.label, 80) || null,
      };
    });
    const bonusTiers = list(v.bonusTiers, 30, 'bonus tiers').map((t, i) => {
      if (!BONUS_METRICS.includes(t?.metric)) throw new BadRequestException(`Bonus tier ${i + 1}: choose a measure.`);
      const isPct = t.metric === 'on_time_pct' || t.metric === 'reply_within_24h_pct';
      return {
        metric: t.metric, threshold: num(t?.threshold, `Bonus tier ${i + 1} threshold`, { max: isPct ? 100 : 1_000_000 }),
        bonus: num(t?.bonus, `Bonus tier ${i + 1} amount`, { max: 10_000_000 }),
        minSample: optNum(t?.minSample, `Bonus tier ${i + 1} minimum sample`, { max: 100_000 }), label: str(t?.label, 80) || null,
      };
    });
    const seen = new Set<string>();
    const claimRates = list(v.claimRates, CLAIM_TYPES.length, 'claim rates').map((c, i) => {
      if (!CLAIM_TYPES.includes(c?.type) || seen.has(c.type)) throw new BadRequestException(`Claim rate ${i + 1}: choose a claim type (once each).`);
      seen.add(c.type);
      return { type: c.type as ClaimType, rate: num(c?.rate, `${c.type} rate`, { max: 1_000_000 }) };
    });
    const contractor = v.workerType === 'contractor';
    return {
      effectiveFrom: v.effectiveFrom, workerType: v.workerType,
      baseMonthlySalary: num(v.baseMonthlySalary ?? 0, 'Basic salary'), monthlyRetainer: num(v.monthlyRetainer ?? 0, 'Retainer'),
      allowances, incentiveRules, bonusTiers, claimRates,
      eobiEnabled: !contractor && v.eobiEnabled !== false,
      pfEnabled: !contractor && !!v.pfEnabled,
      pfEmployeePct: contractor ? 0 : num(v.pfEmployeePct ?? 0, 'Provident fund (employee) %', { max: 100 }),
      pfEmployerPct: contractor ? 0 : num(v.pfEmployerPct ?? 0, 'Provident fund (employer) %', { max: 100 }),
      withholdingPct: contractor ? num(v.withholdingPct ?? 0, 'Withholding %', { max: 100 }) : 0,
      note: str(v.note, 300) || null,
    };
  }

  async saveProfile(actor: PayActor, adminId: string, dto: any) {
    const names = await this.adminNames([adminId, ...(dto?.managerId ? [String(dto.managerId)] : [])]);
    if (!names.has(adminId)) throw new NotFoundException('Team member not found.');
    const doc: any = (await this.profiles.findOne({ adminId })) ?? new this.profiles({ adminId, versions: [], history: [] });
    const changed: string[] = [];
    const set = (field: string, value: unknown) => {
      const before = doc[field] instanceof Date ? doc[field].toISOString() : doc[field];
      const after = value instanceof Date ? value.toISOString() : value;
      if (before !== after) { doc[field] = value; changed.push(field); }
    };
    if (dto.joiningDate !== undefined) set('joiningDate', dateOrNull(dto.joiningDate, 'Joining date'));
    if (dto.exitDate !== undefined) set('exitDate', dateOrNull(dto.exitDate, 'Exit date'));
    if (doc.joiningDate && doc.exitDate && doc.exitDate < doc.joiningDate) throw new BadRequestException('The exit date is before the joining date.');
    if (dto.managerId !== undefined) {
      const m = dto.managerId ? String(dto.managerId) : null;
      if (m && !names.has(m)) throw new BadRequestException('Manager not found.');
      if (m === adminId) throw new BadRequestException('A person cannot be their own manager.');
      set('managerId', m);
    }
    if (dto.designation !== undefined) set('designation', str(dto.designation, 80) || null);
    if (dto.active !== undefined) set('active', !!dto.active);
    if (dto.bankName !== undefined) set('bankName', str(dto.bankName, 80) || null);
    if (dto.eobiNumber !== undefined) set('eobiNumber', str(dto.eobiNumber, 30) || null);
    if (dto.accountTitle !== undefined) set('accountTitle', str(dto.accountTitle, 120) || null);
    const secret = (key: 'cnic' | 'ntn' | 'bankAccount', raw: unknown) => {
      if (raw === undefined) return;
      const clean = typeof raw === 'string' ? raw.replace(/[\s-]/g, '').slice(0, 40) : '';
      doc[`${key}Enc`] = clean ? encryptKycValue(clean) : null;
      doc[`${key}Last4`] = clean ? clean.slice(-4) : null;
      changed.push(key);
    };
    secret('cnic', dto.cnic);
    secret('ntn', dto.ntn);
    secret('bankAccount', dto.bankAccount);

    if (dto.version !== undefined) {
      const v = this.cleanVersion(dto.version);
      const locked: any = await this.runs.findOne({ status: { $in: ['approved', 'paid'] }, 'lines.adminId': adminId }).sort({ month: -1 }).select('month').lean();
      if (locked && v.effectiveFrom <= locked.month) throw new BadRequestException(`Payroll up to ${locked.month} is approved. New pay can apply from ${addMonths(locked.month, 1)} onwards.`);
      const versions = (doc.versions ?? []).filter((x: any) => x.effectiveFrom !== v.effectiveFrom);
      versions.push({ ...v, createdBy: actor.id, createdAt: new Date() });
      doc.versions = versions;
      changed.push(`pay from ${v.effectiveFrom}`);
    }
    if (!doc.versions?.length) throw new BadRequestException('Add the pay details (salary, allowances, incentives) first.');
    if (!changed.length) return this.getProfile(adminId);
    doc.history = [...(doc.history ?? []), { at: new Date(), by: actor.id, action: doc.isNew ? 'created' : 'updated', fields: changed }].slice(-200);
    await doc.save();
    this.log(actor, 'pay_profile_saved', `Pay profile of ${names.get(adminId)?.name ?? adminId} ${doc.isNew ? 'created' : 'updated'}: ${changed.join(', ')}`, adminId, { fields: changed });
    return this.getProfile(adminId);
  }

  /** Full CNIC / NTN / bank account (payroll.approve). Logged every time. */
  async revealIdentity(actor: PayActor, adminId: string) {
    this.need(actor, 'payroll.approve');
    const p: any = await this.profiles.findOne({ adminId }).select('+cnicEnc +ntnEnc +bankAccountEnc bankName accountTitle').lean();
    if (!p) throw new NotFoundException('No pay profile.');
    this.log(actor, 'pay_identity_viewed', `Viewed CNIC/NTN/bank details of team member ${adminId}`, adminId);
    return { cnic: decryptKycValue(p.cnicEnc), ntn: decryptKycValue(p.ntnEnc), bankAccount: decryptKycValue(p.bankAccountEnc), bankName: p.bankName ?? null, accountTitle: p.accountTitle ?? null };
  }

  // ── Tax years ───────────────────────────────────────────────────────────────
  async listTaxYears() {
    return this.taxYears.find({}).sort({ year: -1 }).lean();
  }

  /** A run in a year without rules gets a copy of the latest earlier year, flagged for verification. */
  private async ensureTaxYear(year: string): Promise<any> {
    const have = await this.taxYears.findOne({ year }).lean();
    if (have) return have;
    const prev: any = await this.taxYears.findOne({ year: { $lt: year } }).sort({ year: -1 }).lean();
    const base = prev ?? SEED_TAX_YEARS[SEED_TAX_YEARS.length - 1];
    await this.taxYears.updateOne({ year }, { $setOnInsert: {
      year, slabs: base.slabs, surcharge: base.surcharge ?? null, eobi: base.eobi, needsVerification: true,
      source: `Copy of ${prev?.year ?? 'the seeded year'}. Verify against that year's Finance Act before running payroll.`,
    } }, { upsert: true });
    return this.taxYears.findOne({ year }).lean();
  }

  async saveTaxYear(actor: PayActor, year: string, dto: any) {
    if (!/^\d{4}-\d{2}$/.test(year) || (Number(year.slice(0, 4)) + 1) % 100 !== Number(year.slice(5))) throw new BadRequestException('Tax year looks like 2026-27.');
    if (!Array.isArray(dto?.slabs) || !dto.slabs.length || dto.slabs.length > 20) throw new BadRequestException('Add the tax slabs.');
    const slabs = dto.slabs.map((s: any, i: number) => ({
      from: num(s?.from, `Slab ${i + 1} from`, { max: 10_000_000_000 }),
      to: s?.to === null || s?.to === '' || s?.to === undefined ? null : num(s.to, `Slab ${i + 1} to`, { max: 10_000_000_000 }),
      fixed: num(s?.fixed ?? 0, `Slab ${i + 1} fixed tax`, { max: 1_000_000_000 }),
      rate: num(s?.rate ?? 0, `Slab ${i + 1} rate`, { max: 100 }),
    })).sort((a: any, b: any) => a.from - b.from);
    if (slabs[0].from !== 0) throw new BadRequestException('The first slab must start at 0.');
    slabs.forEach((s: any, i: number) => {
      const next = slabs[i + 1];
      if (s.to !== null && s.to <= s.from) throw new BadRequestException(`Slab ${i + 1}: "to" must be above "from".`);
      if (next && s.to !== next.from) throw new BadRequestException(`Slab ${i + 1} must end where slab ${i + 2} starts.`);
      if (!next && s.to !== null) throw new BadRequestException('The last slab must be open-ended (leave "to" empty).');
    });
    const surcharge = dto.surcharge && Number(dto.surcharge.pct) > 0
      ? { threshold: num(dto.surcharge.threshold, 'Surcharge threshold', { max: 10_000_000_000 }), pct: num(dto.surcharge.pct, 'Surcharge %', { max: 100 }) } : null;
    const eobi = {
      minimumWage: num(dto?.eobi?.minimumWage, 'Minimum wage', { max: 10_000_000 }),
      employeePct: num(dto?.eobi?.employeePct ?? 1, 'EOBI employee %', { max: 100 }),
      employerPct: num(dto?.eobi?.employerPct ?? 5, 'EOBI employer %', { max: 100 }),
    };
    await this.taxYears.updateOne({ year }, {
      $set: { slabs, surcharge, eobi, notes: str(dto?.notes, 500) || null, needsVerification: true, verifiedBy: null, verifiedAt: null, source: str(dto?.source, 200) || 'Edited in Payroll > Tax settings' },
    }, { upsert: true });
    this.log(actor, 'tax_year_saved', `Tax year ${year} rules saved (needs verification)`, year);
    return this.taxYears.findOne({ year }).lean();
  }

  async verifyTaxYear(actor: PayActor, year: string) {
    this.need(actor, 'payroll.approve');
    const res = await this.taxYears.updateOne({ year }, { $set: { needsVerification: false, verifiedBy: actor.id, verifiedAt: new Date() } });
    if (!res.matchedCount) throw new NotFoundException('Tax year not found.');
    this.log(actor, 'tax_year_verified', `Tax year ${year} slabs marked as verified`, year);
    return this.taxYears.findOne({ year }).lean();
  }

  // ── Claims ──────────────────────────────────────────────────────────────────
  private async currentVersion(adminId: string, month: string): Promise<any> {
    const p: any = await this.profiles.findOne({ adminId }).select('versions').lean();
    return p ? versionFor<any>(p.versions ?? [], month) : null;
  }

  private async cleanClaim(adminId: string, dto: any) {
    if (!CLAIM_TYPES.includes(dto?.type)) throw new BadRequestException('Choose the claim type.');
    const date = parseDay(dto?.date);
    if (!date) throw new BadRequestException('Choose the date.');
    const today = new Date();
    if (date.getTime() > today.getTime() + 86_400_000) throw new BadRequestException('The date cannot be in the future.');
    if (date.getTime() < today.getTime() - 180 * 86_400_000) throw new BadRequestException('Claims older than 6 months cannot be submitted.');
    const month = monthOf(date);
    const v = await this.currentVersion(adminId, month);
    const rate = v?.claimRates?.find((c: any) => c.type === dto.type)?.rate ?? null;
    const quantity = optNum(dto?.quantity, 'Quantity', { min: 0, max: 10_000 });
    let amount: number;
    if (rate !== null && quantity !== null) amount = round2(rate * quantity);
    else amount = num(dto?.amount ?? 0, 'Amount', { max: 1_000_000 });
    if (dto.type !== 'visit' && amount <= 0) throw new BadRequestException('Enter the amount.');
    if (dto.type === 'visit' && amount <= 0 && !(quantity && quantity > 0)) throw new BadRequestException('Enter how many visits (and any travel amount).');
    return {
      type: dto.type as ClaimType, date, month, quantity: dto.type === 'visit' ? (quantity ?? 1) : quantity, rate: rate !== null && quantity !== null ? rate : null, amount,
      description: str(dto?.description, 500), visitedName: str(dto?.visitedName, 120) || null,
      storeId: typeof dto?.storeId === 'string' && OID.test(dto.storeId) ? dto.storeId : null,
    };
  }

  async myClaims(adminId: string, q: Record<string, string>) {
    const filter: Record<string, unknown> = { adminId };
    if (q.status && ['submitted', 'approved', 'rejected'].includes(q.status)) filter.status = q.status;
    return this.claims.find(filter).sort({ date: -1, createdAt: -1 }).limit(200).lean();
  }

  async createClaim(actor: PayActor, dto: any) {
    const clean = await this.cleanClaim(actor.id, dto);
    const doc = await this.claims.create({ ...clean, adminId: actor.id, status: 'submitted' });
    this.log(actor, 'claim_submitted', `Claim submitted: ${clean.type} ${clean.amount} PKR on ${clean.date.toISOString().slice(0, 10)}`, String(doc._id));
    return doc.toObject();
  }

  async updateClaim(actor: PayActor, id: string, dto: any) {
    const claim = await this.claims.findOne({ _id: id, adminId: actor.id });
    if (!claim) throw new NotFoundException('Claim not found.');
    if (claim.status !== 'submitted') throw new BadRequestException('Only a claim waiting for approval can be changed.');
    Object.assign(claim, await this.cleanClaim(actor.id, { ...claim.toObject(), ...dto }));
    await claim.save();
    return claim.toObject();
  }

  async deleteClaim(actor: PayActor, id: string) {
    const res = await this.claims.deleteOne({ _id: id, adminId: actor.id, status: 'submitted' });
    if (!res.deletedCount) throw new BadRequestException('Only your own claim that is still waiting can be deleted.');
    return { deleted: true };
  }

  async uploadReceipt(actor: PayActor, id: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Choose a file.');
    const okType = /^image\/(jpeg|png|webp|heic|heif)$/i.test(file.mimetype) || file.mimetype === 'application/pdf';
    if (!okType) throw new BadRequestException('Upload a photo (JPG, PNG, WebP) or a PDF.');
    const claim = await this.claims.findOne({ _id: id, adminId: actor.id });
    if (!claim) throw new NotFoundException('Claim not found.');
    if (claim.status !== 'submitted') throw new BadRequestException('Receipts can be added while the claim is waiting.');
    const up = await this.upload.uploadPrivateFile(file, RECEIPT_FOLDER);
    claim.receipt = { publicId: up.publicId, resourceType: up.resourceType, fileName: up.fileName, mimeType: up.mimeType };
    await claim.save();
    return claim.toObject();
  }

  /** Claim reviewers: owner, claims.approve, payroll.approve, payroll.view (read only) — or the person's manager. */
  private async reportIds(managerId: string): Promise<string[]> {
    const rows: any[] = await this.profiles.find({ managerId }).select('adminId').lean();
    return rows.map((r) => r.adminId);
  }

  private canDecideAll(actor: PayActor) { return this.can(actor, 'claims.approve') || this.can(actor, 'payroll.approve'); }

  async receiptUrl(actor: PayActor, id: string) {
    const claim: any = await this.claims.findById(id).lean();
    if (!claim?.receipt) throw new NotFoundException('No receipt on this claim.');
    const mine = claim.adminId === actor.id;
    const reviewer = this.canDecideAll(actor) || this.can(actor, 'payroll.view') || (await this.reportIds(actor.id)).includes(claim.adminId);
    if (!mine && !reviewer) throw new ForbiddenException('You cannot see this receipt.');
    return { url: this.upload.generateSignedUrl(claim.receipt.publicId, claim.receipt.resourceType, 600, claim.receipt.fileName, true), fileName: claim.receipt.fileName };
  }

  async listClaims(actor: PayActor, q: Record<string, string>) {
    const filter: Record<string, any> = {};
    if (!(this.canDecideAll(actor) || this.can(actor, 'payroll.view'))) {
      const reports = await this.reportIds(actor.id);
      if (!reports.length) throw new ForbiddenException("You do not review anyone's claims.");
      filter.adminId = { $in: reports };
    }
    if (q.status && ['submitted', 'approved', 'rejected'].includes(q.status)) filter.status = q.status;
    if (q.adminId && OID.test(q.adminId)) filter.adminId = filter.adminId ? { $in: (filter.adminId.$in as string[]).filter((x) => x === q.adminId) } : q.adminId;
    if (isMonth(q.month)) filter.month = q.month;
    const rows: any[] = await this.claims.find(filter).sort({ status: 1, date: -1 }).limit(500).lean();
    const names = await this.adminNames(rows.flatMap((r) => [r.adminId, r.decidedBy].filter(Boolean)));
    return rows.map((r) => ({ ...r, name: names.get(r.adminId)?.name ?? null, email: names.get(r.adminId)?.email ?? null, decidedByName: r.decidedBy ? names.get(r.decidedBy)?.name ?? null : null }));
  }

  async decideClaim(actor: PayActor, id: string, approve: boolean, note?: string | null, taxable?: boolean) {
    const claim = await this.claims.findById(id);
    if (!claim) throw new NotFoundException('Claim not found.');
    if (claim.status !== 'submitted') throw new BadRequestException('This claim was already decided.');
    if (claim.adminId === actor.id && !actor.isOwner) throw new ForbiddenException('You cannot approve your own claim.');
    const allowed = this.canDecideAll(actor) || (await this.reportIds(actor.id)).includes(claim.adminId);
    if (!allowed) throw new ForbiddenException('Only their manager or a payroll approver can decide this claim.');
    if (!approve && !str(note, 300)) throw new BadRequestException('Say why the claim is rejected.');
    claim.status = approve ? 'approved' : 'rejected';
    claim.decidedBy = actor.id;
    claim.decidedAt = new Date();
    claim.decisionNote = str(note, 300) || null;
    if (approve && typeof taxable === 'boolean') claim.taxable = taxable; // reimbursements are tax-free unless the approver says otherwise
    await claim.save();
    this.log(actor, approve ? 'claim_approved' : 'claim_rejected', `Claim ${claim.type} ${claim.amount} PKR ${approve ? 'approved' : 'rejected'}`, id);
    return claim.toObject();
  }

  // ── Advances ────────────────────────────────────────────────────────────────
  async listAdvances(q: Record<string, string> = {}) {
    const filter: Record<string, unknown> = {};
    if (q.adminId && OID.test(q.adminId)) filter.adminId = q.adminId;
    const rows: any[] = await this.advances.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const names = await this.adminNames(rows.map((r) => r.adminId));
    return rows.map((r) => ({ ...r, name: names.get(r.adminId)?.name ?? null, outstanding: round2(r.amount - (r.recovered ?? 0)) }));
  }

  async createAdvance(actor: PayActor, dto: any) {
    const adminId = String(dto?.adminId ?? '');
    if (!(await this.adminNames([adminId])).has(adminId)) throw new BadRequestException('Choose the team member.');
    const date = parseDay(dto?.date);
    if (!date) throw new BadRequestException('Choose the date.');
    const amount = num(dto?.amount, 'Amount', { min: 1, max: 100_000_000 });
    const monthlyRecovery = num(dto?.monthlyRecovery ?? 0, 'Monthly recovery', { max: amount });
    const paidFromAccount = str(dto?.paidFromAccount, 10) || PAYROLL_ACCOUNTS.bank;
    const acc = (await this.ledger.accountMap()).get(paidFromAccount);
    if (!acc || acc.type !== 'asset' || !['bank', 'cash'].includes(acc.subtype)) throw new BadRequestException('Pay the advance from a bank or cash account.');
    const doc = await this.advances.create({ adminId, date, amount, monthlyRecovery, reason: str(dto?.reason, 300), paidFromAccount, status: 'submitted', preparedBy: actor.id });
    this.log(actor, 'advance_prepared', `Advance of ${amount} PKR prepared for ${adminId}`, String(doc._id));
    return doc.toObject();
  }

  async decideAdvance(actor: PayActor, id: string, approve: boolean, reason?: string | null) {
    this.need(actor, 'payroll.approve');
    const adv = await this.advances.findById(id);
    if (!adv) throw new NotFoundException('Advance not found.');
    if (adv.status !== 'submitted') throw new BadRequestException('This advance was already decided.');
    if (!actor.isOwner && adv.preparedBy === actor.id) throw new ForbiddenException('Someone other than the preparer must approve it.');
    if (!approve) {
      adv.status = 'rejected';
      adv.rejectionReason = str(reason, 300) || null;
      await adv.save();
      this.log(actor, 'advance_rejected', `Advance ${id} rejected`, id);
      return adv.toObject();
    }
    const name = (await this.adminNames([adv.adminId])).get(adv.adminId)?.name ?? null;
    const { entry } = await this.ledger.postJournal({
      date: adv.date, memo: `Advance to ${name ?? 'team member'}${adv.reason ? `: ${adv.reason}` : ''}`, kind: 'auto',
      source: { type: 'payroll', id: `advance:${id}`, ref: `Advance ${name ?? ''}`.trim() }, preparedBy: adv.preparedBy, approvedBy: actor.id,
      lines: [
        { accountCode: PAYROLL_ACCOUNTS.advances, debit: adv.amount, party: { type: 'employee', id: adv.adminId, name }, description: 'Advance paid' },
        { accountCode: adv.paidFromAccount, credit: adv.amount, description: 'Advance paid' },
      ],
    });
    adv.status = 'approved';
    adv.approvedBy = actor.id;
    adv.approvedAt = new Date();
    adv.journalId = String(entry._id);
    await adv.save();
    this.log(actor, 'advance_approved', `Advance of ${adv.amount} PKR approved and posted`, id);
    return adv.toObject();
  }

  // ── Payroll runs ────────────────────────────────────────────────────────────
  async listRuns() {
    const rows: any[] = await this.runs.find({}).select('-lines').sort({ month: -1, createdAt: -1 }).limit(60).lean();
    return rows;
  }

  async getRun(id: string) {
    const run: any = await this.runs.findById(id).lean();
    if (!run) throw new NotFoundException('Payroll run not found.');
    const tax: any = await this.taxYears.findOne({ year: run.taxYear }).select('needsVerification source').lean();
    const names = await this.adminNames([run.preparedBy, run.submittedBy, run.approvedBy].filter(Boolean));
    return { ...run, taxYearNeedsVerification: !!tax?.needsVerification, taxYearSource: tax?.source ?? null,
      preparedByName: names.get(run.preparedBy)?.name ?? null, submittedByName: names.get(run.submittedBy)?.name ?? null, approvedByName: names.get(run.approvedBy)?.name ?? null };
  }

  async createRun(actor: PayActor, month: string) {
    if (!isMonth(month)) throw new BadRequestException('Choose the month (YYYY-MM).');
    if (month < BOOKS_MONTH) throw new BadRequestException(`Payroll starts with the books in ${BOOKS_MONTH}.`);
    if (month > monthOf(new Date())) throw new BadRequestException('Payroll can only be prepared for this month or earlier.');
    const earlierOpen = await this.runs.exists({ live: true, month: { $lt: month }, status: { $in: ['draft', 'submitted'] } });
    if (earlierOpen) throw new BadRequestException("Approve or cancel the earlier month's payroll first (tax is worked out month by month).");
    let run: PayrollRunDocument;
    try {
      run = await this.runs.create({ month, taxYear: taxYearOf(month), status: 'draft', live: true, preparedBy: actor.id, lines: [], history: [{ at: new Date(), by: actor.id, action: 'created' }] });
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException(`There is already a payroll for ${month}.`);
      throw e;
    }
    await this.calculate(run);
    this.log(actor, 'payroll_run_created', `Payroll ${month} prepared`, String(run._id));
    return this.getRun(String(run._id));
  }

  /** (Re)builds every payslip of a draft run; manual additions/deductions and exclusions are kept. */
  private async calculate(run: PayrollRunDocument) {
    const month = run.month;
    const { start, end } = monthBounds(month);
    const profs: any[] = await this.profiles.find({
      $and: [{ $or: [{ joiningDate: null }, { joiningDate: { $lt: end } }] }, { $or: [{ exitDate: null }, { exitDate: { $gte: start } }] }],
      $or: [{ active: true }, { exitDate: { $gte: start } }],
    }).lean();
    const people = profs.map((p) => ({ p, v: versionFor<any>(p.versions ?? [], month) })).filter((x) => x.v);
    const ids = people.map((x) => x.p.adminId);
    const prevLines = new Map<string, any>((run.lines ?? []).map((l: any) => [l.adminId, l]));

    const [metrics, names, tax, claimRows, advanceRows, ytd] = await Promise.all([
      this.metrics.forMonth(month, ids),
      this.adminNames(ids),
      this.ensureTaxYear(run.taxYear),
      this.claims.find({ adminId: { $in: ids }, status: 'approved', date: { $lt: end }, $or: [{ payrollRunId: null }, { payrollRunId: String(run._id) }] }).lean(),
      this.advances.find({ adminId: { $in: ids }, status: 'approved', date: { $lt: end } }).lean(),
      this.ytd(run.taxYear, month, ids),
    ]);
    const rules: TaxRules = { slabs: tax.slabs, surcharge: tax.surcharge ?? null };

    const lines = people.map(({ p, v }) => {
      const prev = prevLines.get(p.adminId);
      const manual: ManualLine[] = Array.isArray(prev?.manual) ? prev.manual : [];
      const m = metrics.get(p.adminId) ?? { counts: emptyCounts(), perf: { on_time_pct: null, on_time_sample: 0, reply_within_24h_pct: null, reply_sample: 0, orders_handled: 0, products_listed: 0, sellers_onboarded: 0, support_replies: 0 } };
      const claims = (claimRows as any[]).filter((c) => c.adminId === p.adminId).map((c) => ({
        id: String(c._id), type: c.type, amount: c.amount, taxable: !!c.taxable,
        label: `${c.type[0].toUpperCase()}${c.type.slice(1)} claim ${new Date(c.date).toISOString().slice(0, 10)}${c.description ? ` — ${String(c.description).slice(0, 60)}` : ''}`,
      }));
      const advances = (advanceRows as any[]).filter((a) => a.adminId === p.adminId && a.amount - (a.recovered ?? 0) > 0)
        .map((a) => ({ id: String(a._id), outstanding: round2(a.amount - (a.recovered ?? 0)), monthlyRecovery: a.monthlyRecovery ?? 0 }));
      const slip: Payslip = buildPayslip({
        month, version: v, joiningDate: p.joiningDate ? new Date(p.joiningDate) : null, exitDate: p.exitDate ? new Date(p.exitDate) : null,
        counts: m.counts, perf: m.perf, claims, advances, manual, ytd: ytd.get(p.adminId) ?? { taxable: 0, tax: 0 }, tax: rules, eobi: tax.eobi,
      });
      const who = names.get(p.adminId);
      return {
        adminId: p.adminId, name: who?.name ?? null, email: who?.email ?? null, designation: p.designation ?? null,
        versionEffectiveFrom: v.effectiveFrom, excluded: !!prev?.excluded, manual, metrics: m.counts, perf: m.perf, ...slip, paid: null,
      };
    });
    run.lines = lines;
    run.totals = this.totals(lines);
    run.calculatedAt = new Date();
    run.markModified('lines');
    await run.save();
  }

  private totals(lines: any[]) {
    const live = lines.filter((l) => !l.excluded);
    const sum = (f: (l: any) => number) => round2(live.reduce((s, l) => s + f(l), 0));
    return {
      people: live.length, gross: sum((l) => l.gross), deductions: sum((l) => l.totalDeductions), net: sum((l) => l.net), employerCost: sum((l) => l.employerCost),
      incomeTax: sum((l) => (l.deductions ?? []).filter((d: any) => d.kind === 'income_tax').reduce((s: number, d: any) => s + d.amount, 0)),
    };
  }

  /** Taxable income and salary tax already withheld earlier in the tax year (approved/paid runs only). */
  private async ytd(taxYear: string, beforeMonth: string, ids: string[]): Promise<Map<string, { taxable: number; tax: number }>> {
    const runs: any[] = await this.runs.find({ taxYear, month: { $lt: beforeMonth }, status: { $in: ['approved', 'paid'] } }).select('lines.adminId lines.excluded lines.taxableIncome lines.deductions').lean();
    const out = new Map<string, { taxable: number; tax: number }>();
    for (const r of runs) for (const l of r.lines ?? []) {
      if (l.excluded || !ids.includes(l.adminId)) continue;
      const x = out.get(l.adminId) ?? { taxable: 0, tax: 0 };
      x.taxable = round2(x.taxable + (l.taxableIncome ?? 0));
      x.tax = round2(x.tax + (l.deductions ?? []).filter((d: any) => d.kind === 'income_tax').reduce((s: number, d: any) => s + d.amount, 0));
      out.set(l.adminId, x);
    }
    return out;
  }

  private async draftRun(id: string): Promise<PayrollRunDocument> {
    const run = await this.runs.findById(id);
    if (!run) throw new NotFoundException('Payroll run not found.');
    if (run.status !== 'draft') throw new BadRequestException('Only a draft payroll can be changed. Ask the approver to send it back first.');
    return run;
  }

  async recalculate(actor: PayActor, id: string) {
    const run = await this.draftRun(id);
    await this.calculate(run);
    this.log(actor, 'payroll_run_recalculated', `Payroll ${run.month} recalculated`, id);
    return this.getRun(id);
  }

  async updateLine(actor: PayActor, id: string, adminId: string, dto: any) {
    const run = await this.draftRun(id);
    const line: any = (run.lines ?? []).find((l: any) => l.adminId === adminId);
    if (!line) throw new NotFoundException('This person is not on the payroll.');
    if (dto.excluded !== undefined) line.excluded = !!dto.excluded;
    if (dto.manual !== undefined) {
      if (!Array.isArray(dto.manual) || dto.manual.length > 20) throw new BadRequestException('Up to 20 manual lines.');
      line.manual = dto.manual.map((m: any, i: number) => {
        if (!['addition', 'deduction'].includes(m?.type)) throw new BadRequestException(`Line ${i + 1}: addition or deduction.`);
        const label = str(m?.label, 80);
        if (!label) throw new BadRequestException(`Line ${i + 1} needs a description.`);
        return { type: m.type, label, amount: num(m?.amount, `${label} amount`, { min: 0.01, max: 100_000_000 }), taxable: m.type === 'addition' ? m?.taxable !== false : undefined };
      });
    }
    run.markModified('lines');
    await run.save();
    await this.calculate(run);
    this.log(actor, 'payroll_line_adjusted', `Payroll ${run.month}: adjusted ${line.name ?? adminId}`, id, { adminId });
    return this.getRun(id);
  }

  async submit(actor: PayActor, id: string) {
    const run = await this.draftRun(id);
    if (!(run.lines ?? []).some((l: any) => !l.excluded)) throw new BadRequestException('Nobody is on this payroll.');
    run.status = 'submitted';
    run.submittedBy = actor.id;
    run.submittedAt = new Date();
    run.history.push({ at: new Date(), by: actor.id, action: 'submitted' });
    await run.save();
    this.log(actor, 'payroll_run_submitted', `Payroll ${run.month} submitted for approval`, id);
    return this.getRun(id);
  }

  async reject(actor: PayActor, id: string, reason?: string | null) {
    this.need(actor, 'payroll.approve');
    const run = await this.runs.findById(id);
    if (!run || run.status !== 'submitted') throw new BadRequestException('Only a payroll waiting for approval can be sent back.');
    run.status = 'draft';
    run.rejectionReason = str(reason, 300) || null;
    run.history.push({ at: new Date(), by: actor.id, action: 'sent_back', note: run.rejectionReason });
    await run.save();
    this.log(actor, 'payroll_run_rejected', `Payroll ${run.month} sent back${run.rejectionReason ? `: ${run.rejectionReason}` : ''}`, id);
    return this.getRun(id);
  }

  async cancel(actor: PayActor, id: string) {
    const run = await this.runs.findById(id);
    if (!run || !['draft', 'submitted'].includes(run.status)) throw new BadRequestException('Only a payroll that is not approved can be cancelled.');
    run.status = 'cancelled';
    run.live = false;
    run.history.push({ at: new Date(), by: actor.id, action: 'cancelled' });
    await run.save();
    this.log(actor, 'payroll_run_cancelled', `Payroll ${run.month} cancelled`, id);
    return this.getRun(id);
  }

  /** Approve: locks the run, posts the accrual journal, marks claims paid and records advance recoveries. */
  async approve(actor: PayActor, id: string) {
    this.need(actor, 'payroll.approve');
    const run = await this.runs.findById(id);
    if (!run || run.status !== 'submitted') throw new BadRequestException('Only a payroll waiting for approval can be approved.');
    if (!actor.isOwner && (run.preparedBy === actor.id || run.submittedBy === actor.id)) throw new ForbiddenException('Someone other than the preparer must approve the payroll.');
    const lines = (run.lines ?? []).filter((l: any) => !l.excluded);
    if (lines.some((l: any) => l.workerType === 'employee')) {
      const tax: any = await this.taxYears.findOne({ year: run.taxYear }).lean();
      if (!tax || tax.needsVerification) throw new BadRequestException(`The ${run.taxYear} tax slabs are not verified. Check them in Payroll > Tax settings and mark them verified first.`);
    }
    const journalLines = accrualLines(lines.map((l: any) => ({ adminId: l.adminId, name: l.name, slip: l })), PAYROLL_ACCOUNTS);
    let accrualJournalId: string | null = null;
    if (journalLines.length) {
      const { end } = monthBounds(run.month);
      const { entry } = await this.ledger.postJournal({
        date: new Date(end.getTime() - 86_400_000), memo: `Payroll ${run.month}`, kind: 'auto',
        source: { type: 'payroll', id: `run:${id}:accrual`, ref: `Payroll ${run.month}` }, preparedBy: run.preparedBy, approvedBy: actor.id, lines: journalLines,
      });
      accrualJournalId = String(entry._id);
    }
    const claimIds = lines.flatMap((l: any) => l.claimIds ?? []);
    if (claimIds.length) await this.claims.updateMany({ _id: { $in: claimIds }, status: 'approved', payrollRunId: null }, { $set: { payrollRunId: id, payrollMonth: run.month } });
    for (const l of lines) for (const r of l.advanceRecoveries ?? []) {
      await this.advances.updateOne({ _id: r.advanceId, 'recoveries.runId': { $ne: id } }, { $inc: { recovered: r.amount }, $push: { recoveries: { runId: id, month: run.month, amount: r.amount, at: new Date() } } });
      await this.advances.updateOne({ _id: r.advanceId, $expr: { $gte: ['$recovered', '$amount'] } }, { $set: { status: 'cleared' } });
    }
    for (const l of run.lines) if (!l.excluded && l.net <= 0) l.paid = { at: new Date(), by: actor.id, account: null, journalId: null };
    run.status = run.lines.every((l) => l.excluded || l.paid) ? 'paid' : 'approved';
    run.approvedBy = actor.id;
    run.approvedAt = new Date();
    run.accrualJournalId = accrualJournalId;
    run.history.push({ at: new Date(), by: actor.id, action: 'approved' });
    run.markModified('lines');
    await run.save();
    this.log(actor, 'payroll_run_approved', `Payroll ${run.month} approved: net ${run.totals?.net ?? 0} PKR for ${run.totals?.people ?? 0} people`, id);
    return this.getRun(id);
  }

  /** Record salary payments (bank transfer / cash): one journal per person, Dr Salaries payable / Cr the account. */
  async pay(actor: PayActor, id: string, dto: any) {
    this.need(actor, 'payroll.approve');
    const run = await this.runs.findById(id);
    if (!run || !['approved', 'paid'].includes(run.status)) throw new BadRequestException('Approve the payroll before recording payments.');
    const date = parseDay(dto?.date) ?? new Date();
    const account = str(dto?.account, 10) || PAYROLL_ACCOUNTS.bank;
    const acc = (await this.ledger.accountMap()).get(account);
    if (!acc || acc.type !== 'asset' || !['bank', 'cash'].includes(acc.subtype)) throw new BadRequestException('Pay from a bank or cash account.');
    const only: string[] | null = Array.isArray(dto?.adminIds) && dto.adminIds.length ? dto.adminIds.map(String) : null;
    let paid = 0;
    for (const l of run.lines) {
      if (l.excluded || l.paid || (only && !only.includes(l.adminId))) continue;
      const { entry } = await this.ledger.postJournal({
        date, memo: `Salary ${run.month} — ${l.name ?? l.email ?? l.adminId}`, kind: 'auto',
        source: { type: 'payroll', id: `run:${id}:pay:${l.adminId}`, ref: `Payroll ${run.month}` }, preparedBy: actor.id, approvedBy: actor.id,
        lines: [
          { accountCode: PAYROLL_ACCOUNTS.salariesPayable, debit: l.net, party: { type: 'employee', id: l.adminId, name: l.name }, description: `Net pay ${run.month}` },
          { accountCode: account, credit: l.net, description: `Net pay ${run.month}` },
        ],
      });
      l.paid = { at: date, by: actor.id, account, journalId: String(entry._id) };
      paid++;
    }
    if (!paid) throw new BadRequestException('Nothing left to pay on this payroll.');
    if (run.lines.every((l) => l.excluded || l.paid)) run.status = 'paid';
    run.history.push({ at: new Date(), by: actor.id, action: 'payments_recorded', note: `${paid} payment(s) from ${account}` });
    run.markModified('lines');
    await run.save();
    this.log(actor, 'payroll_paid', `Payroll ${run.month}: ${paid} salary payment(s) recorded from ${account}`, id);
    return this.getRun(id);
  }

  // ── Payslips ────────────────────────────────────────────────────────────────
  async payslipPdf(actor: PayActor, runId: string, adminId: string): Promise<{ body: Buffer; fileName: string }> {
    const run: any = await this.runs.findById(runId).lean();
    if (!run) throw new NotFoundException('Payroll run not found.');
    const self = actor.id === adminId;
    if (!this.can(actor, 'payroll.view') && !self) throw new ForbiddenException('You can only download your own payslips.');
    if (self && !this.can(actor, 'payroll.view') && !['approved', 'paid'].includes(run.status)) throw new ForbiddenException('Your payslip is ready once the payroll is approved.');
    const line = (run.lines ?? []).find((l: any) => l.adminId === adminId && !l.excluded);
    if (!line) throw new NotFoundException('No payslip for this person in this month.');
    const p: any = await this.profiles.findOne({ adminId }).lean();
    const body = await renderPayslipPdf({ run, line, profile: p ? { bankName: p.bankName, bankAccount: p.bankAccountLast4 ? `••••${p.bankAccountLast4}` : null, cnic: p.cnicLast4 ? `••••${p.cnicLast4}` : null, designation: p.designation } : null });
    return { body, fileName: `payslip-${run.month}-${String(line.name ?? adminId).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf` };
  }

  async payslipsZip(actor: PayActor, runId: string): Promise<{ body: Buffer; fileName: string }> {
    this.need(actor, 'payroll.view');
    const run: any = await this.runs.findById(runId).lean();
    if (!run) throw new NotFoundException('Payroll run not found.');
    const archiver = (await import('archiver')).default;
    const { PassThrough } = await import('node:stream');
    const files: { name: string; body: Buffer }[] = [];
    for (const l of (run.lines ?? []).filter((x: any) => !x.excluded)) files.push(await this.payslipPdf(actor, runId, l.adminId).then((f) => ({ name: f.fileName, body: f.body })));
    const body = await new Promise<Buffer>((resolve, reject) => {
      const zip = archiver('zip', { zlib: { level: 6 } });
      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on('data', (c: Buffer) => chunks.push(c));
      out.on('end', () => resolve(Buffer.concat(chunks)));
      zip.on('error', reject);
      zip.pipe(out);
      for (const f of files) zip.append(f.body, { name: f.name });
      void zip.finalize();
    });
    return { body, fileName: `payslips-${run.month}.zip` };
  }

  // ── Reports ─────────────────────────────────────────────────────────────────
  async report(name: string, q: Record<string, string>): Promise<ReportTable> {
    const L = (key: string, label: string, width?: number) => ({ key, label, width });
    const R = (key: string, label: string, width?: number) => ({ key, label, align: 'right' as const, width });
    const sumKind = (l: any, kind: string) => round2((l.deductions ?? []).filter((d: any) => d.kind === kind).reduce((s: number, d: any) => s + d.amount, 0));
    const runFor = async (month: string) => {
      if (!isMonth(month)) throw new BadRequestException('Choose the month.');
      const run: any = await this.runs.findOne({ month, live: true }).lean();
      if (!run) throw new NotFoundException(`No payroll for ${month}.`);
      return run;
    };
    switch (name) {
      case 'register': {
        const run = await runFor(q.month);
        const lines = (run.lines ?? []).filter((l: any) => !l.excluded);
        const rows = lines.map((l: any) => ({
          name: l.name ?? l.email, type: l.workerType, days: `${l.daysWorked}/${l.daysInMonth}`, gross: l.gross, taxable: l.taxableIncome,
          tax: sumKind(l, 'income_tax') + sumKind(l, 'withholding'), eobi: sumKind(l, 'eobi'), pf: sumKind(l, 'pf'), advance: sumKind(l, 'advance'), other: sumKind(l, 'manual'),
          net: l.net, employer: l.employerCost, paid: l.paid ? 'Paid' : 'Unpaid',
        }));
        const t = (k: string) => round2(rows.reduce((s: number, r: any) => s + (r[k] || 0), 0));
        return { title: `Payroll register — ${run.month}`, subtitle: `Status: ${run.status} · PKR`,
          columns: [L('name', 'Name', 26), L('type', 'Type', 10), L('days', 'Days', 8), R('gross', 'Gross'), R('taxable', 'Taxable'), R('tax', 'Tax'), R('eobi', 'EOBI'), R('pf', 'PF'), R('advance', 'Advance'), R('other', 'Other'), R('net', 'Net pay'), R('employer', 'Employer cost'), L('paid', 'Paid', 8)],
          rows: [...rows, { name: 'Total', gross: t('gross'), taxable: t('taxable'), tax: t('tax'), eobi: t('eobi'), pf: t('pf'), advance: t('advance'), other: t('other'), net: t('net'), employer: t('employer'), _bold: 1 }] };
      }
      case 'tax': {
        const year = /^\d{4}-\d{2}$/.test(q.taxYear ?? '') ? q.taxYear : taxYearOf(monthOf(new Date()));
        const runs: any[] = await this.runs.find({ taxYear: year, status: { $in: ['approved', 'paid'] } }).sort({ month: 1 }).lean();
        const ids = [...new Set(runs.flatMap((r) => (r.lines ?? []).map((l: any) => l.adminId)))];
        const profs: any[] = await this.profiles.find({ adminId: { $in: ids } }).select('+cnicEnc +ntnEnc adminId').lean();
        const idOf = new Map(profs.map((p) => [p.adminId, { cnic: decryptKycValue(p.cnicEnc), ntn: decryptKycValue(p.ntnEnc) }]));
        const rows: any[] = [];
        for (const id of ids) {
          let taxable = 0; let tax = 0; let name = '';
          for (const r of runs) {
            const l = (r.lines ?? []).find((x: any) => x.adminId === id && !x.excluded);
            if (!l) continue;
            name = l.name ?? l.email ?? id;
            const t = sumKind(l, 'income_tax') + sumKind(l, 'withholding');
            taxable = round2(taxable + l.taxableIncome); tax = round2(tax + t);
            rows.push({ name, type: l.workerType, cnic: idOf.get(id)?.cnic ?? '', ntn: idOf.get(id)?.ntn ?? '', month: r.month, taxable: l.taxableIncome, tax: t });
          }
          rows.push({ name: `${name} — total`, taxable, tax, _bold: 1 });
        }
        return { title: `Tax deducted — tax year ${year}`, subtitle: 'Salary tax (employees) and withholding (contractors), approved payrolls · PKR',
          columns: [L('name', 'Name', 26), L('type', 'Type', 10), L('cnic', 'CNIC', 16), L('ntn', 'NTN', 14), L('month', 'Month', 9), R('taxable', 'Taxable income'), R('tax', 'Tax deducted')], rows };
      }
      case 'eobi': {
        const run = await runFor(q.month);
        const ids = (run.lines ?? []).map((l: any) => l.adminId);
        const profs: any[] = await this.profiles.find({ adminId: { $in: ids } }).select('+cnicEnc adminId').lean();
        const cnic = new Map(profs.map((p) => [p.adminId, decryptKycValue(p.cnicEnc)]));
        const rows = (run.lines ?? []).filter((l: any) => !l.excluded && l.workerType === 'employee').map((l: any) => {
          const emp = sumKind(l, 'eobi');
          const er = round2((l.employer ?? []).filter((e: any) => e.kind === 'eobi').reduce((s: number, e: any) => s + e.amount, 0));
          return { name: l.name ?? l.email, cnic: cnic.get(l.adminId) ?? '', employee: emp, employer: er, total: round2(emp + er) };
        }).filter((r: any) => r.total > 0);
        const t = (k: string) => round2(rows.reduce((s: number, r: any) => s + r[k], 0));
        return { title: `EOBI contributions — ${run.month}`, subtitle: 'PKR',
          columns: [L('name', 'Name', 30), L('cnic', 'CNIC', 18), R('employee', 'Employee'), R('employer', 'Employer'), R('total', 'Total')],
          rows: [...rows, { name: 'Total', employee: t('employee'), employer: t('employer'), total: t('total'), _bold: 1 }] };
      }
      case 'incentives': {
        const run = await runFor(q.month);
        const rows: any[] = [];
        for (const l of (run.lines ?? []).filter((x: any) => !x.excluded)) {
          for (const e of (l.earnings ?? []).filter((x: any) => x.kind === 'incentive' || x.kind === 'bonus')) {
            rows.push({ name: l.name ?? l.email, item: e.label, count: e.meta?.count ?? e.meta?.value ?? null, rate: e.meta?.rate ?? null, amount: e.amount });
          }
        }
        return { title: `Incentives & bonuses — ${run.month}`, subtitle: 'PKR',
          columns: [L('name', 'Name', 26), L('item', 'Incentive', 34), R('count', 'Count'), R('rate', 'Rate'), R('amount', 'Amount')],
          rows: [...rows, { name: 'Total', amount: round2(rows.reduce((s, r) => s + r.amount, 0)), _bold: 1 }] };
      }
      case 'claims': {
        const from = parseDay(q.from) ?? new Date(Date.now() - 90 * 86_400_000);
        const to = parseDay(q.to) ?? new Date();
        const filter: Record<string, unknown> = { date: { $gte: from, $lte: new Date(to.getTime() + 86_399_999) } };
        if (q.status && ['submitted', 'approved', 'rejected'].includes(q.status)) filter.status = q.status;
        const rows: any[] = await this.claims.find(filter).sort({ date: 1 }).limit(5000).lean();
        const names = await this.adminNames(rows.flatMap((r) => [r.adminId, r.decidedBy].filter(Boolean)));
        return { title: 'Claims', subtitle: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)} · PKR`,
          columns: [L('date', 'Date', 10), L('name', 'Name', 22), L('type', 'Type', 9), L('description', 'Description', 30), R('quantity', 'Qty'), R('amount', 'Amount'), L('status', 'Status', 10), L('decidedBy', 'Decided by', 18), L('paidIn', 'Paid in', 9)],
          rows: [...rows.map((r) => ({
            date: new Date(r.date).toISOString().slice(0, 10), name: names.get(r.adminId)?.name ?? r.adminId, type: r.type, description: [r.visitedName, r.description].filter(Boolean).join(' — '),
            quantity: r.quantity, amount: r.amount, status: r.status, decidedBy: r.decidedBy ? names.get(r.decidedBy)?.name ?? '' : '', paidIn: r.payrollMonth ?? '',
          })), { date: 'Total', amount: round2(rows.reduce((s, r) => s + (r.amount || 0), 0)), _bold: 1 }] };
      }
      default:
        throw new BadRequestException('Unknown report. Use register, tax, eobi, incentives or claims.');
    }
  }

  // ── Self-service ("me") ─────────────────────────────────────────────────────
  async mySummary(adminId: string) {
    const p: any = await this.profiles.findOne({ adminId }).lean();
    if (!p) return { hasProfile: false };
    const month = monthOf(new Date());
    const v: any = versionFor<any>(p.versions ?? [], month);
    const mgr = p.managerId ? (await this.adminNames([p.managerId])).get(p.managerId)?.name ?? null : null;
    const advances: any[] = await this.advances.find({ adminId, status: 'approved' }).lean();
    return {
      hasProfile: true, designation: p.designation ?? null, joiningDate: p.joiningDate ?? null, managerName: mgr,
      bankName: p.bankName ?? null, bankAccount: p.bankAccountLast4 ? `••••${p.bankAccountLast4}` : null,
      pay: v ? {
        effectiveFrom: v.effectiveFrom, workerType: v.workerType, baseMonthlySalary: v.baseMonthlySalary, monthlyRetainer: v.monthlyRetainer,
        allowances: v.allowances, incentiveRules: v.incentiveRules, bonusTiers: v.bonusTiers, claimRates: v.claimRates,
        eobiEnabled: v.eobiEnabled, pfEnabled: v.pfEnabled, pfEmployeePct: v.pfEmployeePct, withholdingPct: v.withholdingPct,
      } : null,
      advancesOutstanding: round2(advances.reduce((s, a) => s + (a.amount - (a.recovered ?? 0)), 0)),
    };
  }

  /** This month so far: activity counts and an ESTIMATED payslip (no manual lines; tax is indicative). */
  async myEstimate(adminId: string, now = new Date()) {
    const month = monthOf(now);
    const p: any = await this.profiles.findOne({ adminId }).lean();
    const v: any = p ? versionFor<any>(p.versions ?? [], month) : null;
    const m = (await this.metrics.forMonth(month, [adminId], now)).get(adminId)!;
    if (!p || !v) return { month, hasProfile: false, metrics: m.counts, perf: m.perf };
    const { end } = monthBounds(month);
    const [tax, claimRows, advanceRows, ytd] = await Promise.all([
      this.ensureTaxYear(taxYearOf(month)),
      this.claims.find({ adminId, status: 'approved', payrollRunId: null, date: { $lt: end } }).lean(),
      this.advances.find({ adminId, status: 'approved' }).lean(),
      this.ytd(taxYearOf(month), month, [adminId]),
    ]);
    const slip = buildPayslip({
      month, version: v, joiningDate: p.joiningDate ? new Date(p.joiningDate) : null, exitDate: p.exitDate ? new Date(p.exitDate) : null,
      counts: m.counts, perf: m.perf,
      claims: (claimRows as any[]).map((c) => ({ id: String(c._id), type: c.type, amount: c.amount, taxable: !!c.taxable, label: `${c.type} claim` })),
      advances: (advanceRows as any[]).filter((a) => a.amount - (a.recovered ?? 0) > 0).map((a) => ({ id: String(a._id), outstanding: round2(a.amount - (a.recovered ?? 0)), monthlyRecovery: a.monthlyRecovery ?? 0 })),
      manual: [], ytd: ytd.get(adminId) ?? { taxable: 0, tax: 0 }, tax: { slabs: tax.slabs, surcharge: tax.surcharge ?? null }, eobi: tax.eobi,
    });
    const pendingClaims = await this.claims.countDocuments({ adminId, status: 'submitted' });
    return { month, hasProfile: true, asOf: now.toISOString(), metrics: m.counts, perf: m.perf, estimate: slip, pendingClaims };
  }

  async myPayslips(adminId: string) {
    const runs: any[] = await this.runs.find({ status: { $in: ['approved', 'paid'] }, 'lines.adminId': adminId }).sort({ month: -1 }).limit(36).lean();
    return runs.map((r) => {
      const l = (r.lines ?? []).find((x: any) => x.adminId === adminId && !x.excluded);
      const tax = l ? (l.deductions ?? []).filter((d: any) => d.kind === 'income_tax' || d.kind === 'withholding').reduce((t: number, d: any) => t + (d.amount ?? 0), 0) : 0;
      return l ? { runId: String(r._id), month: r.month, gross: l.gross, totalDeductions: l.totalDeductions, net: l.net, tax: round2(tax), paid: !!l.paid, paidAt: l.paid?.at ?? null } : null;
    }).filter(Boolean);
  }

  /** People whose claims this person reviews (for the "Claims to approve" tab in self-service). */
  async myReports(adminId: string) {
    const ids = await this.reportIds(adminId);
    const pending = ids.length ? await this.claims.countDocuments({ adminId: { $in: ids }, status: 'submitted' }) : 0;
    return { reports: ids.length, pendingClaims: pending };
  }

  /** Activity counts for a month, for the run screen and the profile editor preview. */
  async monthMetrics(month: string, adminId?: string) {
    if (!isMonth(month)) throw new BadRequestException('Choose the month.');
    const ids = adminId ? [adminId] : (await this.profiles.find({ active: true }).select('adminId').lean()).map((p: any) => p.adminId);
    const m = await this.metrics.forMonth(month, ids);
    return [...m].map(([id, x]) => ({ adminId: id, ...x }));
  }
}
