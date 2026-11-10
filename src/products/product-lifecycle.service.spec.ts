/* eslint-disable prettier/prettier */
import { ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { ProductLifecycleService, planVisibilityChange } from './product-lifecycle.service';

const SELLER = 'a'.repeat(24);
const PID = 'b'.repeat(24);
const STORE = 'c'.repeat(24);

function build(product: any, opts: { variants?: any[]; planBlocked?: boolean; modified?: number } = {}) {
  const created: any[] = [];
  const productModel: any = {
    findOne: jest.fn(() => ({ lean: async () => product })),
    exists: jest.fn(async () => null),
    create: jest.fn(async (d: any) => { created.push(d); return { _id: 'd'.repeat(24), ...d }; }),
    deleteOne: jest.fn(async () => ({})),
    updateOne: jest.fn(async () => ({ modifiedCount: opts.modified ?? 1 })),
  };
  const variantModel: any = {
    find: jest.fn(() => ({ lean: async () => opts.variants ?? [] })),
    insertMany: jest.fn(async (r: any[]) => r),
  };
  const storeModel: any = {
    findOne: jest.fn(() => ({ select: () => ({ lean: async () => ({ _id: STORE, name: 'Noor Hub' }) }) })),
    findByIdAndUpdate: jest.fn(() => ({ select: () => ({ lean: async () => ({ skuSeq: 5 }) }) })),
  };
  const db: any = { repositories: { productModel, productVariantModel: variantModel, storeModel } };
  const log = { log: jest.fn(async () => true) };
  const ent = { assertCanCreateProduct: jest.fn(async () => { if (opts.planBlocked) throw new ForbiddenException('plan ended'); }) };
  return { svc: new ProductLifecycleService(db, log as any, ent as any), productModel, variantModel, created, log, ent };
}

const base = { _id: PID, sellerId: SELLER, storeId: STORE, name: 'Class 5 Maths', status: 'active', isDelete: false, deliveryFormat: 'download', approvedAt: new Date(), flags: [], pausedFromStatus: null };

describe('planVisibilityChange', () => {
  it('deactivates only live/scheduled', () => {
    expect(planVisibilityChange({ ...base, status: 'active' }, false)).toMatchObject({ ok: true, to: 'inactive' });
    expect(planVisibilityChange({ ...base, status: 'draft' }, false)).toMatchObject({ ok: false });
  });
  it('activates an approved inactive product', () => {
    expect(planVisibilityChange({ ...base, status: 'inactive' }, true)).toMatchObject({ ok: true, to: 'active' });
  });
  it('never-approved or flagged goes back to review', () => {
    expect(planVisibilityChange({ ...base, status: 'inactive', approvedAt: null }, true)).toMatchObject({ to: 'pending_review' });
    expect(planVisibilityChange({ ...base, status: 'inactive', flags: ['contact_info'] }, true)).toMatchObject({ to: 'pending_review' });
  });
  it('plan-paused and admin-removed cannot be toggled/activated', () => {
    expect(planVisibilityChange({ ...base, status: 'inactive', pausedFromStatus: 'active' }, true)).toMatchObject({ ok: false, code: 409 });
    expect(planVisibilityChange({ ...base, status: 'inactive', removedByAdmin: true }, true)).toMatchObject({ ok: false, code: 403 });
  });
});

describe('ProductLifecycleService.setVisibility', () => {
  it('other seller gets 403', async () => {
    const { svc } = build(base);
    await expect(svc.setVisibility('e'.repeat(24), PID, { active: false })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('deactivates with an atomic conditional update + audit', async () => {
    const { svc, productModel, log } = build(base);
    const r = await svc.setVisibility(SELLER, PID, { active: false });
    expect(r.data.status).toBe('inactive');
    expect(productModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', pausedFromStatus: null }), { $set: { status: 'inactive' } });
    expect(log.log).toHaveBeenCalled();
  });
  it('plan-paused product refuses activation', async () => {
    const { svc, productModel } = build({ ...base, status: 'inactive', pausedFromStatus: 'active' });
    await expect(svc.setVisibility(SELLER, PID, { active: true })).rejects.toBeInstanceOf(ConflictException);
    expect(productModel.updateOne).not.toHaveBeenCalled();
  });
  it('expired plan blocks activation', async () => {
    const { svc } = build({ ...base, status: 'inactive' }, { planBlocked: true });
    await expect(svc.setVisibility(SELLER, PID, { active: true })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('lost race = 409; bad body = 400', async () => {
    const { svc } = build(base, { modified: 0 });
    await expect(svc.setVisibility(SELLER, PID, { active: false })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setVisibility(SELLER, PID, {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProductLifecycleService.duplicate', () => {
  it('creates a clean draft with new SKUs and no counters/offers', async () => {
    const src = { ...base, description: 'x'.repeat(30), purchaseCount: 9, totalRatings: 4, premiumDiscountPercent: 10, campaignIds: ['z'], previousSlugs: ['old'], flags: ['contact_info'], pausedFromStatus: null, images: ['i1'], tags: ['t'] };
    const { svc, created, variantModel } = build(src, { variants: [{ price: 100, sku: 'OLD-1', isDefault: true, stock: 3, options: [] }] });
    const r = await svc.duplicate(SELLER, PID);
    const doc = created[0];
    expect(doc.status).toBe('draft');
    expect(doc.name).toBe('Class 5 Maths (copy)');
    expect(doc.isTest).toBe(false);
    for (const k of ['purchaseCount', 'totalRatings', 'premiumDiscountPercent', 'campaignIds', 'previousSlugs', 'flags', 'pausedFromStatus', 'approvedAt']) expect(doc[k]).toBeUndefined();
    const rows = variantModel.insertMany.mock.calls[0][0];
    expect(rows[0].sku).toMatch(/^NOO-/);
    expect(rows[0].sku).not.toBe('OLD-1');
    expect(r.data.status).toBe('draft');
  });
  it('refuses courses and other sellers', async () => {
    await expect(build({ ...base, deliveryFormat: 'course' }).svc.duplicate(SELLER, PID)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(base).svc.duplicate('e'.repeat(24), PID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
