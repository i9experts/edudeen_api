/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CategoryRequestsService, MAX_PENDING_REQUESTS_PER_STORE, buildStoreUsage, cleanRequestInput } from './category-requests.service';

const OID = (n: number) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const SELLER = OID(1), OTHER = OID(2), STORE = OID(10);

function setup(opts: { logOk?: boolean; store?: Record<string, unknown>; categories?: Record<string, Record<string, unknown>> } = {}) {
  const docs: any[] = [];
  const model: any = {
    docs,
    countDocuments: jest.fn(async (q: any) => docs.filter((d) => d.storeId === q.storeId && d.status === q.status).length),
    exists: jest.fn(async (q: any) => (q.name ? docs.find((d) => d.storeId === q.storeId && d.status === q.status && q.name.test(d.name)) ?? null : docs.find((d) => String(d._id) === String(q._id)) ?? null)),
    create: jest.fn(async (d: any) => { const row = { _id: OID(50 + docs.length), createdAt: new Date(), status: 'pending', ...d, toObject() { return { ...this }; } }; docs.push(row); return row; }),
    deleteOne: jest.fn(async (q: any) => { const i = docs.findIndex((x) => x._id === q._id); if (i >= 0) docs.splice(i, 1); }),
    updateOne: jest.fn(async () => ({})),
    find: jest.fn((q: any) => {
      let rows = docs.filter((d) => d.storeId === q.storeId && d.status === q.status);
      const chain: any = {
        sort: () => { rows = [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id))); return chain; },
        limit: (n: number) => { rows = rows.slice(0, n); return chain; },
        select: () => chain,
        lean: async () => rows,
      };
      return chain;
    }),
    findOneAndUpdate: jest.fn((q: any, u: any) => ({ lean: async () => { const d = docs.find((x) => String(x._id) === String(q._id) && x.status === q.status); if (!d) return null; Object.assign(d, u.$set); return { ...d }; } })),
  };
  // Mutable, so `decide()`'s approval write (storeModel.updateOne) is visible to a later findOne in the same test.
  const storeState: any = { _id: STORE, categoryId: OID(5), ...opts.store };
  const storeModel = {
    findOne: jest.fn((q: any) => ({
      select: () => ({
        lean: async () => {
          // ownedStore() filters by sellerId (seller-side); decide()'s own lookup doesn't (admin-side).
          if ('sellerId' in q) return q.sellerId === SELLER && q._id === STORE ? { ...storeState } : null;
          return q._id === STORE ? { ...storeState } : null;
        },
      }),
    })),
    updateOne: jest.fn(async (q: any, u: any) => { if (q._id === STORE && u.$set) Object.assign(storeState, u.$set); return {}; }),
  };
  const categoriesById: Record<string, any> = {
    [OID(6)]: { _id: OID(6), name: 'Islamic Studies', parentId: null, status: 'active' },
    [OID(7)]: { _id: OID(7), name: 'Computer Science', parentId: null, status: 'active' },
    ...opts.categories,
  };
  const categoryModel = {
    findOne: jest.fn((q: any) => ({
      select: () => ({
        lean: async () => {
          const c = categoriesById[q._id];
          if (!c) return null;
          if (q.status && c.status !== q.status) return null;
          if (q.isDelete === false && c.isDelete) return null;
          return c;
        },
      }),
    })),
  };
  const activityLog = { log: jest.fn(async () => opts.logOk !== false) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const svc = new CategoryRequestsService(model, { repositories: { storeModel, categoryModel } } as any, activityLog as any, notifications as any);
  return { svc, model, activityLog, notifications, storeState };
}
const body = (name: string) => ({ storeId: STORE, type: 'subcategory', name, reason: 'Many buyers search for this topic', exampleProduct: 'Tajweed workbook' });

describe('cleanRequestInput', () => {
  it('validates name, reason, example', () => {
    expect(cleanRequestInput(body(' Nazra  Quran ')).name).toBe('Nazra Quran');
    expect(() => cleanRequestInput({ ...body('A') })).toThrow(BadRequestException);
    expect(() => cleanRequestInput({ ...body('x'.repeat(51)) })).toThrow(BadRequestException);
    expect(() => cleanRequestInput({ ...body('Ok name'), reason: 'short' })).toThrow(BadRequestException);
    expect(() => cleanRequestInput({ ...body('Ok name'), exampleProduct: '' })).toThrow(BadRequestException);
    expect(() => cleanRequestInput({ ...body('Ok name'), type: 'other' })).toThrow(BadRequestException);
  });
});

describe('category requests: limit + ownership', () => {
  it('allows 3 pending per store and rejects the 4th with a clear message', async () => {
    const { svc } = setup();
    for (let i = 0; i < MAX_PENDING_REQUESTS_PER_STORE; i++) await svc.create(SELLER, STORE, body(`Topic ${i}`));
    await expect(svc.create(SELLER, STORE, body('Topic 9'))).rejects.toThrow(/already have 3 requests waiting/);
  });
  it('a decided request frees a slot', async () => {
    const { svc, model } = setup();
    for (let i = 0; i < 3; i++) await svc.create(SELLER, STORE, body(`Topic ${i}`));
    model.docs[0].status = 'approved';
    await expect(svc.create(SELLER, STORE, body('Topic 9'))).resolves.toBeTruthy();
  });
  it('rejects a duplicate pending name', async () => {
    const { svc } = setup();
    await svc.create(SELLER, STORE, body('Nazra'));
    await expect(svc.create(SELLER, STORE, body('nazra'))).rejects.toThrow(/already have a pending request/);
  });
  it('non-owner cannot create or read (403)', async () => {
    const { svc } = setup();
    await expect(svc.create(OTHER, STORE, body('Nazra'))).rejects.toThrow(ForbiddenException);
    await expect(svc.listForStore(OTHER, STORE)).rejects.toThrow(ForbiddenException);
    await expect(svc.storeUsage(OTHER, STORE)).rejects.toThrow(ForbiddenException);
  });
});

describe('category requests: a store with more than one category', () => {
  const CAT_A = OID(6), CAT_B = OID(7);
  it('requires the seller to say which of the store\'s categories a subcategory nests under', async () => {
    const { svc } = setup({ store: { categoryIds: [CAT_A, CAT_B] } });
    await expect(svc.create(SELLER, STORE, body('Nazra'))).rejects.toThrow(/Pick which of your store's categories/);
  });
  it('rejects a categoryId that is not one of the store\'s own', async () => {
    const { svc } = setup({ store: { categoryIds: [CAT_A, CAT_B] } });
    await expect(svc.create(SELLER, STORE, { ...body('Nazra'), categoryId: OID(99) })).rejects.toThrow(/Pick which of your store's categories/);
  });
  it('accepts a categoryId that is one of the store\'s own', async () => {
    const { svc, model } = setup({ store: { categoryIds: [CAT_A, CAT_B] } });
    await svc.create(SELLER, STORE, { ...body('Nazra'), categoryId: CAT_B });
    expect(model.docs[0].mainCategoryId).toBe(CAT_B);
  });
  it('still implies the single category when the store has only one (unchanged behaviour)', async () => {
    const { svc, model } = setup({ store: { categoryIds: [CAT_A] } });
    await svc.create(SELLER, STORE, body('Nazra'));
    expect(model.docs[0].mainCategoryId).toBe(CAT_A);
  });
});

describe('category requests: admin decision', () => {
  const meta = { adminId: OID(99) };
  it('approve is status-guarded, audited (awaited) and notifies the seller', async () => {
    const { svc, activityLog, notifications } = setup();
    const { data } = await svc.create(SELLER, STORE, body('Nazra'));
    const r = await svc.decide(data._id, 'approved', '', meta);
    expect(r.data.status).toBe('approved');
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'category_request_approved', actorId: OID(99), targetId: data._id }));
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: SELLER, type: 'category_request_approved' }));
    await expect(svc.decide(data._id, 'rejected', 'Already covered by another category', meta)).rejects.toThrow(ConflictException);
  });
  it('approving a subcategory request creates it under the store\'s main category and tells the seller', async () => {
    const { svc, notifications } = setup();
    const categories = { createApprovedSubcategory: jest.fn(async () => ({ id: OID(77), created: true })) };
    (svc as any).categories = categories;
    const { data } = await svc.create(SELLER, STORE, body('Nazra'));
    const r: any = await svc.decide(data._id, 'approved', '', meta);
    expect(categories.createApprovedSubcategory).toHaveBeenCalledWith(OID(99), OID(5), 'Nazra');
    expect(r.data.createdCategoryId).toBe(OID(77));
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('You can now choose it') }));
  });
  it('approval still stands when the category cannot be created (admin adds it by hand)', async () => {
    const { svc, notifications } = setup();
    (svc as any).categories = { createApprovedSubcategory: jest.fn(async () => { throw new Error('too deep'); }) };
    const { data } = await svc.create(SELLER, STORE, body('Nazra'));
    const r: any = await svc.decide(data._id, 'approved', '', meta);
    expect(r.data.status).toBe('approved');
    expect(r.data.createdCategoryId).toBeNull();
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('once the Edudeen team has added it') }));
  });
  it('a rejected request creates nothing', async () => {
    const { svc } = setup();
    const categories = { createApprovedSubcategory: jest.fn() };
    (svc as any).categories = categories;
    const { data } = await svc.create(SELLER, STORE, body('Nazra'));
    await svc.decide(data._id, 'rejected', 'Already covered by another category', meta);
    expect(categories.createApprovedSubcategory).not.toHaveBeenCalled();
  });
  it('reject needs a reason', async () => {
    const { svc } = setup();
    const { data } = await svc.create(SELLER, STORE, body('Nazra'));
    await expect(svc.decide(data._id, 'rejected', 'no', meta)).rejects.toThrow(BadRequestException);
    const r = await svc.decide(data._id, 'rejected', 'Already covered by another category', meta);
    expect(r.data.status).toBe('rejected');
  });
  it('no audit entry = decision put back', async () => {
    const { svc, model } = setup({ logOk: false });
    const { data } = await svc.create(SELLER, STORE, body('Nazra'));
    await expect(svc.decide(data._id, 'approved', '', meta)).rejects.toThrow(ConflictException);
    expect(model.updateOne).toHaveBeenCalled();
  });
});

describe('category requests: extra_category (an additional main category, past the cap)', () => {
  const CAT_A = OID(6), CAT_B = OID(7); // 'Islamic Studies', 'Computer Science' in the default categoriesById
  const extraBody = (requestedCategoryId: string) => ({
    storeId: STORE, type: 'extra_category', name: 'placeholder',
    reason: 'Expanding into a new subject our buyers keep asking for', exampleProduct: 'New course bundle',
    requestedCategoryId,
  });

  it('requires a requestedCategoryId', async () => {
    const { svc } = setup();
    const noRequestedCategoryId = { storeId: STORE, type: 'extra_category', name: 'placeholder', reason: 'Expanding into a new subject our buyers keep asking for', exampleProduct: 'New course bundle' };
    await expect(svc.create(SELLER, STORE, noRequestedCategoryId)).rejects.toThrow(/Pick which category/);
  });
  it('rejects a category the store already has', async () => {
    const { svc } = setup({ store: { categoryIds: [CAT_A] } });
    await expect(svc.create(SELLER, STORE, extraBody(CAT_A))).rejects.toThrow(/already sells in this category/);
  });
  it('rejects an unknown category id', async () => {
    const { svc } = setup();
    await expect(svc.create(SELLER, STORE, extraBody(OID(98)))).rejects.toThrow(/Selected category not found/);
  });
  it('rejects a subcategory (not a main category)', async () => {
    const { svc } = setup({ categories: { [OID(8)]: { _id: OID(8), name: 'Tajweed', parentId: CAT_A, status: 'active' } } });
    await expect(svc.create(SELLER, STORE, extraBody(OID(8)))).rejects.toThrow(/only request a main category/);
  });
  it('resolves the request name from the real category, ignoring whatever was typed', async () => {
    const { svc, model } = setup();
    await svc.create(SELLER, STORE, extraBody(CAT_A));
    expect(model.docs[0].name).toBe('Islamic Studies');
    expect(model.docs[0].requestedCategoryId).toBe(CAT_A);
  });

  describe('approval', () => {
    const meta = { adminId: OID(99) };
    it('pushes the category onto the store past MAX_STORE_CATEGORIES and keeps categoryId in sync', async () => {
      const { svc, storeState, notifications } = setup({ store: { categoryIds: [OID(20), OID(21), OID(22)] } });
      const { data } = await svc.create(SELLER, STORE, extraBody(CAT_A));
      const r: any = await svc.decide(data._id, 'approved', '', meta);
      expect(r.data.appliedCategoryId).toBe(CAT_A);
      expect(storeState.categoryIds).toEqual([OID(20), OID(21), OID(22), CAT_A]);
      expect(storeState.categoryId).toBe(OID(20));
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('added to your store') }));
    });
    it('does not duplicate if the store already has the category by the time of approval', async () => {
      const { svc, storeState } = setup({ store: { categoryIds: [CAT_B] } });
      const { data } = await svc.create(SELLER, STORE, extraBody(CAT_A));
      storeState.categoryIds = [CAT_B, CAT_A]; // e.g. an admin already added it by hand before deciding
      const r: any = await svc.decide(data._id, 'approved', '', meta);
      expect(r.data.appliedCategoryId).toBe(CAT_A);
      expect(storeState.categoryIds).toEqual([CAT_B, CAT_A]);
    });
    it('a rejected request never touches the store', async () => {
      const { svc, storeState } = setup({ store: { categoryIds: [CAT_B] } });
      const { data } = await svc.create(SELLER, STORE, extraBody(CAT_A));
      await svc.decide(data._id, 'rejected', 'Not enough demand for this yet', meta);
      expect(storeState.categoryIds).toEqual([CAT_B]);
    });
  });
});

describe('buildStoreUsage', () => {
  const tree: Record<string, string[]> = { m: ['m'], s1: ['s1', 'm'], s2: ['s2', 's1', 'm'] };
  const chain = async (id: string) => tree[id] ?? [];
  it('rolls products up to every ancestor like the Products ?category filter', async () => {
    const { counts, noSubcategory } = await buildStoreUsage([
      { categoryId: 'm', subCategoryId: 's2', status: 'active' },
      { categoryId: 'm', subCategoryId: 's1', status: 'draft' },
      { categoryId: 'm', subCategoryId: null, status: 'scheduled' },
      { categoryId: 'm', subCategoryId: '', status: 'pending_review' },
    ], chain);
    expect(counts.m).toEqual({ active: 2, draft: 1, total: 4 });
    expect(counts.s1).toEqual({ active: 1, draft: 1, total: 2 });
    expect(counts.s2).toEqual({ active: 1, draft: 0, total: 1 });
    expect(noSubcategory).toBe(2);
  });
});
