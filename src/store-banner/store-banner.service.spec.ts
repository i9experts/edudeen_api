/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { StoreBannerService } from './store-banner.service';
import { MAX_ACTIVE_STORE_SLIDES, cleanSlideLink, holdsSlot, validateReorderIds } from './store-banner-rules.util';

const STORE = 'a'.repeat(24);
const SELLER = 'seller1';
const OWN_PRODUCT = 'b'.repeat(24);
const FOREIGN_PRODUCT = 'c'.repeat(24);
const OWN_COLLECTION = 'd'.repeat(24);
const fail = (m: string): never => { throw new BadRequestException(m); };

function make(opts: { slots?: number } = {}) {
  const banners: any[] = Array.from({ length: opts.slots ?? 0 }, (_, i) => ({ _id: `${i}`.padStart(24, '0'), storeId: STORE, status: 'active', createdAt: new Date(i) }));
  const storeBannerModel: any = {
    countDocuments: async (q: any) => banners.filter((b) => (!q.status || q.status.$in.includes(b.status)) && (!q._id || b._id !== q._id.$ne)).length,
    create: async (d: any) => { const b = { _id: 'f'.repeat(24), ...d, createdAt: new Date() }; banners.push(b); return b; },
    find: (q: any) => {
      const rows = banners.filter((b) => !q.status || q.status.$in.includes(b.status));
      const chain: any = { sort: () => chain, select: () => chain, lean: async () => rows };
      return chain;
    },
    deleteOne: async () => ({}),
    bulkWrite: async (ops: any[]) => ops,
  };
  const productModel: any = { exists: async (q: any) => (q._id === OWN_PRODUCT && q.storeId === STORE ? { _id: q._id } : null) };
  const collectionModel: any = { exists: async (q: any) => (q._id === OWN_COLLECTION && q.storeId === STORE ? { _id: q._id } : null) };
  const storeModel: any = { findOne: async (q: any) => (q.sellerId === SELLER ? { _id: STORE } : null) };
  const db: any = { repositories: { storeBannerModel, productModel, collectionModel, storeModel } };
  const media: any = { uploadAndTrack: async () => ({ url: 'https://res.cloudinary.com/x.jpg', publicId: 'p', width: 2560 }) };
  const svc = new StoreBannerService(db, { getPlacementLimit: async () => 4 } as any, media, { log: () => undefined } as any, { assertCanCreateStoreBanner: async () => undefined } as any);
  return { svc, banners };
}
const file: any = { size: 1000, buffer: Buffer.from('x'), mimetype: 'image/jpeg' };

describe('store banner rules (pure)', () => {
  it('links must be an id plus product|collection', () => {
    expect(cleanSlideLink('product', OWN_PRODUCT, fail)).toEqual({ linkType: 'product', linkTarget: OWN_PRODUCT });
    expect(cleanSlideLink('product', '', fail)).toBeNull();
    expect(() => cleanSlideLink('external', 'https://evil.example', fail)).toThrow(BadRequestException);
    expect(() => cleanSlideLink('category', OWN_PRODUCT, fail)).toThrow(BadRequestException);
    expect(() => cleanSlideLink('product', 'not-an-id', fail)).toThrow(BadRequestException);
  });
  it('only the oldest MAX slides hold a slot', () => {
    const ids = ['1', '2', '3', '4', '5'];
    expect(holdsSlot(ids, '4')).toBe(true);
    expect(holdsSlot(ids, '5')).toBe(false);
  });
  it('reorder ids must be exactly the store banners', () => {
    expect(validateReorderIds(['1'.repeat(24), '2'.repeat(24)], ['2'.repeat(24), '1'.repeat(24)], fail)).toHaveLength(2);
    expect(() => validateReorderIds(['1'.repeat(24)], ['2'.repeat(24), '1'.repeat(24)], fail)).toThrow(BadRequestException);
    expect(() => validateReorderIds(['9'.repeat(24), '2'.repeat(24)], ['2'.repeat(24), '1'.repeat(24)], fail)).toThrow(BadRequestException);
  });
});

describe('StoreBannerService.create', () => {
  it('refuses the 5th slide (400)', async () => {
    const { svc } = make({ slots: MAX_ACTIVE_STORE_SLIDES });
    await expect(svc.create(STORE, SELLER, {} as any, file)).rejects.toThrow(/at most 4/);
  });
  it('accepts the 4th slide', async () => {
    const { svc } = make({ slots: MAX_ACTIVE_STORE_SLIDES - 1 });
    await expect(svc.create(STORE, SELLER, {} as any, file)).resolves.toMatchObject({ success: true });
  });
  it('a paused or scheduled-in-future slide rules: scheduled still takes a slot', async () => {
    const { svc } = make({ slots: MAX_ACTIVE_STORE_SLIDES });
    await expect(svc.create(STORE, SELLER, { startAt: new Date(Date.now() + 86400000).toISOString() } as any, file)).rejects.toThrow(BadRequestException);
  });
  it('refuses a link to a product that is not the seller\'s own live product', async () => {
    const { svc } = make();
    await expect(svc.create(STORE, SELLER, { linkType: 'product', linkTarget: FOREIGN_PRODUCT } as any, file)).rejects.toThrow(/not one of your live products/);
  });
  it('refuses external and category links', async () => {
    const { svc } = make();
    await expect(svc.create(STORE, SELLER, { linkType: 'external', linkTarget: 'https://x.example' } as any, file)).rejects.toThrow(BadRequestException);
    await expect(svc.create(STORE, SELLER, { linkType: 'category', linkTarget: OWN_PRODUCT } as any, file)).rejects.toThrow(BadRequestException);
  });
  it('accepts the own product and own collection', async () => {
    const a = make();
    await expect(a.svc.create(STORE, SELLER, { linkType: 'product', linkTarget: OWN_PRODUCT } as any, file)).resolves.toBeDefined();
    const b = make();
    await expect(b.svc.create(STORE, SELLER, { linkType: 'collection', linkTarget: OWN_COLLECTION } as any, file)).resolves.toBeDefined();
  });
  it('another seller gets 403', async () => {
    const { svc } = make();
    await expect(svc.create(STORE, 'someone-else', {} as any, file)).rejects.toThrow(/unauthorized/);
  });
});

describe('StoreBannerService.reorder', () => {
  it('refuses ids that are not exactly the store banners', async () => {
    const { svc } = make({ slots: 2 });
    await expect(svc.reorder(STORE, SELLER, ['9'.repeat(24)])).rejects.toThrow(BadRequestException);
  });
  it('accepts the exact set', async () => {
    const { svc, banners } = make({ slots: 2 });
    await expect(svc.reorder(STORE, SELLER, banners.map((b) => b._id).reverse())).resolves.toMatchObject({ success: true });
  });
});
