/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { PremiumService } from './premium.service';
import { PremiumEntitlementsService } from './premium-entitlements.service';
import { ChildrenService } from '../children/children.service';
import { MarketingService } from '../marketing/marketing.service';
import { ContactService } from '../contact/contact.service';

const DAY = 86_400_000;
const lean = (v: any) => ({ lean: async () => v, select: () => ({ lean: async () => v }), sort: () => ({ limit: () => ({ lean: async () => v }) }) });
const PLAN = { _id: 'plan1', name: 'Premium', monthlyPriceUSD: 5, yearlyPriceUSD: null, isActive: true, benefits: { childrenLimit: 15, earlyAccessHours: 2, monthlyCouponValue: 10, monthlyCouponType: 'percentage', prioritySupport: true } };

function svcWith(over: any = {}) {
  const membershipModel: any = { findOne: jest.fn(() => lean(null)), findOneAndUpdate: jest.fn(), find: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) , ...over.membershipModel };
  const paymentModel: any = { findOneAndUpdate: jest.fn(), findById: jest.fn(), updateOne: jest.fn().mockResolvedValue({}), findOne: jest.fn(), ...over.paymentModel };
  const planModel: any = { findById: jest.fn(() => lean(PLAN)), ...over.planModel };
  const couponIssueModel: any = { create: jest.fn().mockResolvedValue({}), deleteOne: jest.fn().mockResolvedValue({}), ...over.couponIssueModel };
  const couponModel: any = { create: jest.fn().mockResolvedValue({}) };
  const entitlements: any = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const notify = jest.fn().mockResolvedValue(undefined);
  const svc: any = Object.create(PremiumService.prototype);
  Object.assign(svc, {
    logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    db: { repositories: { couponModel, userModel: { findById: jest.fn(() => lean({ email: 'a@b.c', isVerified: true })) } } },
    membershipModel, paymentModel, planModel, couponIssueModel, entitlements,
    notifications: { notify },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });
  return { svc: svc as PremiumService & Record<string, any>, membershipModel, paymentModel, couponIssueModel, couponModel, entitlements, notify };
}

describe('activate - extends a running period, starts fresh otherwise', () => {
  it('extends from the current period end when still active', async () => {
    const end = new Date(Date.now() + 10 * DAY);
    const { svc, membershipModel, entitlements } = svcWith({ membershipModel: { findOne: jest.fn(() => lean({ status: 'active', currentPeriodEnd: end, startedAt: new Date('2026-01-01') })), findOneAndUpdate: jest.fn(() => lean({ userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } })) } });
    await svc.activate('u1', PLAN, 'monthly', 'bank_transfer');
    const $set = membershipModel.findOneAndUpdate.mock.calls[0][1].$set;
    const expected = new Date(end); expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect($set.currentPeriodEnd.getUTCMonth()).toBe(expected.getUTCMonth());
    expect($set.currentPeriodEnd.getTime()).toBeGreaterThan(end.getTime() + 27 * DAY);
    expect($set.status).toBe('active');
    expect($set.startedAt).toEqual(new Date('2026-01-01'));
    expect(entitlements.invalidate).toHaveBeenCalledWith('u1');
  });
  it('starts from now when expired and snapshots the plan benefits', async () => {
    const { svc, membershipModel } = svcWith({ membershipModel: { findOne: jest.fn(() => lean({ status: 'expired', currentPeriodEnd: new Date(Date.now() - 5 * DAY) })), findOneAndUpdate: jest.fn(() => lean({ userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } })) } });
    await svc.activate('u1', PLAN, 'yearly', 'admin_grant');
    const $set = membershipModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect($set.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    expect($set.planSnapshot).toMatchObject({ name: 'Premium', benefits: { childrenLimit: 15, earlyAccessHours: 2 } });
    expect($set.source).toBe('admin_grant');
  });
});

describe('monthly coupon', () => {
  const member = { userId: 'u1', planSnapshot: PLAN };
  it('issues a personal, single-use, PLATFORM-FUNDED coupon once per month', async () => {
    const { svc, couponModel, couponIssueModel } = svcWith();
    const code = await svc.issueMonthlyCoupon('u1', member, new Date('2026-10-13T00:00:00Z'));
    expect(code).toMatch(/^PRM[0-9A-F]{8}$/);
    expect(couponIssueModel.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', month: '2026-10' }));
    expect(couponModel.create).toHaveBeenCalledWith(expect.objectContaining({ scope: 'platform', ownerUserId: 'u1', platformFunded: true, usageLimit: 1, discountType: 'percentage', discountValue: 10 }));
  });
  it('a second run in the same month issues nothing (unique ledger row)', async () => {
    const { svc, couponModel } = svcWith({ couponIssueModel: { create: jest.fn().mockRejectedValue({ code: 11000 }) } });
    expect(await svc.issueMonthlyCoupon('u1', member, new Date('2026-10-20T00:00:00Z'))).toBeNull();
    expect(couponModel.create).not.toHaveBeenCalled();
  });
  it('no coupon configured = nothing issued; a failed coupon insert frees the ledger so the next run retries', async () => {
    const none = svcWith();
    expect(await none.svc.issueMonthlyCoupon('u1', { userId: 'u1', planSnapshot: { benefits: { monthlyCouponValue: 0 } } })).toBeNull();
    const failing = svcWith();
    failing.couponModel.create.mockRejectedValue(new Error('db'));
    await expect(failing.svc.issueMonthlyCoupon('u1', member)).rejects.toThrow('db');
    expect(failing.couponIssueModel.deleteOne).toHaveBeenCalled();
  });
});

describe('lifecycle cron', () => {
  it('expires memberships past their period (cancel-at-period-end -> cancelled), invalidates the cache and notifies once', async () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const due = [{ _id: 'm1', userId: 'u1', cancelAtPeriodEnd: false }, { _id: 'm2', userId: 'u2', cancelAtPeriodEnd: true }];
    const find = jest.fn()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => due }) })
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) });
    const { svc, membershipModel, entitlements, notify } = svcWith({ membershipModel: { find, findOneAndUpdate: jest.fn().mockResolvedValue({}) } });
    const r = await svc.runLifecycle(now);
    expect(r.expired).toBe(2);
    expect(membershipModel.findOneAndUpdate.mock.calls.map((c: any) => c[1].$set.status)).toEqual(['expired', 'cancelled']);
    expect(entitlements.invalidate).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('sends the 3-day reminder once per period (skips when already notified for that end date)', async () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const end = new Date(now.getTime() + 2 * DAY);
    const find = jest.fn()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) })
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [{ _id: 'a', userId: 'u1', currentPeriodEnd: end, expiringNotifiedFor: null }, { _id: 'b', userId: 'u2', currentPeriodEnd: end, expiringNotifiedFor: end }] }) });
    const { svc, notify } = svcWith({ membershipModel: { find, findOneAndUpdate: jest.fn().mockResolvedValue({}) } });
    const r = await svc.runLifecycle(now);
    expect(r.reminded).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('admin approval of a premium bank-transfer payment', () => {
  it('only a payment under review can be approved (atomic claim)', async () => {
    const { svc } = svcWith({ paymentModel: { findOneAndUpdate: jest.fn(() => lean(null)), findById: jest.fn(() => ({ select: () => lean({ status: 'approved' }) })) } });
    await expect(svc.adminApprove('adm', '64b000000000000000000001')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('approving activates the membership for the purchased interval', async () => {
    const claimed = { _id: 'pay1', userId: 'u1', planId: 'plan1', interval: 'monthly', amountUSD: 5 };
    const { svc, paymentModel } = svcWith({ paymentModel: { findOneAndUpdate: jest.fn(() => lean(claimed)), updateOne: jest.fn().mockResolvedValue({}) } });
    const activate = jest.spyOn(svc as any, 'activate').mockResolvedValue({ currentPeriodEnd: new Date('2026-11-13') });
    const r = await svc.adminApprove('adm', '64b000000000000000000001');
    expect(activate).toHaveBeenCalledWith('u1', PLAN, 'monthly', 'bank_transfer');
    expect(r.success).toBe(true);
    expect(paymentModel.updateOne).not.toHaveBeenCalled();
  });
  it('if activation fails the claim is released so the payment can be retried', async () => {
    const claimed = { _id: 'pay1', userId: 'u1', planId: 'plan1', interval: 'monthly', amountUSD: 5 };
    const { svc, paymentModel } = svcWith({ paymentModel: { findOneAndUpdate: jest.fn(() => lean(claimed)), updateOne: jest.fn().mockResolvedValue({}) } });
    jest.spyOn(svc as any, 'activate').mockRejectedValue(new Error('boom'));
    await expect(svc.adminApprove('adm', '64b000000000000000000001')).rejects.toBeInstanceOf(BadRequestException);
    expect(paymentModel.updateOne).toHaveBeenCalledWith({ _id: '64b000000000000000000001', status: 'approved' }, { $set: expect.objectContaining({ status: 'pending' }) });
  });
});

describe('PremiumEntitlementsService', () => {
  const make = (membership: any, cached: string | null = null) => {
    const redis: any = { get: jest.fn().mockResolvedValue(cached), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) };
    const model: any = { findOne: jest.fn(() => lean(membership)) };
    return { svc: new PremiumEntitlementsService({ repositories: {} } as any, redis, model), redis, model };
  };
  it('non-member / anonymous: standard limits, nothing cached for anonymous', async () => {
    const { svc, redis } = make(null);
    expect(await svc.getEntitlements('u1')).toEqual({ isPremium: false, childrenLimit: 8, earlyAccessHours: 0, prioritySupport: false });
    expect((await svc.getEntitlements(null)).isPremium).toBe(false);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
  it('active member: plan-snapshot benefits, cached ~60s; invalidate drops the cache', async () => {
    const { svc, redis, model } = make({ status: 'active', planSnapshot: { benefits: { childrenLimit: 20, earlyAccessHours: 4, prioritySupport: true } } });
    const e = await svc.getEntitlements('u1');
    expect(e).toEqual({ isPremium: true, childrenLimit: 20, earlyAccessHours: 4, prioritySupport: true });
    expect(redis.set).toHaveBeenCalledWith('premium:ent:u1', expect.any(String), 60);
    expect(model.findOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', status: 'active', currentPeriodEnd: expect.any(Object) }));
    await svc.invalidate('u1');
    expect(redis.del).toHaveBeenCalledWith('premium:ent:u1');
  });
  it('serves from the cache without hitting the database', async () => {
    const { svc, model } = make(null, JSON.stringify({ isPremium: true, childrenLimit: 15, earlyAccessHours: 2, prioritySupport: true }));
    expect((await svc.getEntitlements('u1')).isPremium).toBe(true);
    expect(model.findOne).not.toHaveBeenCalled();
  });
  it('decorateProducts (platform offer 5% on by default): teaser = seller% + platform% for everyone with the breakdown; member price from the LIST price; campaign + subscriber price hidden for a member', async () => {
    const products = [
      { _id: 'p1', storeId: 'A', variants: [{ price: 100 }] },
      { _id: 'p2', storeId: 'A', activeCampaign: { campaignId: 'c' }, variants: [{ price: 90, compareAtPrice: null, originalCompareAtPrice: 100, subscriberPrice: 85, discountPercent: 5 }] },
      { _id: 'p3', storeId: 'B', variants: [{ price: 100 }] },
      { _id: 'p4', storeId: 'A', premiumDiscountPercent: 15, variants: [{ price: 90, compareAtPrice: 100 }] },
    ];
    const settings = new Map<string, any>([['A', { premiumDiscount: { enabled: true, percent: 20 } }]]);
    const member = make({ status: 'active', planSnapshot: { benefits: {} } }).svc;
    const [a, b, c, d] = await member.decorateProducts(products as any, 'u1', { storeSettings: settings });
    expect(a).toMatchObject({ premiumPercent: 25, premiumSellerPercent: 20, premiumPlatformPercent: 5 });
    expect(a.variants[0] as any).toMatchObject({ premiumPrice: 75, listPrice: 100, premiumDiscountPercent: 25, premiumSellerPercent: 20, premiumPlatformPercent: 5 });
    // p2: the campaign markdown was hidden upstream (originalCompareAtPrice keeps LIST = 100): list 100 x 0.75 = 75; badge and subscriber price removed
    expect(b.activeCampaign).toBeNull();
    expect(b.variants[0] as any).toMatchObject({ premiumPrice: 75, listPrice: 100 });
    expect((b.variants[0] as any).subscriberPrice).toBeUndefined();
    expect(c.premiumPercent).toBeUndefined();
    // p4: seller 15 + platform 5 on a 10% normal sale -> 80 (normal buyer pays 90)
    expect(d.variants[0] as any).toMatchObject({ premiumPrice: 80, listPrice: 100, premiumDiscountPercent: 20 });
    const guest = make(null).svc;
    const [g, , , gd] = await guest.decorateProducts(products as any, null, { storeSettings: settings });
    expect(g.premiumPercent).toBe(25);
    expect(g.premiumSellerPercent).toBe(20);
    expect((g.variants[0] as any).premiumPrice).toBeUndefined();
    expect(gd.premiumPercent).toBe(20);
    expect((gd.variants[0] as any).compareAtPrice).toBe(100); // a guest keeps seeing the seller's normal sale
  });
  it('decorateProducts: a percentage campaign that beats premium keeps the campaign badge and offers no premium price; one that loses is replaced by premium', async () => {
    const mk = (pct: number) => ({ _id: 'p', storeId: 'A', activeCampaign: { campaignId: 'c', discountType: 'percentage', discountValue: pct }, variants: [{ price: 100, compareAtPrice: null, originalCompareAtPrice: null, campaignPrice: 100 - pct }] });
    const settings = new Map<string, any>([['A', { premiumDiscount: { enabled: true, percent: 20 } }]]);
    const member = make({ status: 'active', planSnapshot: { benefits: {} } }).svc;
    const [better, worse] = await member.decorateProducts([mk(40), mk(10)] as any, 'u1', { storeSettings: settings }); // premium = 25 (20 + 5)
    expect((better.variants[0] as any).premiumPrice).toBeUndefined();
    expect(better.activeCampaign).not.toBeNull();
    expect((worse.variants[0] as any).premiumPrice).toBe(75);
    expect(worse.activeCampaign).toBeNull();
  });  it('platform offer OFF: teaser and member price are seller-only', async () => {
    const { svc } = make({ status: 'active', planSnapshot: { benefits: {} } });
    (svc as any).settingsModel = { findOne: () => ({ lean: async () => ({ key: 'default', platformDiscount: { enabled: false, percent: 5 }, premiumSellerFeePercent: 5, minGapPercent: 5 }) }) };
    const [a] = await svc.decorateProducts([{ _id: 'p1', storeId: 'A', variants: [{ price: 100 }] }] as any, 'u1', { storeSettings: new Map([['A', { premiumDiscount: { enabled: true, percent: 20 } }]]) });
    expect(a).toMatchObject({ premiumPercent: 20, premiumPlatformPercent: 0 });
    expect(a.variants[0] as any).toMatchObject({ premiumPrice: 80 });
  });
  it('getSettings/getTerms: defaults when never saved; reads the saved row; a failing read falls back to defaults', async () => {
    const { svc } = make(null);
    expect(await svc.getTerms()).toEqual({ platformEnabled: true, platformPercent: 5, sellerFeePercent: 5, minGapPercent: 5 });
    const saved = new PremiumEntitlementsService({ repositories: {} } as any, {} as any, {} as any, { findOne: () => ({ lean: async () => ({ platformDiscount: { enabled: true, percent: 8 }, premiumSellerFeePercent: 3, minGapPercent: 2 }) }) } as any);
    expect(await saved.getTerms()).toEqual({ platformEnabled: true, platformPercent: 8, sellerFeePercent: 3, minGapPercent: 2 });
    const broken = new PremiumEntitlementsService({ repositories: {} } as any, {} as any, {} as any, { findOne: () => { throw new Error('db'); } } as any);
    expect((await broken.getTerms()).platformPercent).toBe(5);
  });
});

describe('admin settings + public terms (R4)', () => {
  function settingsSvc(row: any = null, fees: any = { digital: { mode: 'percentage', value: 10 }, physical: { mode: 'fixed', value: 1 } }) {
    const state: any = { row };
    const settingsModel: any = { findOneAndUpdate: jest.fn(async (_f: any, u: any) => { state.row = { ...state.row, ...u.$set }; return state.row; }) };
    const ent = new PremiumEntitlementsService({ repositories: {} } as any, {} as any, {} as any, { findOne: () => ({ lean: async () => state.row }) } as any);
    const log = jest.fn().mockResolvedValue(undefined);
    const svc: any = Object.create(PremiumService.prototype);
    Object.assign(svc, { entitlements: ent, settingsModel, activityLog: { log }, adminConfig: { getPlatformFees: jest.fn().mockResolvedValue(fees) }, exchangeRate: { getCurrentRate: jest.fn().mockResolvedValue({ ratePerUSD: 280 }) } });
    return { svc: svc as PremiumService, settingsModel, log, ent };
  }
  it('PUT validates, saves, invalidates the cache, and writes an audit log (before/after)', async () => {
    const { svc, settingsModel, log } = settingsSvc();
    const r: any = await svc.adminUpdateSettings('admin1', { platformDiscount: { enabled: false, percent: 7 }, premiumSellerFeePercent: 4 });
    expect(r.data).toMatchObject({ platformDiscount: { enabled: false, percent: 7 }, premiumSellerFeePercent: 4, minGapPercent: 5, effective: { platformPercent: 0, platformEnabled: false } });
    expect(settingsModel.findOneAndUpdate).toHaveBeenCalledWith({ key: 'default' }, expect.objectContaining({ $set: expect.objectContaining({ updatedByAdminId: 'admin1' }) }), expect.anything());
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'premium_settings_updated', actorId: 'admin1' }));
    expect((await svc.adminGetSettings() as any).data.platformDiscount).toEqual({ enabled: false, percent: 7 }); // cache invalidated
  });
  it('PUT rejects out-of-range values and saves nothing', async () => {
    const { svc, settingsModel } = settingsSvc();
    await expect(svc.adminUpdateSettings('a', { platformDiscount: { percent: 45 } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.adminUpdateSettings('a', { premiumSellerFeePercent: -1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(settingsModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('GET terms: effective platform %, premium fee, gap and the normal fee of the product type (fixed converted to PKR)', async () => {
    const { svc } = settingsSvc();
    const digital: any = await svc.getTerms('digital', 'PKR');
    expect(digital.data).toMatchObject({ platformDiscount: { enabled: true, percent: 5 }, platformPercent: 5, premiumSellerFeePercent: 5, minGapPercent: 5, normalFee: { type: 'digital', mode: 'percentage', value: 10 } });
    const physical: any = await svc.getTerms('physical', 'PKR');
    expect(physical.data.normalFee).toMatchObject({ type: 'physical', mode: 'fixed', value: 1, fixedAmountInCurrency: 280, currency: 'PKR' });
    expect(((await svc.getTerms('educational')) as any).data.normalFee.type).toBe('digital');
  });
  it('GET terms normalFee: platformFees set -> that value (source platform_fees); unset -> the commission rule of the store (source commission_rules)', async () => {
    const STORE = '64f0c0ffee0c0ffee0c0ff0a';
    const withFees = settingsSvc(null, { digital: { mode: 'percentage', value: 10 } });
    (withFees.svc as any).commissionRules = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.2, source: 'seller_override' }) };
    expect(((await withFees.svc.getTerms('digital', 'USD', STORE)) as any).data.normalFee).toMatchObject({ mode: 'percentage', value: 10, source: 'platform_fees' });
    const unset = settingsSvc(null, null);
    const resolveRate = jest.fn().mockResolvedValue({ rate: 0.1, source: 'seller_override' });
    (unset.svc as any).commissionRules = { resolveRate };
    expect(((await unset.svc.getTerms('digital', 'USD', STORE)) as any).data.normalFee).toMatchObject({ type: 'digital', mode: 'percentage', value: 10, source: 'commission_rules' });
    expect(resolveRate).toHaveBeenCalledWith(STORE);
  });
  it('GET terms normalFee is null (never a silent 0%) when no fee can be determined', async () => {
    const STORE = '64f0c0ffee0c0ffee0c0ff0a';
    const none = settingsSvc(null, null);
    (none.svc as any).commissionRules = { resolveRate: jest.fn().mockResolvedValue({ rate: 0, source: 'hardcoded_fallback' }) };
    expect(((await none.svc.getTerms('digital', 'USD', STORE)) as any).data.normalFee).toBeNull();
    expect(((await none.svc.getTerms('digital')) as any).data.normalFee).toBeNull();
  });
  it('GET terms with the platform offer off reports 0%', async () => {
    const { svc } = settingsSvc({ platformDiscount: { enabled: false, percent: 5 }, premiumSellerFeePercent: 5, minGapPercent: 5 });
    expect(((await svc.getTerms()) as any).data).toMatchObject({ platformPercent: 0, platformDiscount: { enabled: false, percent: 0 } });
  });
});
describe('wiring in other modules', () => {
  it('children: the member limit replaces 8; non-members keep 8', async () => {
    const model: any = { countDocuments: jest.fn().mockResolvedValue(8), create: jest.fn(async (d: any) => ({ toObject: () => d })) };
    const body = { name: 'Ali', educationLevel: 'primary_school', gradeLabel: 'class-3' };
    const member = new ChildrenService(model, { getEntitlements: jest.fn().mockResolvedValue({ childrenLimit: 15 }) } as any);
    await expect(member.create('u1', body as any)).resolves.toMatchObject({ success: true });
    const plain = new ChildrenService(model, { getEntitlements: jest.fn().mockResolvedValue({ childrenLimit: 8 }) } as any);
    await expect(plain.create('u1', body as any)).rejects.toThrow('You can save up to 8 children');
    const none = new ChildrenService(model);
    await expect(none.create('u1', body as any)).rejects.toThrow('You can save up to 8 children');
  });

  it('marketing: early access moves the campaign start boundary; non-premium callers are unchanged', async () => {
    const find = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
    const svc = new MarketingService({ repositories: { campaignModel: { find } } } as any, {} as any);
    await svc.getActiveCampaignsForStores(['A']);
    const plain = (find.mock.calls[0] as any[])[0].startDate.$lte as Date;
    await svc.getActiveCampaignsForStores(['A'], { earlyAccessHours: 2 });
    const early = (find.mock.calls[1] as any[])[0].startDate.$lte as Date;
    expect(early.getTime() - plain.getTime()).toBeGreaterThan(2 * 3_600_000 - 5000);
    expect(early.getTime() - plain.getTime()).toBeLessThan(2 * 3_600_000 + 5000);
  });

  it('marketing: a not-yet-started campaign is flagged earlyAccess only for the member view', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const row = { _id: 'c1', name: 'Sale', endDate: new Date(Date.now() + DAY), startDate: future, sponsorType: 'platform', discountType: 'percentage', discountValue: 10 };
    const find = jest.fn(() => ({ select: () => ({ lean: async () => [row] }) }));
    const svc = new MarketingService({ repositories: { campaignModel: { find } } } as any, {} as any);
    const map = await svc.getActiveCampaignsForStores(['A'], { earlyAccessHours: 2 });
    expect(map.get('A')![0].earlyAccess).toBe(true);
  });

  it('contact: only a SIGNED-IN premium member gets priority (a typed member email alone does not)', async () => {
    const create = jest.fn(async (d: any) => ({ ...d, name: 'N', email: d.email }));
    const model: any = { create, countDocuments: jest.fn().mockResolvedValue(1) };
    const mail: any = { sendMail: jest.fn().mockResolvedValue(undefined) };
    const dto: any = { name: 'N', email: 'M@x.com', topic: 't', message: 'hello' };
    const member: any = { getEntitlements: jest.fn().mockResolvedValue({ prioritySupport: true }) };
    const nonMember: any = { getEntitlements: jest.fn().mockResolvedValue({ prioritySupport: false }) };
    await new ContactService(model, mail, member).submit(dto, 'u1');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'm@x.com', priority: true }));
    await new ContactService(model, mail, member).submit(dto); // anonymous: not flagged even for a member's email
    expect(create.mock.calls[1][0]).not.toHaveProperty('priority');
    await new ContactService(model, mail, nonMember).submit(dto, 'u2');
    expect(create.mock.calls[2][0]).not.toHaveProperty('priority');
    await new ContactService(model, mail).submit(dto, 'u3');
    expect(create.mock.calls[3][0]).not.toHaveProperty('priority');
  });
});
