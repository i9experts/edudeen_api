/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { Admin, AdminDocument } from '../admin/admin.schema';
import { encryptSeoCredential, decryptSeoCredential } from '../common/seo-token-encryption.util';
import {
  StaffRole, StaffRoleDocument, StaffInvite, StaffInviteDocument, StaffTask, StaffTaskDocument, StaffAudit, StaffAuditDocument,
  TASK_STATUSES, TASK_PRIORITIES, TASK_LINK_TYPES,
} from './staff.schemas';
import { PERMISSIONS, ROLE_TEMPLATES, effectivePermissions, sanitizePermissions } from './permissions';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.util';

const INVITE_TTL_MS = 48 * 3600_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const keys = () => [process.env.PAYOUT_ENCRYPTION_KEY, process.env.SEO_TOKEN_ENCRYPTION_KEY, process.env.JWT_SECRET].filter((k, i, a): k is string => !!k && a.indexOf(k) === i);
const seal = (plain: string) => encryptSeoCredential(plain, keys()[0]);
export const openSecret = (enc: string): string => {
  for (const k of keys()) { try { return decryptSeoCredential(enc, k); } catch { /* next key */ } }
  throw new Error('undecryptable');
};

/** Pure: why this staff account may not sign in right now (null = fine). Owners are never blocked here. */
export function staffBlockReason(a: { isStaff?: boolean; staffStatus?: string; accessExpiresAt?: Date | null; totpLockedUntil?: Date | null }, now = new Date()): string | null {
  if (!a.isStaff) return null;
  if (a.staffStatus === 'suspended') return 'This staff account is suspended. Contact the owner.';
  if (a.staffStatus === 'invited') return 'Finish setting up your account from the invitation email first.';
  if (a.accessExpiresAt && a.accessExpiresAt.getTime() <= now.getTime()) return 'Your access period has ended. Contact the owner.';
  if (a.totpLockedUntil && a.totpLockedUntil.getTime() > now.getTime()) return 'Too many wrong codes. Try again in a few minutes.';
  return null;
}

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);
  constructor(
    @InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>,
    @InjectModel(StaffRole.name) private readonly roleModel: Model<StaffRoleDocument>,
    @InjectModel(StaffInvite.name) private readonly inviteModel: Model<StaffInviteDocument>,
    @InjectModel(StaffTask.name) private readonly taskModel: Model<StaffTaskDocument>,
    @InjectModel(StaffAudit.name) private readonly auditModel: Model<StaffAuditDocument>,
    private readonly jwt: JwtService,
  ) {}

  // ── Roles ───────────────────────────────────────────────────────────────────
  async ensureTemplates() {
    for (const t of ROLE_TEMPLATES) {
      await this.roleModel.updateOne({ slug: t.slug }, { $setOnInsert: { slug: t.slug, name: t.name, description: t.description, permissions: t.permissions, isSystem: true } }, { upsert: true });
    }
  }
  catalog() { return PERMISSIONS; }
  async listRoles() {
    await this.ensureTemplates();
    const [roles, counts] = await Promise.all([
      this.roleModel.find().sort({ isSystem: -1, name: 1 }).lean(),
      this.adminModel.aggregate([{ $match: { isStaff: true, isDelete: { $ne: true } } }, { $group: { _id: '$staffRoleId', n: { $sum: 1 } } }]),
    ]);
    const n = new Map(counts.map((c: any) => [String(c._id), c.n]));
    return roles.map((r: any) => ({ ...r, memberCount: n.get(String(r._id)) ?? 0 }));
  }
  async saveRole(id: string | null, dto: { name?: string; description?: string; permissions?: string[] }) {
    const permissions = sanitizePermissions(dto.permissions);
    if (!id) {
      if (!dto.name?.trim()) throw new BadRequestException('Role name is required');
      return this.roleModel.create({ name: dto.name.trim(), description: (dto.description ?? '').trim(), permissions, isSystem: false });
    }
    const role = await this.roleModel.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    if (dto.name?.trim()) role.name = dto.name.trim();
    if (dto.description !== undefined) role.description = dto.description.trim();
    if (dto.permissions) role.permissions = permissions;
    await role.save();
    await this.revokeRoleMembers(String(role._id)); // permission change takes effect on their next login
    return role;
  }
  async deleteRole(id: string) {
    const role = await this.roleModel.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new BadRequestException('Built-in roles can be edited but not deleted');
    if (await this.adminModel.exists({ isStaff: true, staffRoleId: id, isDelete: { $ne: true } })) throw new BadRequestException('Move the people in this role to another role first');
    await role.deleteOne();
    return { deleted: true };
  }
  private async revokeRoleMembers(roleId: string) {
    await this.adminModel.updateMany({ isStaff: true, staffRoleId: roleId }, { $inc: { tokenVersion: 1 } });
  }

  // ── Team ────────────────────────────────────────────────────────────────────
  private async view(a: any, roles?: Map<string, any>) {
    const role = a.staffRoleId ? (roles?.get(String(a.staffRoleId)) ?? (await this.roleModel.findById(a.staffRoleId).lean())) : null;
    return {
      _id: String(a._id), name: a.name, email: a.email, profileImage: a.profileImage ?? null, isStaff: !!a.isStaff,
      isOwner: !a.isStaff, staffStatus: a.isStaff ? a.staffStatus : 'active', staffRoleId: a.staffRoleId ?? null, roleName: role?.name ?? (a.isStaff ? '—' : 'Owner'),
      permissionsAdd: a.permissionsAdd ?? [], permissionsRemove: a.permissionsRemove ?? [],
      permissions: a.isStaff ? effectivePermissions(role?.permissions, a.permissionsAdd, a.permissionsRemove) : ['*'],
      accessExpiresAt: a.accessExpiresAt ?? null, totpEnabled: !!a.totpEnabled, lastLoginAt: a.lastLoginAt ?? null, lastLoginIp: a.lastLoginIp ?? null, createdAt: a.createdAt,
    };
  }
  async list() {
    const [admins, roles] = await Promise.all([this.adminModel.find({ isDelete: { $ne: true } }).sort({ isStaff: 1, createdAt: 1 }).lean(), this.roleModel.find().lean()]);
    const map = new Map(roles.map((r: any) => [String(r._id), r]));
    return Promise.all(admins.map((a) => this.view(a, map)));
  }
  async me(adminId: string) {
    const a = await this.adminModel.findById(adminId).lean();
    if (!a) throw new NotFoundException('Account not found');
    return this.view(a);
  }

  async invite(ownerId: string, dto: { email: string; name?: string; roleId: string; permissionsAdd?: string[]; permissionsRemove?: string[]; accessExpiresAt?: string | null }) {
    const email = String(dto.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('A valid email is required');
    const role = await this.roleModel.findById(dto.roleId);
    if (!role) throw new BadRequestException('Choose a role');
    if (await this.adminModel.exists({ email })) throw new BadRequestException('Someone with this email already has an admin account');
    const exp = dto.accessExpiresAt ? new Date(dto.accessExpiresAt) : null;
    if (exp && (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now())) throw new BadRequestException('The access end date must be in the future');
    const staff = await this.adminModel.create({
      name: dto.name?.trim() || email.split('@')[0], email, role: 'admin', isVerified: true, password: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
      isStaff: true, staffStatus: 'invited', staffRoleId: String(role._id), permissionsAdd: sanitizePermissions(dto.permissionsAdd), permissionsRemove: sanitizePermissions(dto.permissionsRemove),
      accessExpiresAt: exp, invitedById: ownerId,
    });
    return { staff: await this.view(staff.toObject()), ...(await this.issueInvite(String(staff._id))) };
  }
  private async issueInvite(adminId: string) {
    await this.inviteModel.deleteMany({ adminId });
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.inviteModel.create({ adminId, tokenHash: sha(token), expiresAt });
    return { inviteToken: token, expiresAt };
  }
  async resendInvite(id: string) {
    const a = await this.mustStaff(id);
    if (a.staffStatus !== 'invited') throw new BadRequestException('This person already finished setup');
    return this.issueInvite(id);
  }
  private async mustStaff(id: string) {
    const a = await this.adminModel.findById(id);
    if (!a) throw new NotFoundException('Staff member not found');
    if (!a.isStaff) throw new ForbiddenException('The owner account cannot be changed here');
    return a;
  }
  async update(id: string, dto: { name?: string; roleId?: string; permissionsAdd?: string[]; permissionsRemove?: string[]; accessExpiresAt?: string | null }) {
    const a = await this.mustStaff(id);
    if (dto.name?.trim()) a.name = dto.name.trim();
    if (dto.roleId) { if (!(await this.roleModel.exists({ _id: dto.roleId }))) throw new BadRequestException('Role not found'); a.staffRoleId = dto.roleId; }
    if (dto.permissionsAdd) a.permissionsAdd = sanitizePermissions(dto.permissionsAdd);
    if (dto.permissionsRemove) a.permissionsRemove = sanitizePermissions(dto.permissionsRemove);
    if (dto.accessExpiresAt !== undefined) a.accessExpiresAt = dto.accessExpiresAt ? new Date(dto.accessExpiresAt) : null;
    a.tokenVersion = (a.tokenVersion ?? 0) + 1; // new rights apply on the next sign-in
    await a.save();
    return this.view(a.toObject());
  }
  async setSuspended(id: string, suspended: boolean) {
    const a = await this.mustStaff(id);
    if (a.staffStatus === 'invited' && !suspended) throw new BadRequestException('This person has not accepted the invitation yet');
    a.staffStatus = suspended ? 'suspended' : 'active';
    a.status = suspended ? 'suspended' : 'active';
    a.tokenVersion = (a.tokenVersion ?? 0) + 1; // every open session dies immediately
    await a.save();
    return this.view(a.toObject());
  }
  async reset2fa(id: string) {
    const a = await this.mustStaff(id);
    a.totpEnabled = false; a.totpSecretEnc = null; a.recoveryHashes = []; a.staffStatus = 'invited'; a.tokenVersion = (a.tokenVersion ?? 0) + 1;
    await a.save();
    return { ...(await this.issueInvite(id)), staff: await this.view(a.toObject()) };
  }
  async remove(id: string) {
    const a = await this.mustStaff(id);
    a.isDelete = true; a.status = 'deleted'; a.staffStatus = 'suspended'; a.tokenVersion = (a.tokenVersion ?? 0) + 1;
    a.email = `removed+${a._id}@removed.invalid`;
    await a.save();
    await this.inviteModel.deleteMany({ adminId: id });
    await this.taskModel.updateMany({ assigneeId: id, status: { $ne: 'done' } }, { $set: { status: 'blocked' } });
    return { removed: true };
  }

  // ── Invitation + two-factor setup (public, token-based) ──────────────────────
  private async inviteByToken(token: string) {
    const inv = await this.inviteModel.findOne({ tokenHash: sha(String(token ?? '')) });
    if (!inv || inv.usedAt || inv.expiresAt.getTime() < Date.now()) throw new BadRequestException('This invitation link is invalid or has expired. Ask the owner for a new one.');
    const a = await this.adminModel.findById(inv.adminId);
    if (!a || !a.isStaff || a.isDelete) throw new BadRequestException('This invitation is no longer valid.');
    return { inv, a };
  }
  async inviteInfo(token: string) {
    const { a } = await this.inviteByToken(token);
    return { email: a.email, name: a.name };
  }
  async acceptInvite(token: string, dto: { password: string; name?: string }) {
    const { a } = await this.inviteByToken(token);
    const pw = String(dto.password ?? '');
    if (pw.length < 10 || pw.length > 72 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new BadRequestException('Use 10–72 characters with letters and numbers.');
    a.password = await bcrypt.hash(pw, 12);
    if (dto.name?.trim()) a.name = dto.name.trim();
    const secret = newTotpSecret();
    a.totpSecretEnc = seal(secret); a.totpEnabled = false;
    await a.save();
    return { secret, otpauthUrl: otpauthUrl(secret, a.email) };
  }
  async activate2fa(token: string, code: string) {
    const { inv, a } = await this.inviteByToken(token);
    if (!a.totpSecretEnc) throw new BadRequestException('Set a password first');
    if (!verifyTotp(openSecret(a.totpSecretEnc), code)) throw new BadRequestException('That code is not right. Check the time on your phone and try again.');
    const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    a.recoveryHashes = recovery.map(sha);
    a.totpEnabled = true; a.staffStatus = 'active'; a.status = 'active';
    await a.save();
    inv.usedAt = new Date(); await inv.save();
    return { recoveryCodes: recovery };
  }

  /** Called by the login flow for staff after the password matched. Throws if the sign-in must not continue. */
  async gateLogin(a: AdminDocument, totp: string | undefined, ip?: string) {
    const blocked = staffBlockReason(a as any);
    if (blocked) throw new UnauthorizedException(blocked);
    if (!a.totpEnabled || !a.totpSecretEnc) throw new UnauthorizedException('Finish two-factor setup from your invitation email first.');
    if (!totp) throw new UnauthorizedException({ message: 'Enter the 6-digit code from your authenticator app.', code: 'TOTP_REQUIRED' });
    const clean = String(totp).trim();
    let ok = verifyTotp(openSecret(a.totpSecretEnc), clean);
    if (!ok && /^[a-f0-9]{10}$/i.test(clean)) { // one-time recovery code
      const h = sha(clean.toLowerCase());
      if (a.recoveryHashes.includes(h)) { a.recoveryHashes = a.recoveryHashes.filter((x) => x !== h); ok = true; }
    }
    if (!ok) {
      a.totpFailures = (a.totpFailures ?? 0) + 1;
      if (a.totpFailures >= 5) { a.totpLockedUntil = new Date(Date.now() + 15 * 60_000); a.totpFailures = 0; }
      await a.save();
      throw new UnauthorizedException({ message: 'Wrong code.', code: 'TOTP_INVALID' });
    }
    a.totpFailures = 0; a.totpLockedUntil = null; a.lastLoginAt = new Date(); a.lastLoginIp = ip ?? null;
    await a.save();
  }

  // ── Access info for the middleware (cached by the caller) ───────────────────
  async accessFor(adminId: string): Promise<{ isStaff: boolean; blocked: string | null; permissions: Set<string>; name: string; tokenVersion: number } | null> {
    const a: any = await this.adminModel.findById(adminId).lean();
    if (!a || a.isDelete) return null;
    if (!a.isStaff) return { isStaff: false, blocked: null, permissions: new Set(), name: a.name, tokenVersion: a.tokenVersion ?? 0 };
    const role: any = a.staffRoleId ? await this.roleModel.findById(a.staffRoleId).lean() : null;
    return { isStaff: true, blocked: staffBlockReason(a), permissions: new Set(effectivePermissions(role?.permissions, a.permissionsAdd, a.permissionsRemove)), name: a.name, tokenVersion: a.tokenVersion ?? 0 };
  }
  verifyToken(token: string): any | null { try { return this.jwt.verify(token); } catch { return null; } }
  async audit(row: { adminId: string; name?: string; method: string; path: string; status: number; ip?: string; denied?: string | null }) {
    try { await this.auditModel.create(row); } catch (e: any) { this.logger.warn(`audit write failed: ${e?.message}`); }
  }
  async auditList(adminId: string | undefined, limit = 100) {
    return this.auditModel.find(adminId ? { adminId } : {}).sort({ at: -1 }).limit(Math.min(300, Math.max(1, limit))).lean();
  }

  // ── Tasks (Collaboration) ───────────────────────────────────────────────────
  private async names(ids: string[]) {
    const docs = await this.adminModel.find({ _id: { $in: [...new Set(ids)] } }).select('name email').lean();
    return new Map(docs.map((d: any) => [String(d._id), d.name || d.email]));
  }
  async listTasks(me: { id: string; canAssign: boolean }, scope: 'mine' | 'all', status?: string) {
    const filter: any = scope === 'all' && me.canAssign ? {} : { assigneeId: me.id };
    if (status && (TASK_STATUSES as readonly string[]).includes(status)) filter.status = status;
    const tasks = await this.taskModel.find(filter).sort({ status: 1, dueAt: 1, createdAt: -1 }).limit(300).lean();
    const names = await this.names(tasks.flatMap((t: any) => [t.assigneeId, t.createdById]));
    return tasks.map((t: any) => ({ ...t, assigneeName: names.get(t.assigneeId) ?? 'Removed', createdByName: names.get(t.createdById) ?? '—' }));
  }
  async createTask(me: { id: string; canAssign: boolean }, dto: any) {
    if (!me.canAssign) throw new ForbiddenException('You cannot assign tasks');
    if (!dto.title?.trim()) throw new BadRequestException('A title is required');
    const assignee = await this.adminModel.findOne({ _id: dto.assigneeId, isDelete: { $ne: true } }).select('_id isStaff staffStatus');
    if (!assignee) throw new BadRequestException('Choose who this is for');
    if (assignee.isStaff && assignee.staffStatus === 'suspended') throw new BadRequestException('That person is suspended');
    const link = dto.link && (TASK_LINK_TYPES as readonly string[]).includes(dto.link.type) && dto.link.id ? { type: dto.link.type, id: String(dto.link.id).slice(0, 80), label: String(dto.link.label ?? '').slice(0, 120) } : null;
    return this.taskModel.create({
      title: dto.title.trim(), description: String(dto.description ?? '').slice(0, 2000), assigneeId: String(assignee._id), createdById: me.id,
      priority: (TASK_PRIORITIES as readonly string[]).includes(dto.priority) ? dto.priority : 'normal', dueAt: dto.dueAt ? new Date(dto.dueAt) : null, link,
    });
  }
  async updateTask(me: { id: string; canAssign: boolean }, id: string, dto: any) {
    const t = await this.taskModel.findById(id);
    if (!t) throw new NotFoundException('Task not found');
    const mine = t.assigneeId === me.id;
    if (!mine && !me.canAssign) throw new ForbiddenException('This task is not yours');
    if (dto.status && (TASK_STATUSES as readonly string[]).includes(dto.status)) { t.status = dto.status; t.completedAt = dto.status === 'done' ? new Date() : null; }
    if (me.canAssign) {
      if (dto.title?.trim()) t.title = dto.title.trim();
      if (dto.description !== undefined) t.description = String(dto.description).slice(0, 2000);
      if ((TASK_PRIORITIES as readonly string[]).includes(dto.priority)) t.priority = dto.priority;
      if (dto.dueAt !== undefined) t.dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
      if (dto.assigneeId && dto.assigneeId !== t.assigneeId && (await this.adminModel.exists({ _id: dto.assigneeId, isDelete: { $ne: true } }))) t.assigneeId = String(dto.assigneeId);
    }
    await t.save();
    return t;
  }
  async commentTask(me: { id: string; canAssign: boolean; name: string }, id: string, text: string) {
    const t = await this.taskModel.findById(id);
    if (!t) throw new NotFoundException('Task not found');
    if (t.assigneeId !== me.id && !me.canAssign) throw new ForbiddenException('This task is not yours');
    if (!text?.trim()) throw new BadRequestException('Write a comment first');
    t.comments.push({ authorId: me.id, authorName: me.name, text: text.trim().slice(0, 1000) } as any);
    await t.save();
    return t;
  }
  async deleteTask(me: { canAssign: boolean }, id: string) {
    if (!me.canAssign) throw new ForbiddenException('You cannot delete tasks');
    await this.taskModel.deleteOne({ _id: id });
    return { deleted: true };
  }
}
