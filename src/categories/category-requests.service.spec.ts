/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CategoryRequestsService, MAX_PENDING_REQUESTS_PER_STORE, buildStoreUsage, cleanRequestInput } from './category-requests.service';

const OID = (n: number) => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const SELLER = OID(1), OTHER = OID(2), STORE = OID(10);

function setup(opts: { logOk?: boolean } = {}) {
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
  const storeModel = { findOne: jest.fn((q: any) => ({ select: () => ({ lean: async () => (q.sellerId === SELLER && q._id === STORE ? { _id: STORE, categoryId: OID(5) } : null) }) })) };
  const activityLog = { log: jest.fn(async () => opts.logOk !== false) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const svc = new CategoryRequestsService(model, { repositories: { storeModel } } as any, activityLog as any, notifications as any);
  return { svc, model, activityLog, notifications };
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
