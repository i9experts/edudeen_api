/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { Admin, AdminDocument } from '../admin/admin.schema';
import { Payout, PayoutDocument, ManualPaymentProof, ManualPaymentProofDocument } from '../database/schema';
import { StaffNote, StaffNoteDocument, StaffApproval, StaffApprovalDocument, StaffSettings, StaffSettingsDocument, NOTE_ENTITY_TYPES } from './staff.schemas';
import { APPROVAL_ROUTES, APPROVAL_TTL_MS, REQUIRED_APPROVAL_KEYS, approvalRouteFor, isBelowThreshold } from './approvals';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.util';
import { openSecret, seal } from './staff.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Me = { id: string; name: string; isOwner: boolean; permissions: string[] };
const can = (me: Me, perm: string) => me.isOwner || me.permissions.includes(perm);

/** Which "view" right lets someone read/write notes about each kind of record. */
const NOTE_PERMISSION: Record<string, string> = { user: 'users.view', seller: 'users.view', store: 'marketplace.view', order: 'orders.view', listing: 'marketplace.view' };

@Injectable()
export class StaffExtrasService {
  constructor(
    @InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>,
    @InjectModel(StaffNote.name) private readonly noteModel: Model<StaffNoteDocument>,
    @InjectModel(StaffApproval.name) private readonly approvalModel: Model<StaffApprovalDocument>,
    @InjectModel(StaffSettings.name) private readonly settingsModel: Model<StaffSettingsDocument>,
    @InjectModel(Payout.name) private readonly payoutModel: Model<PayoutDocument>,
    @InjectModel(ManualPaymentProof.name) private readonly proofModel: Model<ManualPaymentProofDocument>,
  ) {}

  // ── Notes ───────────────────────────────────────────────────────────────────
  private noteGuard(me: Me, entityType: string) {
    if (!(NOTE_ENTITY_TYPES as readonly string[]).includes(entityType)) throw new BadRequestException('Unknown record type');
    if (!can(me, NOTE_PERMISSION[entityType])) throw new ForbiddenException('You cannot see notes for this kind of record');
  }
  async listNotes(me: Me, entityType: string, entityId: string) {
    this.noteGuard(me, entityType);
    if (!entityId) throw new BadRequestException('entityId is required');
    return this.noteModel.find({ entityType, entityId: String(entityId).slice(0, 80) }).sort({ createdAt: -1 }).limit(100).lean();
  }
  async addNote(me: Me, entityType: string, entityId: string, text: string) {
    this.noteGuard(me, entityType);
    const t = String(text ?? '').trim();
    if (!entityId || !t) throw new BadRequestException('Write a note first');
    return this.noteModel.create({ entityType, entityId: String(entityId).slice(0, 80), text: t.slice(0, 1000), authorId: me.id, authorName: me.name });
  }
  async deleteNote(me: Me, id: string) {
    const n = await this.noteModel.findById(id);
    if (!n) throw new NotFoundException('Note not found');
    if (n.authorId !== me.id && !me.isOwner) throw new ForbiddenException('Only the author or the owner can delete a note');
    await n.deleteOne();
    return { deleted: true };
  }

  // ── Safety settings (owner) ─────────────────────────────────────────────────
  async getSettings() {
    const s = (await this.settingsModel.findOne().lean()) ?? { approvalsEnabled: true, approvalKinds: APPROVAL_ROUTES.map((r) => r.key) };
    return { approvalsEnabled: s.approvalsEnabled !== false, approvalKinds: [...new Set([...(s.approvalKinds ?? []), ...REQUIRED_APPROVAL_KEYS])], approvalThresholdUSD: (s as any).approvalThresholdUSD ?? 0, approvalThresholdPKR: (s as any).approvalThresholdPKR ?? 0, available: APPROVAL_ROUTES.map((r) => ({ key: r.key, label: r.label })) };
  }
  async saveSettings(dto: { approvalsEnabled?: boolean; approvalKinds?: string[]; approvalThresholdUSD?: number; approvalThresholdPKR?: number }) {
    const known = new Set(APPROVAL_ROUTES.map((r) => r.key));
    const set: any = {};
    if (typeof dto.approvalsEnabled === 'boolean') set.approvalsEnabled = dto.approvalsEnabled;
    if (Array.isArray(dto.approvalKinds)) set.approvalKinds = [...new Set([...dto.approvalKinds.filter((k) => known.has(k)), ...REQUIRED_APPROVAL_KEYS])];
    for (const k of ['approvalThresholdUSD', 'approvalThresholdPKR'] as const) {
      const v = (dto as any)[k];
      if (v !== undefined) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9) throw new BadRequestException('Limits must be a number of 0 or more'); set[k] = Math.round(v * 100) / 100; }
    }
    await this.settingsModel.updateOne({}, { $set: set }, { upsert: true });
    return this.getSettings();
  }

  // ── Approvals ───────────────────────────────────────────────────────────────
  /**
   * Called for every state-changing request a STAFF member makes.
   * Returns 'proceed' (not an approval action, switched off, or a granted approval was just used)
   * or the pending request the caller must wait on.
   */
  async approvalGate(adminId: string, name: string, method: string, path: string): Promise<'proceed' | { requestId: string; label: string; created: boolean }> {
    const route = approvalRouteFor(method, path);
    if (!route) return 'proceed';
    const s = await this.getSettings();
    if (!s.approvalsEnabled || !s.approvalKinds.includes(route.key)) return 'proceed';
    // Small amounts the owner chose not to hold (never refunds: their amount isn't known until approved).
    if (await this.underLimit(route.key, path, s)) return 'proceed';
    const now = new Date();
    // A granted approval for exactly this action is consumed once.
    const granted = await this.approvalModel.findOneAndUpdate(
      { requestedById: adminId, method: method.toUpperCase(), path, status: 'approved', expiresAt: { $gt: now } },
      { $set: { status: 'used', usedAt: now } },
    );
    if (granted) return 'proceed';
    const existing = await this.approvalModel.findOne({ requestedById: adminId, method: method.toUpperCase(), path, status: 'pending' });
    if (existing) return { requestId: String(existing._id), label: route.label, created: false };
    const created = await this.approvalModel.create({ requestedById: adminId, requestedByName: name, kind: route.key, label: route.label, method: method.toUpperCase(), path });
    return { requestId: String(created._id), label: route.label, created: true };
  }
  private async underLimit(kind: string, path: string, s: { approvalThresholdUSD: number; approvalThresholdPKR: number }): Promise<boolean> {
    if (!(s.approvalThresholdUSD > 0 || s.approvalThresholdPKR > 0)) return false;
    const id = path.match(/\/([a-f0-9]{24})\//i)?.[1];
    if (!id) return false;
    try {
      const t = { usd: s.approvalThresholdUSD, pkr: s.approvalThresholdPKR };
      if (kind === 'payout' || kind === 'payout_retry') { const p: any = await this.payoutModel.findById(id).select('amount currency').lean(); return !!p && isBelowThreshold(p.amount, p.currency, t); }
      if (kind === 'payment_proof') { const p: any = await this.proofModel.findById(id).select('amountUSD amountPKR').lean(); return !!p && (isBelowThreshold(p.amountUSD, 'USD', t) && s.approvalThresholdUSD > 0 || (!(s.approvalThresholdUSD > 0) && isBelowThreshold(p.amountPKR, 'PKR', t))); }
    } catch { /* unknown -> hold */ }
    return false;
  }

  async listApprovals(me: Me, status?: string) {
    const filter: any = can(me, 'approvals.decide') ? {} : { requestedById: me.id };
    if (status) filter.status = status;
    await this.approvalModel.updateMany({ status: 'approved', expiresAt: { $lte: new Date() } }, { $set: { status: 'expired' } });
    return this.approvalModel.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  }
  async pendingApprovalCount(me: Me) {
    return can(me, 'approvals.decide') ? this.approvalModel.countDocuments({ status: 'pending', requestedById: { $ne: me.id } }) : 0;
  }
  async decide(me: Me, id: string, approve: boolean, note?: string) {
    if (!can(me, 'approvals.decide')) throw new ForbiddenException('You cannot decide approvals');
    const a = await this.approvalModel.findById(id);
    if (!a) throw new NotFoundException('Request not found');
    if (a.requestedById === me.id) throw new ForbiddenException('You cannot approve your own request — another person must');
    if (a.status !== 'pending') throw new BadRequestException(`This request is already ${a.status}`);
    a.status = approve ? 'approved' : 'rejected';
    a.decidedById = me.id; a.decidedByName = me.name; a.decidedAt = new Date(); a.decisionNote = String(note ?? '').slice(0, 300);
    a.expiresAt = approve ? new Date(Date.now() + APPROVAL_TTL_MS) : null;
    await a.save();
    return a;
  }

  // ── Own two-step sign-in (optional for the owner; mandatory for staff, set up via the invite) ──
  async setup2fa(adminId: string) {
    const a = await this.adminModel.findById(adminId);
    if (!a) throw new NotFoundException('Account not found');
    if (a.totpEnabled) throw new BadRequestException('Two-step sign-in is already on');
    const secret = newTotpSecret();
    a.totpSecretEnc = seal(secret);
    await a.save();
    return { secret, otpauthUrl: otpauthUrl(secret, a.email) };
  }
  async enable2fa(adminId: string, code: string) {
    const a = await this.adminModel.findById(adminId);
    if (!a?.totpSecretEnc) throw new BadRequestException('Start the setup first');
    if (!verifyTotp(openSecret(a.totpSecretEnc), code)) throw new BadRequestException('That code is not right. Check the clock on your phone and try again.');
    const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    a.recoveryHashes = recovery.map(sha); a.totpEnabled = true;
    await a.save();
    return { recoveryCodes: recovery };
  }
  async disable2fa(adminId: string, code: string) {
    const a = await this.adminModel.findById(adminId);
    if (!a) throw new NotFoundException('Account not found');
    if (a.isStaff) throw new ForbiddenException('Staff accounts must keep two-step sign-in on');
    if (!a.totpEnabled || !a.totpSecretEnc) throw new BadRequestException('Two-step sign-in is not on');
    if (!verifyTotp(openSecret(a.totpSecretEnc), code)) throw new BadRequestException('Wrong code');
    a.totpEnabled = false; a.totpSecretEnc = null; a.recoveryHashes = [];
    await a.save();
    return { disabled: true };
  }
}
