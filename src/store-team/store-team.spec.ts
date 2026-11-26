/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createMemberAccessMiddleware } from './member-access.middleware';
import { effectiveStorePermissions, memberRequirement } from './permissions';
import { createHash } from 'crypto';
import { StoreTeamService } from './store-team.service';

describe('member permissions', () => {
  const need = (m: string, p: string) => memberRequirement(m, p);
  it('owner-only areas are refused for every role, finance even for reads', () => {
    for (const [m, p] of [
      ['GET', '/api/finance/abc/earnings-summary'], ['POST', '/api/finance/abc/payouts/request'], ['PATCH', '/api/finance/abc/payout-schedule'],
      ['POST', '/api/platform-plans/change'], ['PUT', '/api/users/change-password'], ['DELETE', '/api/users/profile'], ['POST', '/api/auth/switch-to-buyer'],
      ['POST', `/api/store-team/${'a'.repeat(24)}/members`], ['GET', `/api/store-team/${'a'.repeat(24)}/members`], ['PUT', '/api/orders/mark-paid/1'],
      ['DELETE', '/api/store/abc'], ['PATCH', '/api/store/abc/custom-domain'], ['POST', '/api/stripe-connect/onboard'],
    ]) expect(need(m, p).denied).toBeTruthy();
  });
  it('reads of shared panel data stay open (plan banner, profile, store, products)', () => {
    for (const p of ['/api/platform-plans/abc', '/api/users/profile', '/api/products/x', '/api/orders/seller-orders/abc']) expect(need('GET', p)).toEqual({ need: null });
  });
  it('writes need the matching permission; unmapped writes are refused', () => {
    expect(need('POST', '/api/products/add-physical-product').need).toBe('products.manage');
    expect(need('PUT', '/api/orders/update-status/1').need).toBe('orders.manage');
    expect(need('PUT', '/api/orders/return-action/1').need).toBe('returns.manage');
    expect(need('POST', '/api/messaging/send').need).toBe('support.manage');
    expect(need('POST', '/api/marketing/coupons').need).toBe('marketing.manage');
    expect(need('PATCH', '/api/store/abc/holiday').need).toBe('storefront.manage');
    expect(need('POST', '/api/something-new/write').denied).toBeTruthy();
    expect(need('POST', '/api/auth/logout')).toEqual({ need: null });
  });
  it('effective rights = template + extras - removals, unknown keys ignored', () => {
    expect([...effectiveStorePermissions('viewer')]).toEqual([]);
    expect(effectiveStorePermissions('support', ['products.manage', 'nope'], ['support.manage']).has('products.manage')).toBe(true);
    expect(effectiveStorePermissions('support', ['products.manage'], ['support.manage']).has('support.manage')).toBe(false);
    expect(effectiveStorePermissions('manager').has('orders.manage')).toBe(true);
  });
});

describe('member access middleware', () => {
  const payload = { sub: 's1', typ: 'access', actAs: 'collaborator', memberId: 'm1', storeId: 'st1' };
  const run = async (mw: any, req: any) => {
    const res: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    let nexted = false; await mw(req, res, () => { nexted = true; }); return { res, nexted };
  };
  const mk = (perms: string[] = ['products.manage'], active = true, logOk = true) => {
    const log = jest.fn().mockResolvedValue(logOk);
    const access = jest.fn().mockResolvedValue({ active, name: 'Ali', roleKey: 'manager', permissions: new Set(perms), reason: 'ended' });
    return { log, access, mw: createMemberAccessMiddleware({ verify: (t) => (t === 'mem' ? payload : t === 'admin' ? { ...payload, actAs: 'admin' } : null), access, log }) };
  };
  const req = (o: any = {}) => ({ method: 'GET', path: '/api/products/x', headers: { authorization: 'Bearer mem' }, query: {}, body: {}, ...o });

  it('ignores other tokens', async () => {
    const { mw, access } = mk();
    expect((await run(mw, req({ headers: { authorization: 'Bearer admin' } }))).nexted).toBe(true);
    expect((await run(mw, req({ headers: {} }))).nexted).toBe(true);
    expect(access).not.toHaveBeenCalled();
  });
  it('a Manager-style member is still refused finance, plan, team and password', async () => {
    const { mw } = mk(['products.manage', 'orders.manage', 'returns.manage', 'support.manage', 'marketing.manage', 'storefront.manage']);
    for (const [m, p] of [['GET', '/api/finance/st1/earnings-summary'], ['POST', '/api/finance/st1/payouts/request'], ['POST', '/api/platform-plans/change'], ['PUT', '/api/users/change-password'], ['POST', `/api/store-team/${'b'.repeat(24)}/members`]]) {
      const r = await run(mw, req({ method: m, path: p })); expect(r.res.code).toBe(403); expect(r.res.body.code).toBe('MEMBER_FORBIDDEN'); expect(r.nexted).toBe(false);
    }
  });
  it('write needs the permission; with it the write is audited first as the member', async () => {
    const a = mk(['orders.manage']);
    const denied = await run(a.mw, req({ method: 'POST', path: '/api/products/add-physical-product' }));
    expect(denied.res.code).toBe(403); expect(a.log).not.toHaveBeenCalled();
    const b = mk(['products.manage']);
    const r = await run(b.mw, req({ method: 'POST', path: '/api/products/add-physical-product' }));
    expect(r.nexted).toBe(true);
    expect(b.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'store_member_write', actorId: 'm1', actorRole: 'collaborator', storeId: 'st1', metadata: expect.objectContaining({ actAs: 'collaborator' }) }));
  });
  it('a viewer can read but not write', async () => {
    const { mw } = mk([]);
    expect((await run(mw, req())).nexted).toBe(true);
    expect((await run(mw, req({ method: 'PATCH', path: '/api/store/st1/holiday' }))).res.code).toBe(403);
  });
  it('suspended / removed / expired member is cut off at once (403 MEMBER_ACCESS_ENDED)', async () => {
    const { mw } = mk(['products.manage'], false);
    const r = await run(mw, req()); expect(r.res.code).toBe(403); expect(r.res.body.code).toBe('MEMBER_ACCESS_ENDED');
  });
  it('refuses another store id, refuses a write when the audit entry fails, fails closed on errors', async () => {
    const { mw } = mk();
    expect((await run(mw, req({ query: { storeId: 'other' } }))).res.body.code).toBe('MEMBER_OTHER_STORE');
    const bad = mk(['products.manage'], true, false);
    expect((await run(bad.mw, req({ method: 'POST', path: '/api/products/x' }))).res.code).toBe(503);
    const boom = createMemberAccessMiddleware({ verify: () => payload, access: async () => { throw new Error('db'); }, log: async () => true });
    expect((await run(boom, req())).res.code).toBe(503);
  });
});

// ── service ───────────────────────────────────────────────────────────────
function mkSvc(o: any = {}) {
  const store = { _id: 'st1', name: 'Noor', slug: 'noor', status: 'active', sellerId: 'own1', ...o.store };
  const rows: any[] = o.rows ?? [];
  const q = (v: any) => ({ select: () => ({ lean: async () => v }), lean: async () => v, then: (a: any, b: any) => Promise.resolve(v).then(a, b) });
  const members: any = function (this: any, d: any) { Object.assign(this, d); this._id = 'new1'; this.save = async () => { rows.push(this); }; this.toObject = () => ({ ...this }); };
  members.countDocuments = async () => rows.filter(r => r.status !== 'removed').length;
  const st = (want: any, have: string) => !want || (typeof want === 'object' ? have !== want.$ne : have === want);
  const orOk = (f: any, r: any) => !f.$or || f.$or.some((c: any) => (c.userId && r.userId === c.userId) || (c.email && r.email === c.email));
  members.findOne = (f: any) => q(rows.find(r => (!f._id || r._id === f._id) && (!f.email || r.email === f.email) && st(f.status, r.status) && orOk(f, r) && (!f.inviteTokenHash || r.inviteTokenHash === f.inviteTokenHash)) ?? null);
  members.find = () => ({ sort: () => ({ select: () => ({ lean: async () => rows }), lean: async () => rows }), lean: async () => rows });
  members.deleteOne = jest.fn();
  members.findOneAndUpdate = jest.fn(async (f: any, u: any) => { const r = rows.find(x => x._id === f._id && st(f.status, x.status)); if (!r) return null; Object.assign(r, u.$set); return { ...r, toObject: () => ({ ...r }) }; });
  members.updateOne = jest.fn();
  const users: any[] = o.users ?? [];
  const byEmail = (list: any[]) => (f: any) => Promise.resolve(list.find(u => f.email instanceof RegExp ? f.email.test(u.email) : u.email === f.email) ?? null);
  const userModel: any = function (this: any, d: any) { Object.assign(this, d); this._id = 'u-new'; this.save = async () => { if (users.some(u => u.email === this.email)) throw Object.assign(new Error('dup'), { code: 11000 }); users.push(this); }; };
  userModel.findOne = byEmail(users);
  userModel.deleteOne = jest.fn(async () => { users.pop(); });
  const sellers: any[] = o.sellers ?? [];
  const db: any = { repositories: {
    storeModel: { findOne: () => q(o.noStore ? null : store), findById: () => q(store), find: () => q([store]) },
    sellerModel: { findById: () => q({ _id: 'own1', email: 'owner@x.com', tokenVersion: 4, status: 'active', ...o.seller }), findOne: byEmail(sellers) },
    userModel,
  } };
  const auth: any = {
    issueMemberSession: jest.fn().mockResolvedValue({ accessToken: 'tok', expiresInSeconds: 7200 }),
    issueSession: jest.fn().mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' }),
    login: jest.fn(async () => { if (o.wrongPassword) throw new Error('Invalid email or password'); return { data: { user: { id: 'u1', name: 'Ali', email: 'ali@x.com', role: 'user', image: null }, token: { accessToken: 'acc', refreshToken: 'ref' } } }; }),
  };
  const activity: any = { log: jest.fn().mockResolvedValue(o.logOk ?? true) };
  const notifications: any = { notify: jest.fn() };
  const email: any = { sendMail: jest.fn().mockResolvedValue(true) };
  return { svc: new StoreTeamService(members, db, auth, activity, notifications, email, o.redis), rows, activity, notifications, email, auth, members };
}
const owner = { userId: 'own1', email: 'owner@x.com', role: 'seller' };

describe('StoreTeamService', () => {
  it('only the real owner manages the team (not a member or admin session, not another seller)', async () => {
    const t = mkSvc();
    await expect(t.svc.list({ ...owner, actAs: 'collaborator' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.svc.list({ ...owner, actAs: 'admin' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(mkSvc({ noStore: true }).svc.list({ ...owner, userId: 'other' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invites by e-mail, stores only a hash of the token, e-mails the link, audits', async () => {
    const t = mkSvc();
    const r = await t.svc.invite(owner, 'st1', { email: ' Ali@X.com ', name: 'Ali', roleKey: 'manager' } as any);
    expect(r.emailSent).toBe(true);
    const html: string = t.email.sendMail.mock.calls[0][2];
    const token = /store-invite\/([0-9a-f]{64})/.exec(html)![1];
    expect(t.rows[0].inviteTokenHash).not.toBe(token); expect(t.rows[0].inviteTokenHash).toHaveLength(64);
    expect(t.rows[0].email).toBe('ali@x.com');
    expect(t.activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'store_member_invited' }));
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it('refuses the owner e-mail, a duplicate, and a 6th member', async () => {
    await expect(mkSvc().svc.invite(owner, 'st1', { email: 'owner@x.com', roleKey: 'viewer' } as any)).rejects.toBeInstanceOf(BadRequestException);
    const dup = mkSvc({ rows: [{ _id: 'a', email: 'ali@x.com', status: 'active' }] });
    await expect(dup.svc.invite(owner, 'st1', { email: 'ali@x.com', roleKey: 'viewer' } as any)).rejects.toBeInstanceOf(ConflictException);
    const full = mkSvc({ rows: [1, 2, 3, 4, 5].map(i => ({ _id: 'm' + i, email: `m${i}@x.com`, status: 'active' })) });
    await expect(full.svc.invite(owner, 'st1', { email: 'six@x.com', roleKey: 'viewer' } as any)).rejects.toThrow('at most 5');
  });

  it('accept: wrong e-mail 403, right e-mail activates once, second use fails', async () => {
    const t = mkSvc();
    await t.svc.invite(owner, 'st1', { email: 'ali@x.com', roleKey: 'support' } as any);
    const token = /store-invite\/([0-9a-f]{64})/.exec(t.email.sendMail.mock.calls[0][2])![1];
    await expect(t.svc.accept({ userId: 'u9', email: 'eve@x.com', role: 'user' }, token)).rejects.toBeInstanceOf(ForbiddenException);
    const r = await t.svc.accept({ userId: 'u1', email: 'Ali@x.com', role: 'user' }, token);
    expect(r.storeId).toBe('st1');
    expect(t.rows[0]).toMatchObject({ status: 'active', userId: 'u1', inviteTokenHash: null });
    expect(t.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'own1', type: 'store_member_joined' }));
    await expect(t.svc.accept({ userId: 'u1', email: 'ali@x.com', role: 'user' }, token)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('joining straight from the invitation page', () => {
    const TOKEN = 'T'.repeat(40);
    const invited = () => [{ _id: 'm1', storeId: 'st1', email: 'ali@x.com', name: 'Ali', roleKey: 'manager', permissionsAdd: [], permissionsRemove: [], status: 'invited', inviteTokenHash: createHash('sha256').update(TOKEN).digest('hex'), inviteExpiresAt: new Date(Date.now() + 1e6) }];

    it('inviteInfo tells the page which form to show (no account / account with password / social-only)', async () => {
      expect(await mkSvc({ rows: invited() }).svc.inviteInfo(TOKEN)).toMatchObject({ hasAccount: false, hasPassword: false });
      expect(await mkSvc({ rows: invited(), users: [{ _id: 'u1', email: 'ALI@x.com', password: 'hash', isVerified: true }] }).svc.inviteInfo(TOKEN)).toMatchObject({ hasAccount: true, hasPassword: true, accountVerified: true });
      expect(await mkSvc({ rows: invited(), users: [{ _id: 'u1', email: 'ali@x.com', password: undefined, isVerified: true }] }).svc.inviteInfo(TOKEN)).toMatchObject({ hasAccount: true, hasPassword: false });
    });

    it('no account: creates a verified buyer account with a hashed password, joins the team and signs in', async () => {
      const t = mkSvc({ rows: invited() });
      const r: any = await t.svc.acceptWithNewPassword(TOKEN, 'Str0ng-pass', 'Ali Khan');
      expect(r.token).toEqual({ accessToken: 'acc', refreshToken: 'ref' });
      expect(r.user).toMatchObject({ email: 'ali@x.com', role: 'user' });
      expect(t.rows[0]).toMatchObject({ status: 'active', inviteTokenHash: null });
      expect(t.auth.issueSession).toHaveBeenCalledWith(expect.objectContaining({ email: 'ali@x.com', isVerified: true }));
      const saved = t.auth.issueSession.mock.calls[0][0];
      expect(saved.password).not.toBe('Str0ng-pass'); expect(saved.password).toMatch(/^\$2[aby]\$/);
      expect(t.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'store_member_joined' }));
    });

    it('new password must be 8-72 characters; an e-mail that already has an account is sent to the existing-password path; a bad token creates nothing', async () => {
      const t = mkSvc({ rows: invited() });
      await expect(t.svc.acceptWithNewPassword(TOKEN, 'short')).rejects.toBeInstanceOf(BadRequestException);
      await expect(t.svc.acceptWithNewPassword(TOKEN, 'x'.repeat(73))).rejects.toBeInstanceOf(BadRequestException);
      const dup = mkSvc({ rows: invited(), users: [{ _id: 'u1', email: 'ali@x.com', password: 'h', isVerified: true }] });
      await expect(dup.svc.acceptWithNewPassword(TOKEN, 'Str0ng-pass')).rejects.toBeInstanceOf(ConflictException);
      const bad = mkSvc({ rows: invited() });
      await expect(bad.svc.acceptWithNewPassword('Z'.repeat(40), 'Str0ng-pass')).rejects.toBeInstanceOf(NotFoundException);
      expect(bad.auth.issueSession).not.toHaveBeenCalled();
    });

    it('existing account: the usual password (no separate team password) joins and signs in through the normal login', async () => {
      const t = mkSvc({ rows: invited(), users: [{ _id: 'u1', email: 'ali@x.com', role: 'user', password: 'hash', isVerified: true }] });
      const r: any = await t.svc.acceptWithExistingPassword(TOKEN, 'MyUsualPass1', '1.2.3.4', 'UA');
      expect(t.auth.login).toHaveBeenCalledWith(expect.objectContaining({ email: 'ali@x.com', password: 'MyUsualPass1', role: 'user' }), '1.2.3.4', 'UA');
      expect(r.token.accessToken).toBe('acc'); expect(t.rows[0].status).toBe('active'); expect(t.rows[0].userId).toBe('u1');
    });

    it('existing account, wrong password: not joined, token stays valid, and 5 wrong tries lock that invitation (429)', async () => {
      const kv = new Map<string, number>();
      const redis: any = { isConnected: true, get: async (k: string) => (kv.has(k) ? String(kv.get(k)) : null), set: async () => {}, incrWithTtl: async (k: string) => { kv.set(k, (kv.get(k) ?? 0) + 1); return kv.get(k); } };
      const t = mkSvc({ rows: invited(), users: [{ _id: 'u1', email: 'ali@x.com', role: 'user', password: 'hash', isVerified: true }], wrongPassword: true, redis });
      for (let i = 0; i < 5; i++) await expect(t.svc.acceptWithExistingPassword(TOKEN, 'nope')).rejects.toThrow('Invalid email or password');
      expect(t.rows[0].status).toBe('invited');
      await expect(t.svc.acceptWithExistingPassword(TOKEN, 'nope')).rejects.toMatchObject({ status: 429 });
      expect(t.auth.login).toHaveBeenCalledTimes(5);
    });

    it('existing account that has no password (Google), no account at all, or the store owner is refused', async () => {
      const social = mkSvc({ rows: invited(), users: [{ _id: 'u1', email: 'ali@x.com', role: 'user', password: undefined, isVerified: true }] });
      await expect(social.svc.acceptWithExistingPassword(TOKEN, 'x')).rejects.toBeInstanceOf(BadRequestException);
      await expect(mkSvc({ rows: invited() }).svc.acceptWithExistingPassword(TOKEN, 'x')).rejects.toBeInstanceOf(NotFoundException);
      const ownerAcc = mkSvc({ rows: invited(), store: { sellerId: 'u1' }, users: [{ _id: 'u1', email: 'ali@x.com', role: 'user', password: 'h', isVerified: true }] });
      await expect(ownerAcc.svc.acceptWithExistingPassword(TOKEN, 'x')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('switchTo: active member gets a store token; no audit entry = no token; suspended / expired / not a member refused', async () => {
    const row = { _id: 'm1', storeId: 'st1', email: 'ali@x.com', userId: 'u1', roleKey: 'manager', permissionsAdd: [], permissionsRemove: [], status: 'active', name: 'Ali' };
    const ok = mkSvc({ rows: [{ ...row }] });
    const s = await ok.svc.switchTo({ userId: 'u1', email: 'ali@x.com', role: 'user' }, 'st1');
    expect(s.accessToken).toBe('tok'); expect(s.permissions).toContain('products.manage'); expect(s.permissions).not.toContain('finance');
    expect(ok.auth.issueMemberSession).toHaveBeenCalledWith(expect.objectContaining({ tokenVersion: 4 }), 'st1', 'm1');
    const noAudit = mkSvc({ rows: [{ ...row }], logOk: false });
    await expect(noAudit.svc.switchTo({ userId: 'u1', email: 'ali@x.com', role: 'user' }, 'st1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(noAudit.auth.issueMemberSession).not.toHaveBeenCalled();
    const susp = mkSvc({ rows: [{ ...row, status: 'suspended' }] });
    await expect(susp.svc.switchTo({ userId: 'u1', email: 'ali@x.com', role: 'user' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    const expired = mkSvc({ rows: [{ ...row, accessExpiresAt: new Date(Date.now() - 1000) }] });
    await expect(expired.svc.switchTo({ userId: 'u1', email: 'ali@x.com', role: 'user' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ok.svc.switchTo({ userId: 'zz', email: 'zz@x.com', role: 'user' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ok.svc.switchTo({ userId: 'u1', email: 'ali@x.com', role: 'user', actAs: 'collaborator' }, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accessFor ends the session when the member is removed, the store is suspended, or the owner changed', async () => {
    const row = { _id: 'm1', storeId: 'st1', email: 'ali@x.com', roleKey: 'manager', permissionsAdd: [], permissionsRemove: [], status: 'active' };
    expect((await mkSvc({ rows: [{ ...row }] }).svc.accessFor('m1', 'st1', 'own1')).active).toBe(true);
    expect((await mkSvc({ rows: [{ ...row, status: 'removed' }] }).svc.accessFor('m1', 'st1', 'own1')).active).toBe(false);
    expect((await mkSvc({ rows: [{ ...row }], store: { status: 'suspended' } }).svc.accessFor('m1', 'st1', 'own1')).active).toBe(false);
    expect((await mkSvc({ rows: [{ ...row }] }).svc.accessFor('m1', 'st1', 'someone-else')).active).toBe(false);
  });

  it('a suspend on server A reaches server B at once through the shared Redis marker (no 30 s wait)', async () => {
    const kv = new Map<string, string>();
    const redis: any = { isConnected: true, get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => { kv.set(k, v); } };
    const rows: any[] = [{ _id: 'm1', storeId: 'st1', email: 'ali@x.com', roleKey: 'manager', permissionsAdd: [], permissionsRemove: [], status: 'active' }];
    const a = mkSvc({ rows, redis }).svc; const b = mkSvc({ rows, redis }).svc;
    expect((await b.accessFor('m1', 'st1', 'own1')).active).toBe(true); // B cache warm
    expect((await a.accessFor('m1', 'st1', 'own1')).active).toBe(true);
    await a.setSuspended(owner, 'st1', 'm1', true);
    expect((await a.accessFor('m1', 'st1', 'own1')).active).toBe(false);
    expect((await b.accessFor('m1', 'st1', 'own1')).active).toBe(false); // B notices the new revision immediately
    await a.setSuspended(owner, 'st1', 'm1', false);
    expect((await b.accessFor('m1', 'st1', 'own1')).active).toBe(true);
  });

  it('without Redis a server still refreshes after its own change (cache cleared) and otherwise uses the 30 s cache', async () => {
    const rows: any[] = [{ _id: 'm1', storeId: 'st1', email: 'ali@x.com', roleKey: 'manager', permissionsAdd: [], permissionsRemove: [], status: 'active' }];
    const a = mkSvc({ rows }).svc;
    expect((await a.accessFor('m1', 'st1', 'own1')).active).toBe(true);
    await a.setSuspended(owner, 'st1', 'm1', true);
    expect((await a.accessFor('m1', 'st1', 'own1')).active).toBe(false);
  });

  it('suspend then resume works only from the right state; remove ends access and clears the cache', async () => {
    const t = mkSvc({ rows: [{ _id: 'm1', storeId: 'st1', email: 'ali@x.com', roleKey: 'viewer', status: 'active' }] });
    await t.svc.setSuspended(owner, 'st1', 'm1', true);
    expect(t.rows[0].status).toBe('suspended');
    await expect(t.svc.setSuspended(owner, 'st1', 'm1', true)).rejects.toBeInstanceOf(BadRequestException);
    await t.svc.setSuspended(owner, 'st1', 'm1', false);
    expect(t.rows[0].status).toBe('active');
    await t.svc.remove(owner, 'st1', 'm1');
    expect(t.rows[0].status).toBe('removed');
  });

  it('admin removal is audited and the owner is told', async () => {
    const t = mkSvc({ rows: [{ _id: 'm1', storeId: 'st1', email: 'ali@x.com', roleKey: 'viewer', status: 'active' }] });
    await t.svc.adminRemove('adm1', 'st1', 'm1');
    expect(t.activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'store_member_removed_by_admin', actorId: 'adm1', actorRole: 'admin' }));
    expect(t.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'store_member_removed', recipientId: 'own1' }));
  });
});
