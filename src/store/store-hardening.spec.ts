/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StoreService } from './store.service';
import { sanitizeDigitalForPublicView, clampInt, queryString } from '../products/product-public-view.util';

const OID = '64f0c0ffee0c0ffee0c0ff01';

function make(over: { store?: any; repos?: any; entitled?: boolean } = {}) {
  const store = over.store === undefined ? undefined : over.store;
  const repos: any = {
    storeModel: {
      findOne: jest.fn().mockImplementation(() => {
        const r: any = Promise.resolve(store);
        r.lean = () => Promise.resolve(store);
        return r;
      }),
      exists: jest.fn().mockResolvedValue(true),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    },
    productModel: { exists: jest.fn().mockResolvedValue(null), find: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) },
    storeFollowerModel: { deleteOne: jest.fn(), create: jest.fn().mockResolvedValue({}) },
    ...over.repos,
  };
  const svc: any = Object.create(StoreService.prototype);
  svc.databaseService = { repositories: repos };
  svc.activityLogService = { log: jest.fn() };
  svc.marketingService = { getActiveCampaignsForStore: jest.fn().mockResolvedValue([]) };
  svc.entitlementsService = { assertFeatureAllowed: jest.fn().mockResolvedValue(undefined), getLimits: jest.fn().mockResolvedValue({ customDomainAllowed: over.entitled ?? true }) };
  svc.notificationsService = { notify: jest.fn().mockResolvedValue(undefined) };
  svc.adminConfigService = { getPlacementLimit: jest.fn().mockResolvedValue(6) };
  return { svc, repos };
}
const liveStore = (o: any = {}) => ({
  _id: OID, sellerId: 'seller1', name: 'Math Hub', slug: 'math-hub', status: 'active', plan: 'business', aiCredits: 900,
  rejectionReason: 'internal', customDomain: 'a.com', contactEmail: 'c@x.co', save: jest.fn().mockResolvedValue(undefined),
  toObject() { return { ...this }; }, ...o,
});

describe('getStoreById (unauthenticated route)', () => {
  it('a non-owner gets the public shape only — no plan, aiCredits, rejection reason or domain state', async () => {
    const { svc } = make({ store: liveStore() });
    const res: any = await svc.getStoreById(OID, null);
    expect(res.data.name).toBe('Math Hub');
    expect(String(res.data._id)).toBe(OID); // existing clients keep reading _id
    for (const leaked of ['plan', 'aiCredits', 'rejectionReason', 'customDomain', 'status', 'verificationStatus']) expect(res.data).not.toHaveProperty(leaked);
  });

  it('a non-owner cannot read a pending / rejected / suspended store at all', async () => {
    for (const status of ['pending', 'rejected', 'suspended']) {
      const { svc } = make({ store: liveStore({ status }) });
      await expect(svc.getStoreById(OID, 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

describe('updateStoreCustomer', () => {
  it("a seller can no longer change a buyer's login email (forgot-password account takeover)", async () => {
    const { svc, repos } = make({ store: liveStore(), repos: { orderModel: { exists: jest.fn().mockResolvedValue(true) }, userModel: { findByIdAndUpdate: jest.fn() } } });
    await expect(svc.updateStoreCustomer('seller1', OID, 'buyer1', { email: 'attacker@evil.co' })).rejects.toThrow(/only be changed by the customer/);
    expect(repos.userModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('custom domain', () => {
  it.each(['edudeen.com', 'www.edudeen.com', 'api.edudeen.com', 'other-store.edudeen.com', 'stores.edudeen.com'])('rejects the platform host %s', async (host) => {
    const { svc } = make({ store: liveStore({ customDomain: null }) });
    await expect(svc.setCustomDomain('seller1', OID, host)).rejects.toThrow(/belongs to the platform/);
  });

  it('rejects an over-long domain and IPs/localhost', async () => {
    const { svc } = make({ store: liveStore({ customDomain: null }) });
    await expect(svc.setCustomDomain('seller1', OID, `${'a'.repeat(64)}.example.com`)).rejects.toThrow(/valid domain/);
    await expect(svc.setCustomDomain('seller1', OID, '127.0.0.1')).rejects.toThrow(/valid domain/);
    await expect(svc.setCustomDomain('seller1', OID, 'localhost')).rejects.toThrow(/valid domain/);
  });

  it('a concurrent claim that loses on the unique index is reported as "already connected", not a 500', async () => {
    const st = liveStore({ customDomain: null });
    st.save.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const { svc, repos } = make({ store: st });
    repos.storeModel.findOne = jest.fn().mockImplementation(() => { const r: any = Promise.resolve(st); r.lean = () => Promise.resolve(null); return r; });
    await expect(svc.setCustomDomain('seller1', OID, 'shop.mybrand.com')).rejects.toThrow(/already connected/);
  });

  it('a store that lost its plan entitlement stops serving on its custom domain', async () => {
    const { svc } = make({ store: liveStore({ customDomain: 'shop.mybrand.com' }), entitled: false });
    await expect(svc.getPublicStoreByDomain('shop.mybrand.com')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an entitled store still serves', async () => {
    const { svc } = make({ store: liveStore({ customDomain: 'shop.mybrand.com' }), entitled: true });
    await expect(svc.getPublicStoreByDomain('shop.mybrand.com')).resolves.toMatchObject({ success: true });
  });
});

describe('updateStore', () => {
  it('a suspended store cannot be edited', async () => {
    const { svc } = make({ store: liveStore({ status: 'suspended' }) });
    await expect(svc.updateStore('seller1', OID, { name: 'x' })).rejects.toThrow(/suspended/);
  });

  it('rejects non-text, oversize, non-https logo and bad contact email', async () => {
    const { svc } = make({ store: liveStore() });
    await expect(svc.updateStore('seller1', OID, { name: { $ne: 1 } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updateStore('seller1', OID, { description: 'x'.repeat(5001) })).rejects.toThrow(/at most 5000/);
    await expect(svc.updateStore('seller1', OID, { logo: 'javascript:alert(1)' })).rejects.toThrow(/https URL/);
    await expect(svc.updateStore('seller1', OID, { contactEmail: 'nope' })).rejects.toThrow(/valid email/);
  });

  it('the store category is locked once the store has products (products denormalise it)', async () => {
    const { svc, repos } = make({ store: liveStore({ categoryId: 'catA' }) });
    repos.productModel.exists.mockResolvedValue({ _id: 'p1' });
    jest.spyOn(svc, 'assertValidRootCategory').mockResolvedValue(undefined);
    await expect(svc.updateStore('seller1', OID, { categoryId: 'catB' })).rejects.toThrow(/cannot be changed once/);
  });
});

describe('announcement bar and pinned products', () => {
  it('rejects a javascript: CTA link, a bad type and an invalid date', async () => {
    const { svc } = make({ store: liveStore() });
    await expect(svc.updateAnnouncementBar('seller1', OID, { message: 'hi', ctaLink: 'javascript:alert(1)' })).rejects.toThrow(/http\(s\) URL/);
    await expect(svc.updateAnnouncementBar('seller1', OID, { message: 'hi', type: 'evil' })).rejects.toThrow(/Invalid announcement type/);
    await expect(svc.updateAnnouncementBar('seller1', OID, { message: 'hi', startAt: 'garbage' })).rejects.toThrow(/valid date/);
  });

  it('only this store\'s live products can be pinned', async () => {
    const st = liveStore();
    const { svc, repos } = make({ store: st });
    const mine = '64f0c0ffee0c0ffee0c0ff0a';
    const foreign = '64f0c0ffee0c0ffee0c0ff0b';
    repos.productModel.find = jest.fn().mockReturnValue({ select: () => ({ lean: async () => [{ _id: { toString: () => mine } }] }) });
    await svc.updatePinnedProducts('seller1', OID, [mine, foreign, mine]);
    expect(st.pinnedProductIds).toEqual([mine]);
    expect(repos.productModel.find).toHaveBeenCalledWith(expect.objectContaining({ storeId: OID, isDelete: false, status: 'active' }));
    await expect(svc.updatePinnedProducts('seller1', OID, ['nope'])).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('followStore', () => {
  it('unfollow decrements once: a second concurrent unfollow that removed nothing does not decrement again', async () => {
    const { svc, repos } = make({ store: liveStore() });
    repos.storeFollowerModel.deleteOne.mockResolvedValueOnce({ deletedCount: 1 }).mockResolvedValueOnce({ deletedCount: 0 });
    const first: any = await svc.followStore('u1', OID);
    expect(first.data.following).toBe(false);
    expect(repos.storeModel.findByIdAndUpdate).toHaveBeenCalledWith(OID, { $inc: { followersCount: -1 } });
    const second: any = await svc.followStore('u1', OID); // removed nothing -> this is a follow
    expect(second.data.following).toBe(true);
  });

  it('a double-tap follow that hits the unique index is "already following", not a 500', async () => {
    const { svc, repos } = make({ store: liveStore() });
    repos.storeFollowerModel.deleteOne.mockResolvedValue({ deletedCount: 0 });
    repos.storeFollowerModel.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(svc.followStore('u1', OID)).resolves.toMatchObject({ data: { following: true } });
    expect(repos.storeModel.findByIdAndUpdate).not.toHaveBeenCalled(); // no phantom +1
  });

  it('pending / suspended stores cannot be followed', async () => {
    const { svc, repos } = make({ store: null });
    await expect(svc.followStore('u1', OID)).rejects.toBeInstanceOf(NotFoundException);
    expect(repos.storeModel.findOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });
});

describe('public product view helpers', () => {
  it('sanitizeDigitalForPublicView hides the file manifest, preview source AND the post-purchase delivery message', () => {
    const out: any = sanitizeDigitalForPublicView({
      name: 'Pack', digital: { files: [{ url: 'private/digital-products/x' }, { url: 'y' }], buyerDeliveryMessage: 'License key: ABC-123', downloadLimit: '3', preview: { enabled: true, previewSourcePublicId: 'private/s' } },
    });
    expect(out.digital).toEqual({ downloadLimit: '3', fileCount: 2, previewAvailable: true });
  });

  it('clampInt and queryString neutralise arrays, objects and out-of-range numbers', () => {
    expect(clampInt('-5', 1, 1, 100)).toBe(1);
    expect(clampInt('100000', 12, 1, 50)).toBe(50);
    expect(clampInt({ $gt: 1 }, 12, 1, 50)).toBe(12);
    expect(clampInt(['1'], 12, 1, 50)).toBe(12);
    expect(clampInt('abc', 12, 1, 50)).toBe(12);
    expect(queryString({ $ne: 'x' })).toBeUndefined();
    expect(queryString(['a'])).toBeUndefined();
    expect(queryString('ok')).toBe('ok');
    expect(queryString('x'.repeat(201))).toBeUndefined();
  });
});
