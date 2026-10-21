/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { UsersService } from './users.service';

jest.setTimeout(30_000);

async function setup(opts: { password?: string | null; role?: 'user' | 'seller'; openOrders?: number; payouts?: number; balances?: any[]; premium?: boolean } = {}) {
  const role = opts.role ?? 'user';
  const acc: any = { _id: 'a1', tokenVersion: 1, isDelete: false, status: 'active' };
  if (opts.password !== null) acc.password = await bcrypt.hash(opts.password ?? 'RightPass1', 4);
  acc.save = jest.fn().mockResolvedValue(acc);
  const model: any = { findById: jest.fn().mockResolvedValue(acc) };
  const storeModel = { updateMany: jest.fn().mockResolvedValue({}) };
  const db: any = {
    repositories: {
      userModel: model, sellerModel: model, storeModel,
      orderModel: { countDocuments: jest.fn().mockResolvedValue(opts.openOrders ?? 0) },
      payoutModel: { countDocuments: jest.fn().mockResolvedValue(opts.payouts ?? 0) },
      sellerBalanceModel: { find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(opts.balances ?? []) }) })) },
    },
  };
  const premium: any = { getEntitlements: jest.fn().mockResolvedValue({ isPremium: !!opts.premium }) };
  return { acc, storeModel, role, service: new UsersService(db, {} as any, premium) };
}

describe('UsersService.deleteAccount', () => {
  it('needs the typed word', async () => {
    const { service, acc } = await setup();
    await expect(service.deleteAccount('a1', 'user', { confirm: 'nope', password: 'RightPass1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(acc.save).not.toHaveBeenCalled();
  });

  it('needs the password when the account has one, and rejects a wrong one', async () => {
    const { service, acc } = await setup();
    await expect(service.deleteAccount('a1', 'user', { confirm: 'DELETE' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteAccount('a1', 'user', { confirm: 'DELETE', password: 'wrong' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(acc.save).not.toHaveBeenCalled();
  });

  it('deletes a buyer with the right password (case-insensitive word) and revokes sessions', async () => {
    const { service, acc } = await setup();
    const res: any = await service.deleteAccount('a1', 'user', { confirm: ' delete ', password: 'RightPass1' });
    expect(res.success).toBe(true);
    expect(acc).toMatchObject({ isDelete: true, status: 'deleted', tokenVersion: 2 });
  });

  it('social-only account (no password) only needs the typed word', async () => {
    const { service, acc } = await setup({ password: null });
    await service.deleteAccount('a1', 'user', { confirm: 'DELETE' });
    expect(acc.isDelete).toBe(true);
  });

  it('blocks a buyer with open orders or an active Premium membership', async () => {
    const a = await setup({ openOrders: 2 });
    await expect(a.service.deleteAccount('a1', 'user', { confirm: 'DELETE', password: 'RightPass1' })).rejects.toBeInstanceOf(ConflictException);
    expect(a.acc.isDelete).toBe(false);

    const b = await setup({ premium: true });
    await expect(b.service.deleteAccount('a1', 'user', { confirm: 'DELETE', password: 'RightPass1' })).rejects.toThrow(/Premium/);
    expect(b.acc.isDelete).toBe(false);
  });

  it('blocks a seller with open orders, payouts in flight or money in the wallet; stores stay live', async () => {
    const run = (o: any) => setup({ role: 'seller', ...o }).then(async (s) => {
      await expect(s.service.deleteAccount('a1', 'seller', { confirm: 'DELETE', password: 'RightPass1' })).rejects.toBeInstanceOf(ConflictException);
      expect(s.storeModel.updateMany).not.toHaveBeenCalled();
      expect(s.acc.isDelete).toBe(false);
    });
    await run({ openOrders: 1 });
    await run({ payouts: 1 });
    await run({ balances: [{ availableBalance: 10, pendingBalance: 0 }] });
    await run({ balances: [{ availableBalance: -5, pendingBalance: 0 }] }); // a debt also blocks
  });

  it('deletes a clean seller and suspends their stores', async () => {
    const s = await setup({ role: 'seller', balances: [{ availableBalance: 0, pendingBalance: 0 }] });
    await s.service.deleteAccount('a1', 'seller', { confirm: 'DELETE', password: 'RightPass1' });
    expect(s.acc.isDelete).toBe(true);
    expect(s.storeModel.updateMany).toHaveBeenCalled();
  });
});
