/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { EmailService } from '../otp/services/email.service';
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { clampInt, escapeRegex } from '../common/query-safety.util';
import { ChatConversation, ChatConversationDocument, ChatMessageRow, ChatVia } from './chat-conversation.schema';
import type { ChatAudience } from './chatbot.defaults';

export const CHAT_MAX_TEXT = 2000;
export const CHAT_MAX_MESSAGES = 300;
export const ESCALATIONS_PER_HOUR = 5;
export const FOLLOWUPS_PER_HOUR = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACTIVE = ['open', 'answered'];
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const SEEN_WINDOW_MS = 30_000; // the user polled this recently = looking at the widget = no email
const EMAIL_EVERY_MS = 60 * 60_000;
const WEB = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

export interface ChatRequester {
  userId?: string | null;
  /** JWT role: 'user' (buyer) | 'seller' | 'admin' | null. */
  role?: string | null;
  ip?: string | null;
  guestToken?: string | null;
  guest?: { name?: string; email?: string; phone?: string } | null;
}

export type EscalateResult =
  | { kind: 'escalated'; conv: any; messageId: string; created: boolean; guestToken?: string }
  | { kind: 'duplicate'; conv: any }
  | { kind: 'needs_contact' }
  | { kind: 'rate_limited' };

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const newId = () => randomBytes(6).toString('hex');
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{6,17}$/;

/** Spam guard: more than two links in one message is almost always a link flood. */
export function tooManyLinks(text: string): boolean {
  return (text.match(/https?:\/\/|www\./gi) ?? []).length > 2;
}

@Injectable()
export class ChatSupportService {
  private readonly logger = new Logger(ChatSupportService.name);
  private readonly mem = new Map<string, { n: number; until: number }>();

  constructor(
    @InjectModel(ChatConversation.name) private readonly model: Model<ChatConversationDocument>,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ── rate limit ─────────────────────────────────────────────────────────────
  /** Counts one action; true when the limit for this hour is exceeded. Redis when connected, in-memory otherwise. */
  async overLimit(key: string, limit: number): Promise<boolean> {
    if (this.redis.isConnected) {
      try { return (await this.redis.incrWithTtl(`chat:rl:${key}`, 3600)) > limit; } catch { /* fall through */ }
    }
    const now = Date.now();
    const cur = this.mem.get(key);
    const e = cur && cur.until > now ? cur : { n: 0, until: now + 3600_000 };
    e.n++; this.mem.set(key, e);
    if (this.mem.size > 5000) for (const [k, v] of this.mem) if (v.until <= now) this.mem.delete(k);
    return e.n > limit;
  }

  // ── identity ───────────────────────────────────────────────────────────────
  private isAccount(req: ChatRequester) { return !!req.userId && (req.role === 'user' || req.role === 'seller'); }

  /** Name/email/store come from the DB document of the verified JWT, never from the request body. */
  async accountIdentity(req: ChatRequester) {
    const r = this.db.repositories;
    if (req.role === 'seller') {
      const seller: any = await r.sellerModel.findById(req.userId).select('name email phone').lean();
      if (!seller) return null;
      const store: any = await r.storeModel.findOne({ sellerId: String(req.userId) }).select('name').lean();
      return { userKind: 'seller', userId: String(req.userId), senderName: clean(seller.name, 80) || 'Seller', senderEmail: seller.email ?? null, senderPhone: seller.phone ?? null, storeName: store?.name ? clean(store.name, 80) : null };
    }
    const user: any = await r.userModel.findById(req.userId).select('name email phone').lean();
    if (!user) return null;
    return { userKind: 'buyer', userId: String(req.userId), senderName: clean(user.name, 80) || 'Buyer', senderEmail: user.email ?? null, senderPhone: user.phone ?? null, storeName: null as string | null };
  }

  private activeFilter(req: ChatRequester): Record<string, any> | null {
    if (this.isAccount(req)) return { userId: String(req.userId), status: { $in: ACTIVE } };
    if (req.guestToken) return { guestTokenHash: sha(req.guestToken), userKind: 'guest', status: { $in: ACTIVE } };
    return null;
  }

  async findActive(req: ChatRequester): Promise<any | null> {
    const f = this.activeFilter(req);
    return f ? this.model.findOne(f).sort({ lastMessageAt: -1 }).lean() : null;
  }

  // ── user side ──────────────────────────────────────────────────────────────
  private async uniqueCode(): Promise<string> {
    for (let len = 4; len <= 6; len++) {
      for (let i = 0; i < 5; i++) {
        let c = ''; const b = randomBytes(len);
        for (let k = 0; k < len; k++) c += CODE_ALPHABET[b[k] % CODE_ALPHABET.length];
        if (!(await this.model.findOne({ shortCode: c }).select('_id').lean())) return c;
      }
    }
    throw new Error('could not allocate a chat code');
  }

  private mkMessage(from: 'user' | 'admin', text: string, via: ChatVia): ChatMessageRow {
    return { id: newId(), from, text, at: new Date(), via };
  }

  /** Typed question that the greeting table and FAQ matcher could not answer. */
  async escalate(req: ChatRequester, audience: ChatAudience, rawText: string, lang: string): Promise<EscalateResult> {
    const text = clean(rawText, CHAT_MAX_TEXT);
    if (!text) throw new BadRequestException('Message is empty');
    if (tooManyLinks(text)) throw new BadRequestException('Please remove the extra links from your message.');

    const account = this.isAccount(req) ? await this.accountIdentity(req) : null;
    const existing = await this.findActive(account ? req : { ...req, userId: null });
    const limitKey = account ? `u:${account.userId}` : req.guestToken ? `g:${sha(req.guestToken)}` : `ip:${req.ip ?? 'x'}`;

    if (existing) {
      const dup = await this.isDuplicate(existing, text);
      if (dup) return { kind: 'duplicate', conv: existing };
      if (await this.overLimit(limitKey, FOLLOWUPS_PER_HOUR)) return { kind: 'rate_limited' };
      const msg = this.mkMessage('user', text, 'widget');
      const conv = await this.pushUserMessage(existing._id, msg);
      return { kind: 'escalated', conv, messageId: msg.id, created: false };
    }

    // Guests give a name + a way to reach them once; accounts never do.
    let guest: { name: string; email: string | null; phone: string | null } | null = null;
    if (!account) {
      const email = clean(req.guest?.email, 200).toLowerCase(); const phone = clean(req.guest?.phone, 20);
      const name = clean(req.guest?.name, 80);
      if (!name || (!EMAIL_RE.test(email) && !PHONE_RE.test(phone))) return { kind: 'needs_contact' };
      guest = { name, email: EMAIL_RE.test(email) ? email : null, phone: PHONE_RE.test(phone) ? phone : null };
    }

    if (await this.overLimit(limitKey, ESCALATIONS_PER_HOUR)) return { kind: 'rate_limited' };
    if (!account && req.ip && (await this.overLimit(`ip:${req.ip}`, ESCALATIONS_PER_HOUR * 2))) return { kind: 'rate_limited' };

    const guestToken = !account ? (req.guestToken || randomBytes(24).toString('hex')) : undefined;
    const msg = this.mkMessage('user', text, 'widget');
    const base = account
      ? { userKind: account.userKind, userId: account.userId, senderName: account.senderName, senderEmail: account.senderEmail, senderPhone: account.senderPhone, storeName: account.storeName }
      : { userKind: 'guest', userId: null, guestTokenHash: sha(guestToken!), senderName: guest!.name, senderEmail: guest!.email, senderPhone: guest!.phone, storeName: null };
    let conv: any = null;
    for (let attempt = 0; attempt < 3 && !conv; attempt++) {
      try {
        conv = (await this.model.create({
          ...base, shortCode: await this.uniqueCode(), audience: audience === 'seller' ? 'seller' : 'buyer', status: 'open',
          unreadForAdmin: 1, unreadForUser: 0, lastMessageAt: new Date(), lang: clean(lang, 10) || 'en', messages: [msg],
        })) as any;
        if (conv?.toObject) conv = conv.toObject();
      } catch (e: any) { if (e?.code !== 11000 || attempt === 2) throw e; }
    }
    return { kind: 'escalated', conv, messageId: msg.id, created: true, ...(guestToken ? { guestToken } : {}) };
  }

  /** Follow-up inside an active conversation (no FAQ/greeting matching). Null when the user has no active conversation. */
  async followUp(req: ChatRequester, rawText: string): Promise<EscalateResult | null> {
    const text = clean(rawText, CHAT_MAX_TEXT);
    if (!text) throw new BadRequestException('Message is empty');
    if (tooManyLinks(text)) throw new BadRequestException('Please remove the extra links from your message.');
    const existing = await this.findActive(req);
    if (!existing) return null;
    if (await this.isDuplicate(existing, text)) return { kind: 'duplicate', conv: existing };
    const key = this.isAccount(req) ? `u:${req.userId}` : `g:${sha(req.guestToken!)}`;
    if (await this.overLimit(key, FOLLOWUPS_PER_HOUR)) return { kind: 'rate_limited' };
    const msg = this.mkMessage('user', text, 'widget');
    const conv = await this.pushUserMessage(existing._id, msg);
    return { kind: 'escalated', conv, messageId: msg.id, created: false };
  }

  private async isDuplicate(conv: any, text: string): Promise<boolean> {
    const last = [...(conv.messages ?? [])].reverse().find((m: ChatMessageRow) => m.from === 'user');
    return !!last && last.text.toLowerCase() === text.toLowerCase() && Date.now() - new Date(last.at).getTime() < DUPLICATE_WINDOW_MS;
  }

  private async pushUserMessage(id: any, msg: ChatMessageRow) {
    const conv = await this.model.findOneAndUpdate(
      { _id: id },
      { $push: { messages: { $each: [msg], $slice: -CHAT_MAX_MESSAGES } }, $set: { status: 'open', lastMessageAt: msg.at }, $inc: { unreadForAdmin: 1 } },
      { new: true },
    ).lean();
    return conv as any;
  }

  /** The current user's active conversation (account by userId, guest by token). Never returns anyone else's. */
  async userView(req: ChatRequester, opts: { since?: string; markRead?: boolean } = {}) {
    const found = await this.findActive(req);
    if (!found) return null;
    const upd: Record<string, any> = { lastUserSeenAt: new Date() };
    if (opts.markRead) upd.unreadForUser = 0;
    await this.model.updateOne({ _id: found._id }, { $set: upd });
    const since = opts.since ? new Date(opts.since) : null;
    const msgs = (found.messages as ChatMessageRow[])
      .filter(m => !since || isNaN(since.getTime()) || new Date(m.at) > since)
      .map(m => ({ id: m.id, from: m.from, text: m.text, at: m.at }));
    return {
      id: String(found._id), shortCode: found.shortCode, status: found.status,
      unreadForUser: opts.markRead ? 0 : found.unreadForUser, lastMessageAt: found.lastMessageAt, messages: msgs,
    };
  }

  // ── admin side ─────────────────────────────────────────────────────────────
  private adminRow(c: any) {
    const last = [...(c.messages ?? [])].pop();
    return {
      id: String(c._id), shortCode: c.shortCode, userKind: c.userKind, userId: c.userId ?? null, senderName: c.senderName,
      senderEmail: c.senderEmail ?? null, senderPhone: c.senderPhone ?? null, storeName: c.storeName ?? null,
      status: c.status, unreadForAdmin: c.unreadForAdmin ?? 0, lastMessageAt: c.lastMessageAt, createdAt: c.createdAt,
      messageCount: (c.messages ?? []).length, preview: last ? String(last.text).slice(0, 140) : '', lastFrom: last?.from ?? null,
    };
  }

  async adminList(q: { status?: string; q?: string; page?: string; limit?: string }) {
    const page = Math.max(1, clampInt(q.page, 1, 1, 100000));
    const limit = clampInt(q.limit, 20, 1, 50);
    const filter: Record<string, any> = {};
    if (q.status === 'unread') filter.unreadForAdmin = { $gt: 0 };
    else if (['open', 'answered', 'closed'].includes(String(q.status))) filter.status = q.status;
    const term = clean(q.q, 80);
    if (term) {
      const re = new RegExp(escapeRegex(term), 'i');
      filter.$or = [{ senderName: re }, { senderEmail: re }, { storeName: re }, { shortCode: re }];
    }
    const [rows, total] = await Promise.all([
      this.model.find(filter).sort({ lastMessageAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    return { success: true, data: { items: rows.map(r => this.adminRow(r)), total, page, limit } };
  }

  async adminStats() {
    const [open, answered, closed, unread] = await Promise.all([
      this.model.countDocuments({ status: 'open' }), this.model.countDocuments({ status: 'answered' }),
      this.model.countDocuments({ status: 'closed' }), this.model.countDocuments({ unreadForAdmin: { $gt: 0 } }),
    ]);
    return { success: true, data: { open, answered, closed, unread } };
  }

  private async mustFind(id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Conversation not found');
    const c = await this.model.findById(id).lean();
    if (!c) throw new NotFoundException('Conversation not found');
    return c as any;
  }

  async adminGet(id: string) {
    const c = await this.mustFind(id);
    if (c.unreadForAdmin) await this.model.updateOne({ _id: c._id }, { $set: { unreadForAdmin: 0 } });
    return { success: true, data: { ...this.adminRow({ ...c, unreadForAdmin: 0 }), messages: c.messages } };
  }

  async adminReply(adminId: string, id: string, rawText: string, via: ChatVia = 'panel') {
    const text = clean(rawText, CHAT_MAX_TEXT);
    if (!text) throw new BadRequestException('Reply is empty');
    const c = await this.mustFind(id);
    const msg = this.mkMessage('admin', text, via);
    const updated: any = await this.model.findOneAndUpdate(
      { _id: c._id },
      { $push: { messages: { $each: [msg], $slice: -CHAT_MAX_MESSAGES } }, $set: { status: 'answered', lastMessageAt: msg.at, unreadForAdmin: 0 }, $inc: { unreadForUser: 1 } },
      { new: true },
    ).lean();
    void this.activityLog.log({ category: 'customers', action: 'chat_reply', description: `Replied to chat #${c.shortCode}`, actorId: adminId, actorRole: 'admin', targetId: String(c._id), targetType: 'chat_conversation' }).catch(() => undefined);
    await this.deliverReply(updated ?? c, text);
    return { success: true, data: { ...this.adminRow(updated ?? c), messages: (updated ?? c).messages } };
  }

  async adminClose(adminId: string, id: string) {
    const c = await this.mustFind(id);
    const updated: any = await this.model.findOneAndUpdate({ _id: c._id }, { $set: { status: 'closed', unreadForAdmin: 0 } }, { new: true }).lean();
    void this.activityLog.log({ category: 'customers', action: 'chat_closed', description: `Closed chat #${c.shortCode}`, actorId: adminId, actorRole: 'admin', targetId: String(c._id), targetType: 'chat_conversation' }).catch(() => undefined);
    return { success: true, data: this.adminRow(updated ?? c) };
  }

  // ── delivery of the admin's answer ─────────────────────────────────────────
  /** In-app notification for accounts + a throttled email when the user is not looking at the widget. Never throws. */
  async deliverReply(conv: any, text: string): Promise<void> {
    try {
      if (conv.userId && (conv.userKind === 'buyer' || conv.userKind === 'seller')) {
        await this.notifications.notify({
          recipientId: String(conv.userId), recipientRole: conv.userKind === 'seller' ? 'seller' : 'user',
          type: NOTIFICATION_TYPES.SUPPORT_REPLY, title: 'The Edudeen team replied', body: text.slice(0, 140),
          data: { link: conv.userKind === 'seller' ? '/?openChat=1' : '/account/dashboard?openChat=1', conversationId: String(conv._id), shortCode: conv.shortCode },
        });
      }
      const seen = conv.lastUserSeenAt ? Date.now() - new Date(conv.lastUserSeenAt).getTime() < SEEN_WINDOW_MS : false;
      const lastMail = conv.lastUserEmailAt ? Date.now() - new Date(conv.lastUserEmailAt).getTime() : Infinity;
      if (!seen && lastMail >= EMAIL_EVERY_MS && conv.senderEmail) {
        await this.model.updateOne({ _id: conv._id }, { $set: { lastUserEmailAt: new Date() } });
        const html = notificationEmailShell(
          'The Edudeen team replied to your question',
          `<p>Hi ${escapeHtml(conv.senderName)},</p><p>${escapeHtml(text.slice(0, 600)).replace(/\n/g, '<br>')}</p><p>You can continue the conversation in the chat bubble on Edudeen.</p>`,
          { label: 'Open Edudeen', url: `${WEB()}/?openChat=1` },
        );
        await this.email.sendMail(conv.senderEmail, 'The Edudeen team replied to your question', html);
      }
    } catch (e: any) {
      this.logger.warn(`chat reply delivery failed: ${String(e?.message ?? '').slice(0, 120)}`);
    }
  }
}
