/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChatSupportService, ESCALATIONS_PER_HOUR, tooManyLinks } from './chat-support.service';
import { AdminChatController } from './chat-admin.controller';
import { ChatbotController, requesterOf } from './chatbot.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';

// ── tiny in-memory stand-in for the Mongoose model (only the operations the service uses) ──
function match(doc: any, f: Record<string, any>): boolean {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return (v as any[]).some(sub => match(doc, sub));
    const d = k === '_id' ? String(doc._id) : doc[k];
    if (v && typeof v === 'object' && !(v instanceof RegExp) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(d);
      if ('$gt' in v) return d > v.$gt;
      return true;
    }
    if (v instanceof RegExp) return v.test(String(d ?? ''));
    return String(d) === String(v);
  });
}
function chain(get: () => any) {
  const c: any = { select: () => c, sort: () => c, skip: () => c, limit: () => c, lean: () => c, then: (r: any, j: any) => Promise.resolve(get()).then(r, j) };
  return c;
}
function fakeModel() {
  const docs: any[] = []; let n = 0;
  const model: any = {
    docs,
    findOne: (f: any) => chain(() => docs.filter(d => match(d, f)).sort((a, b) => +new Date(b.lastMessageAt) - +new Date(a.lastMessageAt))[0] ?? null),
    findById: (id: string) => chain(() => docs.find(d => String(d._id) === String(id)) ?? null),
    find: (f: any) => chain(() => docs.filter(d => match(d, f)).sort((a, b) => +new Date(b.lastMessageAt) - +new Date(a.lastMessageAt))),
    countDocuments: async (f: any) => docs.filter(d => match(d, f)).length,
    create: async (d: any) => { const doc = { _id: `507f1f77bcf86cd7994390${String(++n).padStart(2, '0')}`, createdAt: new Date(), ...d }; docs.push(doc); return { ...doc, toObject: () => doc }; },
    findOneAndUpdate: (f: any, u: any) => chain(() => { const d = docs.find(x => match(x, f)); if (d) apply(d, u); return d ?? null; }),
    updateOne: async (f: any, u: any) => { const d = docs.find(x => match(x, f)); if (d) apply(d, u); },
  };
  return model;
}
function apply(d: any, u: any) {
  if (u.$push?.messages) { d.messages.push(...u.$push.messages.$each); }
  if (u.$set) Object.assign(d, u.$set);
  if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) d[k] = (d[k] ?? 0) + (v as number);
}

function build(opts: { redis?: boolean } = {}) {
  const model = fakeModel();
  const repos: any = {
    userModel: { findById: () => chain(() => ({ name: 'Ali Khan', email: 'ali@x.com', phone: '0300' })) },
    sellerModel: { findById: () => chain(() => ({ name: 'Sara Ahmed', email: 'sara@x.com' })) },
    storeModel: { findOne: () => chain(() => ({ name: 'Sara Books' })) },
  };
  const db: any = { repositories: repos };
  const redis: any = { isConnected: !!opts.redis, incrWithTtl: jest.fn(async () => 1) };
  const notifications: any = { notify: jest.fn(async () => undefined) };
  const email: any = { sendMail: jest.fn(async () => true) };
  const activity: any = { log: jest.fn(async () => undefined) };
  const svc = new ChatSupportService(model, db, redis, notifications, email, activity);
  return { svc, model, notifications, email, activity, redis };
}
const buyer = { userId: 'u1', role: 'user', ip: '1.1.1.1' };
const seller = { userId: 's1', role: 'seller', ip: '1.1.1.1' };

describe('ChatSupportService - sender identity', () => {
  it('buyer: name + email come from the user document and the kind is buyer', async () => {
    const { svc } = build();
    const r: any = await svc.escalate(buyer, 'buyer', 'Do you ship to Quetta?', 'en');
    expect(r.kind).toBe('escalated'); expect(r.created).toBe(true);
    expect(r.conv).toMatchObject({ userKind: 'buyer', senderName: 'Ali Khan', senderEmail: 'ali@x.com', userId: 'u1', unreadForAdmin: 1, status: 'open' });
    expect(r.conv.shortCode).toMatch(/^[A-Z2-9]{4,6}$/);
  });

  it('seller: name from the seller document plus the store name', async () => {
    const { svc } = build();
    const r: any = await svc.escalate(seller, 'seller', 'How do I change my payout method?', 'en');
    expect(r.conv).toMatchObject({ userKind: 'seller', senderName: 'Sara Ahmed', storeName: 'Sara Books' });
  });

  it('identity is never taken from the body: a logged-in user passing a fake guest name keeps the account identity', async () => {
    const { svc } = build();
    const r: any = await svc.escalate({ ...buyer, guest: { name: 'Hacker', email: 'h@h.com' } }, 'buyer', 'question here', 'en');
    expect(r.conv.senderName).toBe('Ali Khan'); expect(r.conv.userKind).toBe('buyer');
  });

  it('guest: needs a name + email/phone first, then gets a token and kind guest', async () => {
    const { svc } = build();
    expect((await svc.escalate({ ip: '2.2.2.2' }, 'buyer', 'hello team', 'en')).kind).toBe('needs_contact');
    expect((await svc.escalate({ ip: '2.2.2.2', guest: { name: 'Zed' } }, 'buyer', 'hello team', 'en')).kind).toBe('needs_contact');
    const r: any = await svc.escalate({ ip: '2.2.2.2', guest: { name: 'Zed', email: 'zed@x.com' } }, 'buyer', 'hello team', 'en');
    expect(r.kind).toBe('escalated'); expect(r.guestToken).toHaveLength(48);
    expect(r.conv).toMatchObject({ userKind: 'guest', senderName: 'Zed', senderEmail: 'zed@x.com', userId: null });
    expect(r.conv.guestTokenHash).not.toBe(r.guestToken); // only the hash is stored
  });
});

describe('ChatSupportService - threads, privacy, polling', () => {
  it('a second question appends to the same active conversation and re-opens an answered one', async () => {
    const { svc, model } = build();
    const a: any = await svc.escalate(buyer, 'buyer', 'first question', 'en');
    await svc.adminReply('admin1', String(a.conv._id), 'Here is the answer');
    expect(model.docs[0].status).toBe('answered');
    const b: any = await svc.escalate(buyer, 'buyer', 'a follow up question', 'en');
    expect(b.created).toBe(false); expect(model.docs).toHaveLength(1);
    expect(model.docs[0].status).toBe('open'); expect(model.docs[0].messages).toHaveLength(3);
  });

  it('a user can only read their own conversation; guests only via their token; nobody via someone else', async () => {
    const { svc } = build();
    const a: any = await svc.escalate(buyer, 'buyer', 'my private question', 'en');
    expect((await svc.userView({ userId: 'u2', role: 'user' }))).toBeNull();
    expect((await svc.userView({ guestToken: 'abc' }))).toBeNull();
    expect((await svc.userView({ userId: 'u1', role: 'admin' }))).toBeNull(); // admin role is not an account here
    const g: any = await svc.escalate({ guest: { name: 'Zed', phone: '03001234567' } }, 'buyer', 'guest question', 'en');
    expect((await svc.userView({ guestToken: g.guestToken }))?.messages[0].text).toBe('guest question');
    expect((await svc.userView({ guestToken: g.guestToken, userId: 'u1', role: 'user' }))?.shortCode).toBe(a.conv.shortCode); // the account wins over a stray token
  });

  it('polling returns only newer messages and markRead clears the unread counter', async () => {
    const { svc } = build();
    const a: any = await svc.escalate(buyer, 'buyer', 'question one', 'en');
    const first = await svc.userView(buyer);
    await svc.adminReply('admin1', String(a.conv._id), 'answer one');
    const v = await svc.userView(buyer, { since: new Date(Date.now() - 1000).toISOString() });
    expect(v!.messages.map(m => m.from)).toContain('admin'); expect(v!.unreadForUser).toBe(1);
    const none = await svc.userView(buyer, { since: new Date(Date.now() + 60_000).toISOString(), markRead: true });
    expect(none!.messages).toHaveLength(0); expect(none!.unreadForUser).toBe(0); expect(first!.messages).toHaveLength(1);
  });

  it('follow-up needs an active conversation; closed conversations start a new one on the next question', async () => {
    const { svc, model } = build();
    expect(await svc.followUp(buyer, 'hello?')).toBeNull();
    const a: any = await svc.escalate(buyer, 'buyer', 'q one', 'en');
    expect((await svc.followUp(buyer, 'extra detail'))?.kind).toBe('escalated');
    await svc.adminClose('admin1', String(a.conv._id));
    expect(await svc.followUp(buyer, 'again')).toBeNull();
    const b: any = await svc.escalate(buyer, 'buyer', 'a new question', 'en');
    expect(b.created).toBe(true); expect(model.docs).toHaveLength(2);
  });
});

describe('ChatSupportService - spam guards and limits', () => {
  it('rate limits escalations per user (in-memory when Redis is down) and uses Redis when connected', async () => {
    const { svc } = build();
    for (let i = 0; i < ESCALATIONS_PER_HOUR; i++) expect((await svc.escalate({ ...buyer, userId: 'u9' }, 'buyer', `question number ${i}`, 'en')).kind).toBe('escalated');
    // follow-ups share the higher bucket, brand-new conversations are limited: close, then a 6th new one
    const r = await svc.overLimit('x', 1); expect(r).toBe(false); expect(await svc.overLimit('x', 1)).toBe(true);
    const rd = build({ redis: true }); rd.redis.incrWithTtl.mockResolvedValue(ESCALATIONS_PER_HOUR + 1);
    expect((await rd.svc.escalate(buyer, 'buyer', 'blocked question', 'en')).kind).toBe('rate_limited');
    expect(rd.redis.incrWithTtl).toHaveBeenCalled();
  });

  it('a new conversation beyond the hourly limit is rate_limited', async () => {
    const { svc } = build();
    for (let i = 0; i < ESCALATIONS_PER_HOUR; i++) {
      const r: any = await svc.escalate({ ...buyer, userId: 'u7' }, 'buyer', `question ${i}`, 'en');
      await svc.adminClose('a', String(r.conv._id));
    }
    expect((await svc.escalate({ ...buyer, userId: 'u7' }, 'buyer', 'one more question', 'en')).kind).toBe('rate_limited');
  });

  it('duplicate text within a few minutes is not appended twice; link floods and empty text are refused', async () => {
    const { svc, model } = build();
    await svc.escalate(buyer, 'buyer', 'same question', 'en');
    expect((await svc.escalate(buyer, 'buyer', 'Same Question', 'en')).kind).toBe('duplicate');
    expect(model.docs[0].messages).toHaveLength(1);
    await expect(svc.escalate(buyer, 'buyer', 'http://a.com http://b.com http://c.com', 'en')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.escalate(buyer, 'buyer', '   ', 'en')).rejects.toBeInstanceOf(BadRequestException);
    expect(tooManyLinks('see https://a.com')).toBe(false);
  });

  it('caps the text at 2000 characters', async () => {
    const { svc } = build();
    const r: any = await svc.escalate(buyer, 'buyer', 'x'.repeat(5000), 'en');
    expect(r.conv.messages[0].text).toHaveLength(2000);
  });
});

describe('ChatSupportService - admin side and delivery', () => {
  it('lists with filters and unread stats, opens a thread (clears unread), replies, closes, audit-logs', async () => {
    const { svc, activity } = build();
    const a: any = await svc.escalate(buyer, 'buyer', 'where is my order', 'en');
    await svc.escalate(seller, 'seller', 'fee question', 'en');
    expect((await svc.adminStats()).data).toMatchObject({ open: 2, unread: 2 });
    const list = (await svc.adminList({ status: 'unread' })).data;
    expect(list.total).toBe(2); expect(list.items.find((i: any) => i.userKind === 'seller')).toMatchObject({ senderName: 'Sara Ahmed', storeName: 'Sara Books' });
    expect((await svc.adminList({ q: 'sara' })).data.total).toBe(1);
    const opened = await svc.adminGet(String(a.conv._id)); expect(opened.data.messages).toHaveLength(1);
    expect((await svc.adminStats()).data.unread).toBe(1);
    const rep = await svc.adminReply('admin1', String(a.conv._id), 'It ships tomorrow');
    expect(rep.data.status).toBe('answered');
    await svc.adminClose('admin1', String(a.conv._id));
    expect((await svc.adminList({ status: 'closed' })).data.total).toBe(1);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'chat_reply', actorId: 'admin1' }));
    await expect(svc.adminGet('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.adminReply('admin1', String(a.conv._id), '  ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reply: in-app notification for accounts (seller role for sellers) and email when the user is not looking', async () => {
    const { svc, notifications, email } = build();
    const a: any = await svc.escalate(seller, 'seller', 'fee question', 'en');
    await svc.adminReply('admin1', String(a.conv._id), 'Fees are in Finance');
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 's1', recipientRole: 'seller', type: 'support_reply' }));
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    await svc.adminReply('admin1', String(a.conv._id), 'One more thing'); // throttled: one email per conversation per hour
    expect(email.sendMail).toHaveBeenCalledTimes(1);
  });

  it('no email while the widget is polling; guests are emailed at their own address and get no in-app notification', async () => {
    const t = build();
    const a: any = await t.svc.escalate(buyer, 'buyer', 'question', 'en');
    await t.svc.userView(buyer); // marks lastUserSeenAt
    await t.svc.adminReply('admin1', String(a.conv._id), 'answer');
    expect(t.email.sendMail).not.toHaveBeenCalled();
    const g = build();
    const r: any = await g.svc.escalate({ guest: { name: 'Zed', email: 'zed@x.com' } }, 'buyer', 'guest question', 'en');
    await g.svc.adminReply('admin1', String(r.conv._id), 'hi zed');
    expect(g.notifications.notify).not.toHaveBeenCalled(); expect(g.email.sendMail).toHaveBeenCalledWith('zed@x.com', expect.any(String), expect.stringContaining('hi zed'));
  });

  it('a failing email or notification never breaks the reply', async () => {
    const { svc, email } = build(); email.sendMail.mockRejectedValue(new Error('smtp down'));
    const a: any = await svc.escalate(buyer, 'buyer', 'question', 'en');
    await expect(svc.adminReply('admin1', String(a.conv._id), 'answer')).resolves.toMatchObject({ success: true });
  });
});

describe('controllers wiring', () => {
  it('admin chat controller is JWT + admin role only', () => {
    expect(Reflect.getMetadata('__guards__', AdminChatController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata('roles', AdminChatController)).toEqual(['admin']);
  });
  it('widget endpoints use optional auth and are throttled; identity helper reads the verified JWT only', () => {
    for (const m of ['message', 'conversation', 'followUp'] as const) {
      expect(Reflect.getMetadata('__guards__', ChatbotController.prototype[m])).toContain(OptionalJwtAuthGuard);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', ChatbotController.prototype[m])).toBeLessThanOrEqual(30);
    }
    expect(requesterOf({ user: { userId: 'u1', role: 'seller' }, ip: '9.9.9.9' }, 'tok')).toEqual({ userId: 'u1', role: 'seller', ip: '9.9.9.9', guestToken: 'tok' });
    expect(requesterOf({ user: null }).userId).toBeNull();
  });
});
