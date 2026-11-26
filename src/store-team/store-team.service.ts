/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { AuthService } from '../auth/auth.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { EmailService } from '../otp/services/email.service';
import { RedisService } from '../redis/redis.service';
import { StoreMember, StoreMemberDocument } from './store-member.schema';
import { effectiveStorePermissions, roleTemplate, sanitizeStorePermissions, STORE_PERMISSIONS, STORE_ROLE_TEMPLATES } from './permissions';
import type { MemberAccess } from './member-access.middleware';
import type { InviteMemberDto, UpdateMemberDto } from './dto/store-team.dto';

export const MAX_STORE_MEMBERS = 5;
const INVITE_TTL_MS = 48 * 3600_000;
const ACCESS_CACHE_MS = 30_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[ch]);
const lower = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();
const maskEmail = (e: string) => { const [u, d] = e.split('@'); return `${(u ?? '').slice(0, 1)}***@${d ?? ''}`; };

export interface Caller { userId: string; email?: string; role?: string; actAs?: string }

/** Shared "something changed in some store team" marker: every API server compares it on each request, so a suspend / remove /
 *  rights change reaches the other servers at once instead of after the 30 s cache. Without Redis the 30 s cache is the limit. */
const REV_KEY = 'store-team:rev';

@Injectable()
export class StoreTeamService {
  private readonly logger = new Logger(StoreTeamService.name);
  private readonly cache = new Map<string, { at: number; rev: string | null; v: MemberAccess }>();

  constructor(
    @InjectModel(StoreMember.name) private readonly members: Model<StoreMemberDocument>,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly activity: ActivityLogService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /** Called after every team change: drop this server's cache and tell the other servers (new revision in Redis). */
  private async bump() {
    this.cache.clear();
    try { await this.redis?.set(REV_KEY, `${Date.now()}-${randomBytes(4).toString('hex')}`, 86_400); } catch { /* the 30 s cache still ends it */ }
  }

  private async currentRev(): Promise<string | null> {
    try { return this.redis?.isConnected ? await this.redis.get(REV_KEY) : null; } catch { return null; }
  }

  catalog() { return { permissions: STORE_PERMISSIONS, roles: STORE_ROLE_TEMPLATES, max: MAX_STORE_MEMBERS }; }

  // ── helpers ────────────────────────────────────────────────────────────────
  /** Owner only: the seller who owns the store, with a REAL seller session (never a member or admin manage token). */
  private async assertOwner(caller: Caller, storeId: string) {
    if (caller.actAs) throw new ForbiddenException('Team management is for the store owner only.');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, sellerId: caller.userId, isDelete: false }).select('name slug sellerId status').lean();
    if (!store) throw new ForbiddenException('You do not own this store');
    return store;
  }

  private view(m: any) {
    return {
      id: String(m._id), email: m.email, name: m.name || '', roleKey: m.roleKey, roleName: roleTemplate(m.roleKey)?.name ?? m.roleKey,
      permissionsAdd: m.permissionsAdd ?? [], permissionsRemove: m.permissionsRemove ?? [],
      permissions: Array.from(effectiveStorePermissions(m.roleKey, m.permissionsAdd, m.permissionsRemove)),
      status: m.status, accessExpiresAt: m.accessExpiresAt ?? null, acceptedAt: m.acceptedAt ?? null,
      inviteExpiresAt: m.status === 'invited' ? m.inviteExpiresAt ?? null : null, createdAt: m.createdAt ?? null,
    };
  }

  private async audit(storeId: string, action: string, description: string, actor: { id?: string; name?: string | null; role: string }, extra: object = {}) {
    const ok = await this.activity.log({
      storeId, category: 'security', action, description,
      actorId: actor.id ?? null, actorName: actor.name ?? null, actorRole: actor.role, targetId: storeId, targetType: 'store', metadata: extra,
    });
    if (!ok) this.logger.error(`audit entry ${action} for store ${storeId} was not stored`);
    return ok;
  }

  private parseEnd(v: string | null | undefined): Date | null {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw new BadRequestException('The end date must be in the future');
    return d;
  }

  // ── owner API ──────────────────────────────────────────────────────────────
  async list(caller: Caller, storeId: string) {
    await this.assertOwner(caller, storeId);
    const rows = await this.members.find({ storeId, status: { $ne: 'removed' } }).sort({ createdAt: 1 }).lean();
    return { members: rows.map((r) => this.view(r)), ...this.catalog() };
  }

  async invite(caller: Caller, storeId: string, dto: InviteMemberDto) {
    const store = await this.assertOwner(caller, storeId);
    const email = lower(dto.email);
    const seller: any = await this.db.repositories.sellerModel.findById(caller.userId).select('email name').lean();
    if (lower(seller?.email) === email) throw new BadRequestException('That is your own e-mail. You already own this store.');
    const end = this.parseEnd(dto.accessExpiresAt);

    const live = await this.members.countDocuments({ storeId, status: { $ne: 'removed' } });
    const existing: any = await this.members.findOne({ storeId, email });
    if (existing && existing.status !== 'removed') throw new ConflictException('This person is already on your team');
    if (live >= MAX_STORE_MEMBERS) throw new BadRequestException(`A store can have at most ${MAX_STORE_MEMBERS} team members`);

    const token = randomBytes(32).toString('hex');
    const patch = {
      storeId, email, userId: null, name: (dto.name ?? '').trim().slice(0, 80), roleKey: dto.roleKey,
      permissionsAdd: sanitizeStorePermissions(dto.permissionsAdd), permissionsRemove: sanitizeStorePermissions(dto.permissionsRemove),
      status: 'invited' as const, invitedBy: caller.userId, inviteTokenHash: sha(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      accessExpiresAt: end, acceptedAt: null,
    };
    const row: any = existing ? Object.assign(existing, patch) : new this.members(patch);
    await row.save();
    // Re-check the cap after the insert: two parallel invites cannot make a 6th member (oldest keep their place).
    const all = await this.members.find({ storeId, status: { $ne: 'removed' } }).sort({ _id: 1 }).select('_id').lean();
    if (all.length > MAX_STORE_MEMBERS && all.slice(MAX_STORE_MEMBERS).some((a) => String(a._id) === String(row._id))) {
      await this.members.deleteOne({ _id: row._id });
      throw new BadRequestException(`A store can have at most ${MAX_STORE_MEMBERS} team members`);
    }
    await this.bump();
    await this.audit(storeId, 'store_member_invited', `Invited ${email} as ${roleTemplate(dto.roleKey)?.name}`, { id: caller.userId, role: 'seller' }, { email, roleKey: dto.roleKey });
    const emailSent = await this.sendInvite(email, row.name, store.name, roleTemplate(dto.roleKey)?.name ?? dto.roleKey, token, patch.inviteExpiresAt);
    return { member: this.view(row.toObject()), emailSent };
  }

  async resend(caller: Caller, storeId: string, memberId: string) {
    const store = await this.assertOwner(caller, storeId);
    const row: any = await this.members.findOne({ _id: memberId, storeId, status: 'invited' });
    if (!row) throw new NotFoundException('No pending invitation found');
    const token = randomBytes(32).toString('hex');
    row.inviteTokenHash = sha(token); row.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await row.save();
    const emailSent = await this.sendInvite(row.email, row.name, store.name, roleTemplate(row.roleKey)?.name ?? row.roleKey, token, row.inviteExpiresAt);
    return { member: this.view(row.toObject()), emailSent };
  }

  async update(caller: Caller, storeId: string, memberId: string, dto: UpdateMemberDto) {
    await this.assertOwner(caller, storeId);
    const row: any = await this.members.findOne({ _id: memberId, storeId, status: { $ne: 'removed' } });
    if (!row) throw new NotFoundException('Team member not found');
    if (dto.name !== undefined) row.name = dto.name.trim().slice(0, 80);
    if (dto.roleKey) row.roleKey = dto.roleKey;
    if (dto.permissionsAdd) row.permissionsAdd = sanitizeStorePermissions(dto.permissionsAdd);
    if (dto.permissionsRemove) row.permissionsRemove = sanitizeStorePermissions(dto.permissionsRemove);
    if (dto.accessExpiresAt !== undefined) row.accessExpiresAt = this.parseEnd(dto.accessExpiresAt);
    await row.save();
    await this.bump();
    await this.audit(storeId, 'store_member_changed', `Changed access of ${row.email} (${roleTemplate(row.roleKey)?.name})`, { id: caller.userId, role: 'seller' }, { email: row.email, roleKey: row.roleKey });
    return { member: this.view(row.toObject()) };
  }

  /** active <-> suspended. A pending invitation cannot be suspended (remove it instead). */
  async setSuspended(caller: Caller, storeId: string, memberId: string, suspend: boolean) {
    await this.assertOwner(caller, storeId);
    const from = suspend ? 'active' : 'suspended';
    const row: any = await this.members.findOneAndUpdate({ _id: memberId, storeId, status: from }, { $set: { status: suspend ? 'suspended' : 'active' } }, { new: true });
    if (!row) throw new BadRequestException(suspend ? 'Only an active member can be suspended' : 'Only a suspended member can be resumed');
    await this.bump();
    await this.audit(storeId, suspend ? 'store_member_suspended' : 'store_member_resumed', `${suspend ? 'Suspended' : 'Resumed'} ${row.email}`, { id: caller.userId, role: 'seller' }, { email: row.email });
    return { member: this.view(row.toObject()) };
  }

  async remove(caller: Caller, storeId: string, memberId: string) {
    await this.assertOwner(caller, storeId);
    const row = await this.removeRow(storeId, memberId);
    await this.audit(storeId, 'store_member_removed', `Removed ${row.email} from the team`, { id: caller.userId, role: 'seller' }, { email: row.email });
    return { success: true };
  }

  private async removeRow(storeId: string, memberId: string): Promise<any> {
    const row: any = await this.members.findOneAndUpdate({ _id: memberId, storeId, status: { $ne: 'removed' } }, { $set: { status: 'removed', inviteTokenHash: null, inviteExpiresAt: null } }, { new: true });
    if (!row) throw new NotFoundException('Team member not found');
    await this.bump();
    return row;
  }

  async activityFor(caller: Caller, storeId: string) {
    await this.assertOwner(caller, storeId);
    const rows = await this.db.repositories.activityLogModel
      .find({ storeId, $or: [{ action: /^store_member_/ }, { 'metadata.actAs': 'collaborator' }] })
      .sort({ createdAt: -1 }).limit(50).select('action description actorName actorRole createdAt metadata.email metadata.role').lean();
    return { items: rows };
  }

  // ── invitee API ────────────────────────────────────────────────────────────
  async inviteInfo(token: string) {
    const row: any = await this.members.findOne({ inviteTokenHash: sha(String(token)), status: 'invited', inviteExpiresAt: { $gt: new Date() } }).lean();
    if (!row) throw new NotFoundException('This invitation is not valid any more');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: row.storeId, isDelete: false }).select('name').lean();
    if (!store) throw new NotFoundException('This invitation is not valid any more');
    // The page needs to know which form to show: set a password (no account yet) or use the existing password. Only the
    // holder of the e-mailed token can ask, and only these two booleans are revealed.
    const acc = await this.findAccountByEmail(row.email);
    return {
      storeName: store.name, roleName: roleTemplate(row.roleKey)?.name ?? row.roleKey, emailHint: maskEmail(row.email), expiresAt: row.inviteExpiresAt,
      hasAccount: !!acc, hasPassword: !!acc?.password, accountVerified: acc ? acc.isVerified === true : null,
    };
  }

  /** Existing Edudeen account with this e-mail (buyer first, then seller), matched case-insensitively. */
  private async findAccountByEmail(email: string): Promise<any | null> {
    const re = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const { userModel, sellerModel } = this.db.repositories;
    const buyer: any = await userModel.findOne({ email: re, isDelete: { $ne: true } });
    if (buyer) return buyer;
    return (await sellerModel.findOne({ email: re, isDelete: { $ne: true } })) ?? null;
  }

  private async loadInvite(token: string) {
    const hash = sha(String(token));
    const row: any = await this.members.findOne({ inviteTokenHash: hash, status: 'invited', inviteExpiresAt: { $gt: new Date() } }).lean();
    if (!row) throw new NotFoundException('This invitation is not valid any more');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: row.storeId, isDelete: false }).select('name sellerId status').lean();
    if (!store || store.status === 'suspended' || store.status === 'rejected') throw new NotFoundException('This invitation is not valid any more');
    return { row, store, hash };
  }

  /** Single use: the signed-in account must have the SAME e-mail the invitation was sent to. */
  async accept(caller: Caller, token: string) {
    if (caller.actAs) throw new ForbiddenException('Not available in this session');
    const { row, store, hash } = await this.loadInvite(token);
    if (lower(caller.email) !== row.email) throw new ForbiddenException(`This invitation was sent to ${maskEmail(row.email)}. Sign in with that e-mail address.`);
    return this.finalizeAccept(row, store, hash, caller.userId);
  }

  private static readonly INVITE_FAIL_LIMIT = 5;
  private static readonly INVITE_FAIL_TTL = 15 * 60;

  /**
   * No account yet: the invitation e-mail proves the mailbox, so the person just chooses a password here. Creates a normal
   * buyer account (verified, same e-mail), joins the team in the same step and signs them in.
   */
  async acceptWithNewPassword(token: string, password: string, nameInput?: string) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) throw new BadRequestException('Password must be between 8 and 72 characters');
    const { row, store, hash } = await this.loadInvite(token);
    if (await this.findAccountByEmail(row.email)) throw new ConflictException('An account with this e-mail already exists. Sign in with your existing password instead.');
    const name = (nameInput ?? row.name ?? '').trim().slice(0, 80) || row.email.split('@')[0];
    const { userModel } = this.db.repositories;
    let user: any;
    try {
      user = new userModel({ email: row.email, role: 'user' });
      Object.assign(user, { name, password: await bcrypt.hash(password, 10), isVerified: true, status: 'active' });
      await user.save();
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('An account with this e-mail already exists. Sign in with your existing password instead.');
      throw e;
    }
    let joined;
    try { joined = await this.finalizeAccept(row, store, hash, String(user._id)); }
    catch (e) { await userModel.deleteOne({ _id: user._id }).catch(() => undefined); throw e; }
    const { accessToken, refreshToken } = await this.auth.issueSession(user);
    return { ...joined, user: { id: user._id, name: user.name, email: user.email, role: 'user', image: null }, token: { accessToken, refreshToken } };
  }

  /**
   * The e-mail already has an Edudeen account: the person signs in HERE with their existing password (no separate password for
   * the team). Uses the normal login (verified / suspended / deleted checks), plus a per-invitation cap on wrong passwords.
   */
  async acceptWithExistingPassword(token: string, password: string, ip?: string, userAgent?: string) {
    if (typeof password !== 'string' || !password || password.length > 72) throw new BadRequestException('Enter your password');
    const { row, store, hash } = await this.loadInvite(token);
    const acc = await this.findAccountByEmail(row.email);
    if (!acc) throw new NotFoundException('No account found for this invitation. Create your password instead.');
    if (!acc.password) throw new BadRequestException('This account signs in with Google or another method. Use Sign in below.');
    if (String(store.sellerId) === String(acc._id)) throw new BadRequestException('You already own this store');
    const failKey = `store-invite-fail:${hash}`;
    if (this.redis?.isConnected) {
      const n = Number((await this.redis.get(failKey).catch(() => null)) ?? 0);
      if (n >= StoreTeamService.INVITE_FAIL_LIMIT) throw new HttpException('Too many wrong passwords for this invitation. Try again in 15 minutes.', 429);
    }
    let login: any;
    try {
      login = await this.auth.login({ email: acc.email, password, role: acc.role === 'seller' ? 'seller' : 'user' } as any, ip, userAgent);
    } catch (e) {
      if (this.redis?.isConnected) { try { await this.redis.incrWithTtl(failKey, StoreTeamService.INVITE_FAIL_TTL); } catch { /* ignore */ } }
      throw e;
    }
    const joined = await this.finalizeAccept(row, store, hash, String(acc._id));
    return { ...joined, user: login.data.user, token: login.data.token };
  }

  private async finalizeAccept(row: any, store: any, hash: string, userId: string) {
    if (String(store.sellerId) === userId) throw new BadRequestException('You already own this store');
    const done: any = await this.members.findOneAndUpdate(
      { _id: row._id, status: 'invited', inviteTokenHash: hash },
      { $set: { status: 'active', userId, acceptedAt: new Date(), inviteTokenHash: null, inviteExpiresAt: null } },
      { new: true },
    );
    if (!done) throw new NotFoundException('This invitation was already used');
    await this.bump();
    await this.audit(row.storeId, 'store_member_joined', `${row.email} joined the team as ${roleTemplate(row.roleKey)?.name}`, { id: String(done._id), name: done.name || null, role: 'collaborator' }, { email: row.email, roleKey: row.roleKey });
    void this.notifications.notify({
      recipientId: String(store.sellerId), recipientRole: 'seller', type: NOTIFICATION_TYPES.STORE_MEMBER_JOINED,
      title: 'New team member', body: `${row.email} accepted your invitation to ${store.name} as ${roleTemplate(row.roleKey)?.name}.`,
      data: { storeId: String(row.storeId), link: `/store/${row.storeId}/settings?tab=team` },
    });
    return { storeId: String(row.storeId), storeName: store.name };
  }

  /** Stores this signed-in person can work in (active membership, not expired). */
  async mine(caller: Caller) {
    if (caller.actAs) return { stores: [] };
    const email = lower(caller.email);
    const rows: any[] = await this.members.find({ status: 'active', $or: [{ userId: caller.userId }, { email }] }).lean();
    const live = rows.filter((r) => !r.accessExpiresAt || new Date(r.accessExpiresAt).getTime() > Date.now());
    if (!live.length) return { stores: [] };
    const stores: any[] = await this.db.repositories.storeModel.find({ _id: { $in: live.map((r) => r.storeId) }, isDelete: false, status: 'active' }).select('name slug logo').lean();
    const byId = new Map(stores.map((s) => [String(s._id), s]));
    return {
      stores: live.filter((r) => byId.has(String(r.storeId))).map((r) => {
        const s = byId.get(String(r.storeId));
        return { storeId: String(r.storeId), name: s.name, slug: s.slug, logo: s.logo ?? null, roleKey: r.roleKey, roleName: roleTemplate(r.roleKey)?.name ?? r.roleKey };
      }),
    };
  }

  /** The member opens a store: a 2 h store-locked token whose every request is re-checked by member-access.middleware. */
  async switchTo(caller: Caller, storeId: string) {
    if (caller.actAs) throw new ForbiddenException('Not available in this session');
    const row: any = await this.members.findOne({ storeId, status: 'active', $or: [{ userId: caller.userId }, { email: lower(caller.email) }] });
    if (!row) throw new ForbiddenException('You do not have access to this store');
    const a = await this.loadAccess(row, true);
    if (!a.active) throw new ForbiddenException(a.reason || 'Your access to this store has ended');
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name slug sellerId').lean();
    const seller: any = await this.db.repositories.sellerModel.findById(store.sellerId).select('email tokenVersion').lean();
    if (!row.userId) { await this.members.updateOne({ _id: row._id }, { $set: { userId: caller.userId } }); }
    const logged = await this.audit(storeId, 'store_member_session_started', `${row.email} opened the store (${roleTemplate(row.roleKey)?.name})`, { id: String(row._id), name: row.name || null, role: 'collaborator' }, { email: row.email, roleKey: row.roleKey });
    if (!logged) throw new ServiceUnavailableException('Could not record this action. Try again.');
    const session = await this.auth.issueMemberSession(seller, storeId, String(row._id));
    return {
      accessToken: session.accessToken, expiresInSeconds: session.expiresInSeconds,
      store: { id: storeId, name: store.name, slug: store.slug },
      role: { key: row.roleKey, name: roleTemplate(row.roleKey)?.name ?? row.roleKey },
      permissions: Array.from(a.permissions),
    };
  }

  // ── per-request access (middleware) ───────────────────────────────────────
  private async loadAccess(row: any, strict = false): Promise<MemberAccess> {
    const none = (reason: string): MemberAccess => ({ active: false, reason, name: '', roleKey: '', permissions: new Set() });
    if (!row || row.status !== 'active') return none(row?.status === 'suspended' ? 'Your access to this store is suspended.' : 'Your access to this store has ended.');
    if (row.accessExpiresAt && new Date(row.accessExpiresAt).getTime() <= Date.now()) return none('Your access period for this store has ended.');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: row.storeId, isDelete: false }).select('status sellerId').lean();
    if (!store || store.status === 'suspended' || store.status === 'rejected') return none('This store is not available.');
    const seller: any = await this.db.repositories.sellerModel.findById(store.sellerId).select('status isDelete').lean();
    if (!seller || seller.isDelete || seller.status === 'suspended' || seller.status === 'deleted') return none('This store is not available.');
    void strict;
    return { active: true, name: row.name || row.email, roleKey: row.roleKey, permissions: effectiveStorePermissions(row.roleKey, row.permissionsAdd, row.permissionsRemove) };
  }

  /** Cached 30 s. Throws on a database error so the middleware fails closed. */
  async accessFor(memberId: string, storeId: string, sellerId: string): Promise<MemberAccess> {
    const key = `${memberId}:${storeId}`;
    const rev = await this.currentRev();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ACCESS_CACHE_MS && hit.rev === rev) return hit.v;
    const row: any = await this.members.findOne({ _id: memberId, storeId }).lean();
    let v = await this.loadAccess(row);
    // The token's seller must still be the store's owner (store transferred / data changed = session ends).
    if (v.active) {
      const store: any = await this.db.repositories.storeModel.findById(storeId).select('sellerId').lean();
      if (!store || String(store.sellerId) !== String(sellerId)) v = { active: false, reason: 'This session is not valid.', name: '', roleKey: '', permissions: new Set() };
    }
    this.cache.set(key, { at: Date.now(), rev, v });
    return v;
  }

  // ── admin (read + remove only; audited) ───────────────────────────────────
  async adminList(storeId: string) {
    const rows = await this.members.find({ storeId, status: { $ne: 'removed' } }).sort({ createdAt: 1 }).lean();
    return { members: rows.map((r) => this.view(r)) };
  }

  async adminRemove(adminId: string, storeId: string, memberId: string) {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name sellerId').lean();
    if (!store) throw new NotFoundException('Store not found');
    const row = await this.removeRow(storeId, memberId);
    const ok = await this.audit(storeId, 'store_member_removed_by_admin', `Admin removed ${row.email} from the team`, { id: adminId, role: 'admin' }, { email: row.email });
    if (!ok) this.logger.error(`audit for admin removal of ${row.email} was not stored`);
    void this.notifications.notify({
      recipientId: String(store.sellerId), recipientRole: 'seller', type: NOTIFICATION_TYPES.STORE_MEMBER_REMOVED,
      title: 'Team member removed', body: `Edudeen removed ${row.email} from the team of ${store.name}.`,
      data: { storeId, link: `/store/${storeId}/settings?tab=team` },
    });
    return { success: true };
  }

  private async sendInvite(to: string, name: string, storeName: string, roleName: string, token: string, expiresAt: Date): Promise<boolean> {
    if (!this.email) return false;
    const base = (process.env.WEB_APP_URL || 'https://edudeen.com').replace(/\/+$/, '');
    const link = `${base}/store-invite/${token}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#141413"><h2 style="margin:0 0 12px">You are invited to a store on Edudeen</h2><p>Hi ${esc(name || 'there')},</p><p>You have been invited to help run <b>${esc(storeName)}</b> as <b>${esc(roleName)}</b>. Sign in with this e-mail address (or create a free account with it), then accept the invitation.</p><p><a href="${link}" style="display:inline-block;background:#174771;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">View invitation</a></p><p style="font-size:12px;color:#5d6570">This link works once and expires on ${expiresAt.toUTCString()}. If you were not expecting it, ignore this e-mail.</p></div>`;
    try { return await this.email.sendMail(to, `You are invited to ${storeName} on Edudeen`, html); } catch (e: any) { this.logger.warn(`team invite e-mail failed: ${e?.message}`); return false; }
  }
}
