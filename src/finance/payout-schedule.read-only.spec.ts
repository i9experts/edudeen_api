/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/** App backend gap #11 (non-money part): GET payout-schedule never writes; no empty wallets or schedule records. */
import { FinanceService } from './finance.service';

const SELLER = '507f1f77bcf86cd799439011';
const STORE = '507f1f77bcf86cd799439033';

function build(opts: { schedules?: any[]; balances?: any[]; baseCurrency?: string } = {}) {
  const schedules = opts.schedules ?? [];
  const balances = opts.balances ?? [];
  const chain = (rows: any[]) => { const c: any = { lean: jest.fn().mockResolvedValue(rows) }; for (const k of ['sort', 'skip', 'limit', 'select']) c[k] = jest.fn().mockReturnValue(c); return c; };
  const scheduleModel: any = {
    findOne: jest.fn(async (q: any) => schedules.find((s) => s.currency === q.currency) ?? null),
    find: jest.fn((q: any) => (q?.isEnabled ? { lean: () => Promise.resolve(schedules) } : chain(schedules))),
    create: jest.fn(async (d: any) => ({ ...d, save: jest.fn() })),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const balanceModel: any = {
    find: jest.fn(() => chain(balances)),
    findOne: jest.fn((q: any) => { const b = balances.find((x) => x.currency === q.currency) ?? null; const p: any = Promise.resolve(b); p.lean = () => Promise.resolve(b); p.select = () => p; return p; }),
  };
  const db: any = { repositories: {
    storeModel: { findById: jest.fn().mockResolvedValue({ _id: STORE, sellerId: SELLER, isDelete: false, baseCurrency: opts.baseCurrency ?? 'PKR' }) },
    payoutScheduleModel: scheduleModel, sellerBalanceModel: balanceModel,
    payoutMethodModel: { find: jest.fn(() => chain([])), findById: jest.fn().mockResolvedValue({ _id: 'm1', status: 'active', currency: 'USD' }) },
    payoutModel: { find: jest.fn(() => chain([])), exists: jest.fn().mockResolvedValue(null) },
    transactionModel: { aggregate: jest.fn().mockResolvedValue([]), find: jest.fn(() => chain([])) },
    storeModelLean: {}, sellerModel: { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ status: 'active' }) }) })) },
  } };
  db.repositories.storeModel.findOne = jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ status: 'active', sellerId: SELLER }) }) }));
  const admin: any = { getPayoutFrequency: jest.fn().mockResolvedValue('monthly'), getPayoutMinimum: jest.fn().mockResolvedValue(5), getPlatformFees: jest.fn().mockResolvedValue(null) };
  const svc = new FinanceService(db, { log: jest.fn() } as any, { resolveRate: jest.fn().mockResolvedValue({ rate: 0.1, source: 'x' }) } as any, admin, { notify: jest.fn().mockResolvedValue(undefined) } as any, {} as any);
  return { svc, scheduleModel, balanceModel };
}

describe('payout schedule reads do not create data', () => {
  it("GET without currency answers the store's currency default, unsaved", async () => {
    const { svc, scheduleModel } = build();
    const s: any = await svc.getPayoutSchedule(SELLER, STORE);
    expect(s).toMatchObject({ currency: 'PKR', frequency: 'monthly', isEnabled: true, saved: false });
    expect(scheduleModel.create).not.toHaveBeenCalled();
  });

  it('GET ?currency=USD on a PKR store still writes nothing', async () => {
    const { svc, scheduleModel } = build();
    const s: any = await svc.getPayoutSchedule(SELLER, STORE, 'usd');
    expect(s.currency).toBe('USD');
    expect(s.saved).toBe(false);
    expect(scheduleModel.create).not.toHaveBeenCalled();
  });

  it('GET returns the saved schedule when there is one', async () => {
    const saved = { currency: 'PKR', frequency: 'weekly', isEnabled: true };
    const { svc } = build({ schedules: [saved] });
    expect(await svc.getPayoutSchedule(SELLER, STORE)).toBe(saved);
  });

  it("PATCH without currency updates the store's currency schedule (was USD)", async () => {
    const { svc, scheduleModel } = build();
    await svc.updatePayoutSchedule(SELLER, STORE, { frequency: 'weekly' } as any);
    expect(scheduleModel.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'PKR' }));
  });

  it('dashboard: a schedule-only currency (old empty USD schedule) adds no wallet next to PKR earnings', async () => {
    const { svc } = build({
      balances: [{ storeId: STORE, currency: 'PKR', availableBalance: 2000, pendingBalance: 0, totalPayouts: 0 }],
      schedules: [{ currency: 'USD', frequency: 'monthly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null }],
    });
    const dash: any = await svc.getDashboard(SELLER, STORE);
    expect(dash.wallets.map((w: any) => w.currency)).toEqual(['PKR']);
  });

  it("dashboard: a new store shows one zero wallet in the store's currency", async () => {
    const dash: any = await build({ baseCurrency: 'PKR' }).svc.getDashboard(SELLER, STORE);
    expect(dash.wallets).toHaveLength(1);
    expect(dash.wallets[0]).toMatchObject({ currency: 'PKR', availableBalance: 0 });
  });

  it('scheduled payouts skip a schedule whose currency has no balance, without creating one', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const { svc, balanceModel } = build({
      schedules: [{ _id: 's1', storeId: STORE, sellerId: SELLER, currency: 'USD', frequency: 'monthly', dayOfMonth: 1, isEnabled: true, nextPayoutAt: past, defaultPayoutMethodId: 'm1' }],
    });
    const spy = jest.spyOn(svc, 'getOrCreateBalance');
    const out = await svc.processScheduledPayouts();
    expect(spy).not.toHaveBeenCalled();
    expect(balanceModel.findOne).toHaveBeenCalledWith({ storeId: STORE, currency: 'USD' });
    expect(out.payoutsCreated).toBe(0);
    expect(out.skipped).toBe(1);
  });
});
