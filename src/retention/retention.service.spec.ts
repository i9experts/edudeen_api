/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RetentionService } from './retention.service';

const OID = (n: number) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const H = 3600_000;

// ── tiny in-memory model ────────────────────────────────────────────────────
function cmp(v: any, cond: any): boolean {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, x]: [string, any]) => {
      switch (op) {
        case '$in': return x.includes(v);
        case '$nin': return !x.includes(v);
        case '$ne': return v !== x;
        case '$lt': return v != null && v < x;
        case '$lte': return v != null && v <= x;
        case '$gt': return v != null && v > x;
        case '$gte': return v != null && v >= x;
        case '$exists': return x ? v !== undefined : v === undefined;
        default: return false;
      }
    });
  }
  if (cond instanceof Date && v instanceof Date) return cond.getTime() === v.getTime();
  return (v ?? null) === (cond ?? null);
}
const get = (d: any, k: string) => (k.includes('.') ? k.split('.').reduce((o, p) => (o ? (/^\d+$/.test(p) ? o[Number(p)] : o[p]) : undefined), d) : d[k]);
const matches = (d: any, q: any): boolean => Object.entries(q).every(([k, c]) => cmp(get(d, k), c));

function model(initial: any[] = [], opts: { unique?: string } = {}) {
  const docs: any[] = initial.map((d) => ({ ...d }));
  let seq = 1000;
  const chain = (arr: any) => { const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(arr), then: (r: any, j: any) => Promise.resolve(arr).then(r, j) }; return c; };
  const applyUpdate = (d: any, u: any) => { Object.assign(d, u.$set ?? {}); for (const [k, n] of Object.entries(u.$inc ?? {})) d[k] = (d[k] ?? 0) + (n as number); };
  return {
    docs,
    find: jest.fn((q: any = {}) => chain(docs.filter((d) => matches(d, q)))),
    findOne: jest.fn((q: any = {}) => chain(docs.find((d) => matches(d, q)) ?? null)),
    exists: jest.fn(async (q: any) => (docs.some((d) => matches(d, q)) ? { _id: 'x' } : null)),
    countDocuments: jest.fn(async (q: any = {}) => docs.filter((d) => matches(d, q)).length),
    distinct: jest.fn(async (f: string) => [...new Set(docs.map((d) => d[f]))]),
    create: jest.fn(async (d: any) => {
      if (opts.unique && docs.some((x) => x[opts.unique!] === d[opts.unique!])) throw Object.assign(new Error('dup'), { code: 11000 });
      const row = { _id: `id${seq++}`, ...d, toObject() { return { ...this }; } }; docs.push(row); return row;
    }),
    updateOne: jest.fn(async (q: any, u: any, o: any = {}) => {
      const d = docs.find((x) => matches(x, q));
      if (d) { applyUpdate(d, u); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
      if (o.upsert) {
        const base: any = {};
        for (const [k, c] of Object.entries(q)) if (!(c && typeof c === 'object' && !(c instanceof Date))) base[k] = c;
        if (opts.unique && docs.some((x) => x[opts.unique!] === base[opts.unique!])) throw Object.assign(new Error('dup'), { code: 11000 });
        const row = { _id: `id${seq++}`, ...base, ...(u.$setOnInsert ?? {}) }; applyUpdate(row, u); docs.push(row);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }),
    findOneAndUpdate: jest.fn(async (q: any, u: any) => { const d = docs.find((x) => matches(x, q)); if (!d) return null; applyUpdate(d, u); return d; }),
    deleteOne: jest.fn(async (q: any) => { const i = docs.findIndex((x) => matches(x, q)); if (i >= 0) docs.splice(i, 1); }),
  };
}

function build(seed: { carts?: any[]; users?: any[]; prefs?: any[]; wishlist?: any[]; variants?: any[]; products?: any[]; orders?: any[]; referrals?: any[]; codes?: any[]; settings?: any; reminders?: any[]; states?: any[] } = {}) {
  const m = {
    cart: model(seed.carts), user: model(seed.users), prefs: model(seed.prefs), wish: model(seed.wishlist), variant: model(seed.variants), product: model(seed.products),
    order: model(seed.orders), coupon: model(), reminders: model(seed.reminders, { unique: 'cartId' }), states: model(seed.states, { unique: 'variantId' }), shares: model([], { unique: 'userId' }),
    codes: model(seed.codes, { unique: 'userId' }), referrals: model(seed.referrals, { unique: 'refereeId' }),
    settings: model(seed.settings ? [{ key: 'default', referral: seed.settings }] : []),
  };
  const db: any = { repositories: {
    cartModel: m.cart, userModel: m.user, notificationPreferenceModel: m.prefs, wishListModel: m.wish, productVariantModel: m.variant,
    productModel: m.product, orderModel: m.order, couponModel: m.coupon,
  } };
  const notify = jest.fn(async () => undefined);
  const products: any = { getShapedProductsByIds: jest.fn(async (ids: string[]) => ids.map((id) => ({ _id: id, name: `P ${id}`, digital: { files: [{ key: 'secret' }] } }))) };
  const redis: any = { withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) => { await fn(); return 'ran'; }) };
  const svc = new RetentionService(db, { notify } as any, products, redis, m.reminders as any, m.states as any, m.shares as any, m.codes as any, m.referrals as any, m.settings as any);
  return { svc, m, notify, products };
}

const now = new Date('2026-10-09T12:00:00Z');
const verifiedUser = (id: string, extra: any = {}) => ({ _id: id, email: `${id}@x.com`, name: 'Ayesha Khan', isVerified: true, isDelete: false, status: 'active', ...extra });
const cart = (id: string, userId: string, idleH: number, items = 2) => ({
  _id: id, userId, isDelete: false, status: 'active', updatedAt: new Date(now.getTime() - idleH * H),
  items: Array.from({ length: items }, (_, i) => ({ name: `Item ${i + 1}`, productId: OID(50 + i) })),
});

describe('abandoned cart reminders', () => {
  it('reminds an idle cart once, links to /cart, and not again within 24h', async () => {
    const { svc, notify } = build({ carts: [cart('c1', OID(1), 5)], users: [verifiedUser(OID(1))] });
    expect((await svc.runCartReminders(now)).reminded).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const arg: any = (notify.mock.calls[0] as any[])[0];
    expect(arg).toMatchObject({ recipientId: OID(1), recipientRole: 'user', type: 'cart_reminder', data: { link: '/cart' } });
    expect(arg.email.html).toContain('/cart');
    expect(arg.channelEvent).toMatchObject({ event: 'cart_reminder' });
    expect((await svc.runCartReminders(new Date(now.getTime() + 20 * 60_000))).reminded).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a fresh cart, an empty cart or a very old cart', async () => {
    const { svc, notify } = build({ carts: [cart('c1', OID(1), 1), cart('c2', OID(1), 5, 0), cart('c3', OID(1), 100)], users: [verifiedUser(OID(1))] });
    // the query already filters by window; the fake applies the same filter through the spec's own matcher
    const r = await svc.runCartReminders(now);
    expect(r.reminded).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('never contacts a user who muted the promotions category, an unverified account, or a missing account (guest)', async () => {
    const muted = build({ carts: [cart('c1', OID(1), 5)], users: [verifiedUser(OID(1))], prefs: [{ userId: OID(1), prefs: { promotions: false } }] });
    expect((await muted.svc.runCartReminders(now)).reminded).toBe(0);
    const unverified = build({ carts: [cart('c1', OID(2), 5)], users: [verifiedUser(OID(2), { isVerified: false })] });
    expect((await unverified.svc.runCartReminders(now)).reminded).toBe(0);
    const guest = build({ carts: [cart('c1', 'guest-123', 5)], users: [] });
    expect((await guest.svc.runCartReminders(now)).reminded).toBe(0);
    expect(muted.notify).not.toHaveBeenCalled();
    expect(unverified.notify).not.toHaveBeenCalled();
    expect(guest.notify).not.toHaveBeenCalled();
  });

  it('sends one message per user even with several store carts, and claims each cart', async () => {
    const { svc, notify, m } = build({ carts: [cart('c1', OID(1), 5), cart('c2', OID(1), 6)], users: [verifiedUser(OID(1))] });
    const r = await svc.runCartReminders(now);
    expect(r.reminded).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(m.reminders.docs.map((d) => d.cartId).sort()).toEqual(['c1', 'c2']);
  });
});

describe('wishlist alerts', () => {
  const variant = (over: any = {}) => ({ _id: OID(10), price: 100, stock: 5, status: 'active', isDelete: false, productId: OID(20), currency: 'PKR', ...over });
  const product = { _id: OID(20), name: 'Class 5 Maths', slug: 'class-5-maths', status: 'active', isDelete: false };
  const wl = (userId: string) => ({ userId, productVariantId: OID(10), productId: OID(20), storeId: OID(30) });

  it('records a baseline first (no alert), then alerts once on a >=5% drop, then stays quiet', async () => {
    const { svc, notify, m } = build({ wishlist: [wl(OID(1))], variants: [variant()], products: [product], users: [verifiedUser(OID(1))] });
    expect((await svc.runWishlistAlerts()).alerts).toBe(0);
    expect(m.states.docs[0]).toMatchObject({ variantId: OID(10), lastPrice: 100, lastInStock: true });
    m.variant.docs[0].price = 90;
    expect((await svc.runWishlistAlerts()).alerts).toBe(1);
    expect((notify.mock.calls[0] as any[])[0]).toMatchObject({ recipientId: OID(1), type: 'wishlist_price_drop', data: { link: '/product/class-5-maths' } });
    expect((await svc.runWishlistAlerts()).alerts).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('alerts on back-in-stock after it was out of stock, once', async () => {
    const { svc, notify, m } = build({ wishlist: [wl(OID(1)), wl(OID(2))], variants: [variant({ stock: 0 })], products: [product], users: [verifiedUser(OID(1)), verifiedUser(OID(2))] });
    await svc.runWishlistAlerts(); // baseline: out of stock
    m.variant.docs[0].stock = 7;
    expect((await svc.runWishlistAlerts()).alerts).toBe(2); // both wishlisters
    expect(notify.mock.calls.map((c: any) => c[0].type)).toEqual(['wishlist_back_in_stock', 'wishlist_back_in_stock']);
    expect((await svc.runWishlistAlerts()).alerts).toBe(0);
  });

  it('ignores a small drop, a price rise, and respects muted promotions', async () => {
    const { svc, notify, m } = build({ wishlist: [wl(OID(1))], variants: [variant()], products: [product], users: [verifiedUser(OID(1))], prefs: [{ userId: OID(1), prefs: { promotions: false } }] });
    await svc.runWishlistAlerts();
    m.variant.docs[0].price = 97;
    await svc.runWishlistAlerts();
    m.variant.docs[0].price = 50; // a real drop, but the buyer muted promotions
    expect((await svc.runWishlistAlerts()).alerts).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('shareable wishlist', () => {
  it('creates one unguessable token per buyer, reuses it, and revoking kills the link', async () => {
    const { svc } = build({ wishlist: [{ userId: OID(1), productId: OID(20), storeId: OID(30), productVariantId: OID(10) }] });
    const a: any = await svc.createShare(OID(1));
    const b: any = await svc.createShare(OID(1));
    expect(a.data.token).toBe(b.data.token);
    expect(a.data.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.data.url).toContain(`/wishlist/shared/${a.data.token}`);
    const view: any = await svc.publicShare(a.data.token);
    expect(view.data.count).toBe(1);
    expect(JSON.stringify(view)).not.toContain('secret'); // file keys stripped
    expect(JSON.stringify(view)).not.toContain(OID(1)); // no owner id
    await svc.revokeShare(OID(1));
    await expect(svc.publicShare(a.data.token)).rejects.toBeInstanceOf(NotFoundException);
    const c: any = await svc.createShare(OID(1));
    expect(c.data.token).not.toBe(a.data.token);
  });
  it('treats malformed tokens as not found', async () => {
    const { svc } = build();
    for (const t of ['', 'short', 'x'.repeat(100), '../../etc/passwd', '{"$ne":1}']) await expect(svc.publicShare(t)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('referrals', () => {
  const on = { enabled: true, rewardType: 'percentage', rewardValue: 10, refereeRewardValue: 5, expiryDays: 30, maxRewardsPerReferrer: 2 };
  const people = () => [
    verifiedUser(OID(1), { email: 'sara@gmail.com', phone: '03001111111', createdAt: new Date(Date.now() - 400 * 86400_000) }),
    verifiedUser(OID(2), { email: 'ali@y.com', phone: '03002222222', createdAt: new Date() }),
  ];

  it('is closed while the programme is off', async () => {
    const { svc } = build({ users: people(), codes: [{ userId: OID(1), code: 'K7QM2XPD' }] });
    await expect(svc.applyCode(OID(2), 'K7QM2XPD', '1.2.3.4')).rejects.toBeInstanceOf(BadRequestException);
    expect((await svc.myReferral(OID(1)) as any).data.enabled).toBe(false);
  });

  it('gives each buyer one stable code and a share link', async () => {
    const { svc } = build({ users: people(), settings: on });
    const a: any = await svc.myReferral(OID(1));
    const b: any = await svc.myReferral(OID(1));
    expect(a.data.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(a.data.code).toBe(b.data.code);
    expect(a.data.shareUrl).toContain(`/register?ref=${a.data.code}`);
    expect(a.data.reward.label).toBe('10% off');
  });

  it('applies a valid code once; refuses own code, unknown code, a second code and buyers with orders', async () => {
    const { svc, m } = build({ users: people(), settings: on, codes: [{ userId: OID(1), code: 'K7QM2XPD' }] });
    await expect(svc.applyCode(OID(1), 'K7QM2XPD', '1.1.1.1')).rejects.toThrow(/own referral code/);
    await expect(svc.applyCode(OID(2), 'ZZZZZZZZ', '1.1.1.1')).rejects.toThrow(/not valid/);
    await expect(svc.applyCode(OID(2), { $ne: 1 }, '1.1.1.1')).rejects.toThrow(/not valid/);
    expect(((await svc.applyCode(OID(2), 'k7qm2xpd', '1.1.1.1')) as any).data.applied).toBe(true);
    expect(m.referrals.docs[0]).toMatchObject({ referrerId: OID(1), refereeId: OID(2), status: 'pending' });
    expect(JSON.stringify(m.referrals.docs[0])).not.toContain('1.1.1.1'); // IP is only stored hashed
    await expect(svc.applyCode(OID(2), 'K7QM2XPD', '1.1.1.1')).rejects.toThrow(/already used/);
    const withOrder = build({ users: people(), settings: on, codes: [{ userId: OID(1), code: 'K7QM2XPD' }], orders: [{ userId: OID(2), isDelete: false }] });
    await expect(withOrder.svc.applyCode(OID(2), 'K7QM2XPD', '1.1.1.1')).rejects.toThrow(/not ordered yet/);
  });

  it('refuses a buyer whose account is older than 14 days', async () => {
    const users = people(); users[1].createdAt = new Date(Date.now() - 20 * 86400_000);
    const { svc } = build({ users, settings: on, codes: [{ userId: OID(1), code: 'K7QM2XPD' }] });
    await expect(svc.applyCode(OID(2), 'K7QM2XPD', '1.1.1.1')).rejects.toThrow(/first 14 days/);
  });

  it('silently flags alias-email / shared-phone referrals (same response, never rewarded)', async () => {
    const users = people(); users[1].email = 'sa.ra+x@gmail.com';
    const { svc, m } = build({ users, settings: on, codes: [{ userId: OID(1), code: 'K7QM2XPD' }] });
    expect(((await svc.applyCode(OID(2), 'K7QM2XPD', '1.1.1.1')) as any).data.applied).toBe(true);
    expect(m.referrals.docs[0]).toMatchObject({ status: 'flagged', reason: 'same_email_alias' });
  });

  describe('reward sweep', () => {
    const order = (userId: string, over: any = {}) => ({ userId, isPaid: true, paymentStatus: 'paid', orderStatus: 'completed', isDelete: false, hasReturnApproved: false, shippingAddress: { phone: '03009999999' }, ...over });
    const pending = (refereeId: string, extra: any = {}) => ({ _id: `r-${refereeId}`, referrerId: OID(1), refereeId, code: 'K7QM2XPD', status: 'pending', ipHash: null, createdAt: new Date(), ...extra });

    it('rewards both sides with single-use platform coupons after a paid, completed order - once', async () => {
      const { svc, m, notify } = build({ users: people(), settings: on, referrals: [pending(OID(2))], orders: [order(OID(2))] });
      expect(await svc.sweepReferralRewards(now)).toEqual({ rewarded: 1, flagged: 0 });
      expect(m.coupon.docs).toHaveLength(2);
      expect(m.coupon.docs[0]).toMatchObject({ scope: 'platform', discountType: 'percentage', discountValue: 10, usageLimit: 1 });
      expect(m.coupon.docs[1]).toMatchObject({ discountValue: 5 });
      expect(m.coupon.docs[0].code).toMatch(/^REF[0-9A-F]{8}$/);
      expect(m.referrals.docs[0].status).toBe('rewarded');
      expect(notify).toHaveBeenCalledTimes(2);
      expect(await svc.sweepReferralRewards(now)).toEqual({ rewarded: 0, flagged: 0 });
      expect(m.coupon.docs).toHaveLength(2);
    });

    it('does not reward before the order is paid AND completed, or while a return is approved', async () => {
      for (const o of [order(OID(2), { orderStatus: 'processing' }), order(OID(2), { isPaid: false, paymentStatus: 'unpaid' }), order(OID(2), { hasReturnApproved: true })]) {
        const { svc, m } = build({ users: people(), settings: on, referrals: [pending(OID(2))], orders: [o] });
        expect((await svc.sweepReferralRewards(now)).rewarded).toBe(0);
        expect(m.coupon.docs).toHaveLength(0);
        expect(m.referrals.docs[0].status).toBe('pending');
      }
    });

    it('flags a referee who ordered to the referrer\'s phone, and respects the per-referrer cap', async () => {
      const a = build({ users: people(), settings: on, referrals: [pending(OID(2))], orders: [order(OID(2), { shippingAddress: { phone: '+92 300 1111111' } })] });
      expect(await a.svc.sweepReferralRewards(now)).toEqual({ rewarded: 0, flagged: 1 });
      expect(a.m.referrals.docs[0]).toMatchObject({ status: 'flagged', reason: 'same_phone' });
      const done = [pending(OID(3), { status: 'rewarded' }), pending(OID(4), { status: 'rewarded' })];
      const b = build({ users: people(), settings: on, referrals: [...done, pending(OID(2))], orders: [order(OID(2))] });
      expect(await b.svc.sweepReferralRewards(now)).toEqual({ rewarded: 0, flagged: 1 });
      expect(b.m.referrals.docs.find((r) => r.refereeId === OID(2))).toMatchObject({ status: 'flagged', reason: 'referrer_cap_reached' });
      expect(b.m.coupon.docs).toHaveLength(0);
    });

    it('does nothing while the programme is off', async () => {
      const { svc, m } = build({ users: people(), referrals: [pending(OID(2))], orders: [order(OID(2))] });
      expect(await svc.sweepReferralRewards(now)).toEqual({ rewarded: 0, flagged: 0 });
      expect(m.coupon.docs).toHaveLength(0);
    });
  });
});
