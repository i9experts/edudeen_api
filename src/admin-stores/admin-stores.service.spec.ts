/* eslint-disable prettier/prettier */
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AdminStoresService } from './admin-stores.service';

const mkSvc = (over: any = {}) => {
  const store = { _id: 'st1', name: 'Noor', slug: 'noor', status: 'active', sellerId: 's1', isDelete: false, ...over.store };
  const seller = { _id: 's1', email: 'o@x.com', status: 'active', isDelete: false, tokenVersion: 3, ...over.seller };
  // Like a Mongoose query: awaitable directly, or through .select().lean().
  const chain = (v: any) => ({ select: () => ({ lean: async () => v }), then: (res: any, rej: any) => Promise.resolve(v).then(res, rej) });
  const sellerModel: any = Object.assign(function (this: any, d: any) { Object.assign(this, d); this.save = async () => { this._id = 'newseller'; }; }, {
    findById: () => chain(seller), exists: async () => over.sellerExists ?? null, deleteOne: jest.fn().mockResolvedValue({}),
  });
  const storeModel: any = { findById: () => chain(store), updateOne: jest.fn().mockResolvedValue({}) };
  const db: any = { repositories: { sellerModel, storeModel } };
  const stores: any = { createStore: jest.fn().mockResolvedValue({ data: { _id: 'st9', name: 'N', slug: 'n' } }) };
  const auth: any = { issueManageSession: jest.fn().mockResolvedValue({ accessToken: 'tok', expiresInSeconds: 1800 }) };
  const activity: any = { log: jest.fn().mockResolvedValue(over.logOk ?? true) };
  const email: any = { sendMail: jest.fn().mockResolvedValue(true) };
  const managed: any = { assertMayOperate: over.assertMayOperate ?? jest.fn().mockResolvedValue(undefined) };
  return { svc: new AdminStoresService(db, stores, auth, activity, managed, email), stores, auth, activity, email, storeModel, sellerModel, managed };
};
const admin = { id: 'a1' };

describe('AdminStoresService.manageSession', () => {
  it('audits first, then returns a store-locked session token', async () => {
    const t = mkSvc();
    const r = await t.svc.manageSession(admin, 'st1');
    expect(r.accessToken).toBe('tok');
    expect(t.activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_manage_session_started', actorId: 'a1', targetId: 'st1' }));
    expect(t.auth.issueManageSession).toHaveBeenCalledWith(expect.objectContaining({ tokenVersion: 3 }), 'st1', 'a1');
  });
  it('issues no token when the audit entry cannot be stored', async () => {
    const t = mkSvc({ logOk: false });
    await expect(t.svc.manageSession(admin, 'st1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(t.auth.issueManageSession).not.toHaveBeenCalled();
  });
  it('refuses a team member the store is not assigned to (no audit entry, no token)', async () => {
    const t = mkSvc({ assertMayOperate: jest.fn().mockRejectedValue(new ForbiddenException('not assigned')) });
    await expect(t.svc.manageSession(admin, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.managed.assertMayOperate).toHaveBeenCalledWith('a1', 'st1');
    expect(t.activity.log).not.toHaveBeenCalled();
    expect(t.auth.issueManageSession).not.toHaveBeenCalled();
  });
  it('refuses suspended stores and suspended sellers', async () => {
    await expect(mkSvc({ store: { status: 'suspended' } }).svc.manageSession(admin, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(mkSvc({ seller: { status: 'suspended' } }).svc.manageSession(admin, 'st1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AdminStoresService.createForSeller', () => {
  const store = { name: 'Noor Hub', baseCurrency: 'PKR' };
  it('needs exactly one of sellerId / newSeller', async () => {
    const t = mkSvc();
    await expect(t.svc.createForSeller(admin, { store } as any)).rejects.toThrow('not both');
    await expect(t.svc.createForSeller(admin, { sellerId: 's1', newSeller: { name: 'A B', email: 'a@b.com' }, store } as any)).rejects.toThrow('not both');
  });
  it('creates the store for an existing seller (seller owns it) and marks createdByAdmin', async () => {
    const t = mkSvc();
    const r = await t.svc.createForSeller(admin, { sellerId: 's1', store } as any);
    expect(t.stores.createStore).toHaveBeenCalledWith('s1', store);
    expect(t.storeModel.updateOne).toHaveBeenCalledWith({ _id: 'st9' }, { $set: { createdByAdmin: expect.objectContaining({ adminId: 'a1' }) } });
    expect(r.createdSeller).toBe(false); expect(t.email.sendMail).not.toHaveBeenCalled();
  });
  it('new seller: account made, store created, invitation e-mailed (no password chosen by admin)', async () => {
    const t = mkSvc();
    const r = await t.svc.createForSeller(admin, { newSeller: { name: 'Ali Khan', email: ' Ali@X.com ' }, store } as any);
    expect(r.createdSeller).toBe(true); expect(r.emailSent).toBe(true);
    expect(t.stores.createStore).toHaveBeenCalledWith('newseller', store);
    expect(t.email.sendMail).toHaveBeenCalledWith('ali@x.com', expect.any(String), expect.stringContaining('forgot-password'));
  });
  it('removes the empty seller account when the store is refused; refuses a duplicate e-mail', async () => {
    const t = mkSvc();
    t.stores.createStore.mockRejectedValueOnce(new Error('bad category'));
    await expect(t.svc.createForSeller(admin, { newSeller: { name: 'Ali Khan', email: 'a@x.com' }, store } as any)).rejects.toThrow('bad category');
    expect(t.sellerModel.deleteOne).toHaveBeenCalled();
    await expect(mkSvc({ sellerExists: { _id: 1 } }).svc.createForSeller(admin, { newSeller: { name: 'Ali Khan', email: 'a@x.com' }, store } as any)).rejects.toThrow('already exists');
  });
});
