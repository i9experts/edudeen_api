/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { BadRequestException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';

const SELLER = '64b0000000000000000000b1';
const meta = { adminId: 'admin1', ip: '5.5.5.5', userAgent: 'jest' };

function chain(v: any) { const p: any = Promise.resolve(v); p.select = () => p; p.limit = () => p; p.lean = () => Promise.resolve(v); return p; }

function make() {
  const sellerModel: any = {
    findOne: jest.fn().mockReturnValue(chain({ name: 'Sara', email: 's@x.com' })),
    // suspendSellerCascade -> status/tokenVersion pipeline update, then cascade bookkeeping
    findOneAndUpdate: jest.fn().mockResolvedValue({ _id: SELLER }),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const userModel: any = { findOne: jest.fn().mockReturnValue(chain({ name: 'Bo', email: 'b@x.com' })), findByIdAndUpdate: jest.fn().mockResolvedValue({}), updateOne: jest.fn().mockResolvedValue({}) };
  const storeModel: any = {
    find: jest.fn((q: any) => (q.status === 'active' ? Promise.resolve([{ _id: 's1' }]) : chain([{ _id: 's1' }]))),
    updateMany: jest.fn().mockResolvedValue({}),
  };
  const payoutModel = { countDocuments: jest.fn().mockResolvedValue(2) };
  const orderModel = { find: jest.fn().mockReturnValue(chain([{ orderNumber: 'ORD-1' }, { orderNumber: 'ORD-2' }, { orderNumber: 'ORD-3' }])) };
  const activity = { log: jest.fn().mockResolvedValue(true) };
  const svc = new AdminUsersService({ repositories: { sellerModel, userModel, storeModel, payoutModel, orderModel } } as any, activity as any);
  return { svc, sellerModel, userModel, storeModel, payoutModel, orderModel, activity };
}

describe('AdminUsersService — suspend / force logout (phase 5)', () => {
  it('refuses to suspend without a reason (nothing is touched)', async () => {
    const { svc, sellerModel, userModel } = make();
    await expect(svc.suspend('seller', SELLER, meta, undefined)).rejects.toThrow(BadRequestException);
    await expect(svc.suspend('buyer', SELLER, meta, ' x ')).rejects.toThrow(/reason is required/);
    expect(sellerModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(userModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('suspending a buyer revokes sessions and puts the reason + ip/user-agent on record', async () => {
    const { svc, userModel, activity } = make();
    await svc.suspend('buyer', SELLER, meta, 'Chargeback fraud');
    expect(userModel.findByIdAndUpdate).toHaveBeenCalledWith(SELLER, { $set: { status: 'suspended' }, $inc: { tokenVersion: 1 } });
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'buyer_suspended', ip: '5.5.5.5', userAgent: 'jest', metadata: { reason: 'Chargeback fraud' },
    }));
  });

  it('suspending a seller reports payouts on hold and open orders, and records them', async () => {
    const { svc, activity, payoutModel, orderModel } = make();
    const res: any = await svc.suspend('seller', SELLER, meta, 'Policy violation');
    expect(res.data).toEqual({ suspendedStores: 1, heldPayouts: 2, openOrders: 3 });
    expect(payoutModel.countDocuments).toHaveBeenCalledWith({ sellerId: SELLER, status: { $in: ['pending', 'processing'] } });
    expect(orderModel.find.mock.calls[0][0].sellerOrders.$elemMatch.status.$in).toEqual(['pending', 'processing', 'shipped']);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'seller_suspended',
      metadata: expect.objectContaining({ reason: 'Policy violation', heldPayouts: 2, openOrders: 3, openOrderNumbers: ['ORD-1', 'ORD-2', 'ORD-3'] }),
    }));
  });

  it('force-logout bumps tokenVersion for the right collection and audits it', async () => {
    const { svc, userModel, sellerModel, activity } = make();
    await svc.forceLogout('buyer', SELLER, meta);
    expect(userModel.updateOne).toHaveBeenCalledWith({ _id: SELLER, isDelete: false }, { $inc: { tokenVersion: 1 } });
    await svc.forceLogout('seller', SELLER, meta);
    expect(sellerModel.updateOne).toHaveBeenCalledWith({ _id: SELLER, isDelete: false }, { $inc: { tokenVersion: 1 } });
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'seller_force_logout', ip: '5.5.5.5' }));
  });
});