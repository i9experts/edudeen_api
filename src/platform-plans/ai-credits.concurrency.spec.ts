/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- integration test */
/**
 * Real-MongoDB concurrency tests for the AI credit wallet. Opt-in:
 *   TEST_MONGO_URI='mongodb://127.0.0.1:27018/edudeen_ai_it?replicaSet=rs0' npx jest ai-credits.concurrency
 */
import mongoose from 'mongoose';
import { AiCreditsService } from './ai-credits.service';
import { AiCreditsWalletSchema } from './schemas/ai-credits-wallet.schema';

const URI = process.env.TEST_MONGO_URI;
// These suites drop their database when done — never point them at anything that isn't a throwaway test DB.
if (URI && !/(_it|test)/i.test(new URL(URI).pathname))
  throw new Error(
    'Refusing to run: the test database name must contain "_it" or "test"',
  );

(URI ? describe : describe.skip)('AiCreditsService — real MongoDB', () => {
  let conn: mongoose.Connection,
    Wallet: mongoose.Model<any>,
    svc: AiCreditsService;
  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!).asPromise();
    Wallet = conn.model('AiCreditsWallet', AiCreditsWalletSchema);
    await Wallet.init();
    const entitlements: any = {
      getLimits: jest.fn().mockResolvedValue({ aiCreditsPerMonth: 100 }),
    };
    svc = new AiCreditsService(
      { repositories: { aiCreditsWalletModel: Wallet } } as any,
      entitlements,
    );
  });
  beforeEach(() => Wallet.deleteMany({}));
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });
  const w = async () => await Wallet.findOne({ storeId: 's1' }).lean();

  it('10 concurrent spends of 15 against 100 credits: exactly 6 succeed, balance is 10, never negative', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    const res = await Promise.allSettled(
      Array.from({ length: 10 }, () => svc.deduct('s1', 'seller1', 15, 'gen')),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect((await w()).balance).toBe(10);
  });

  it('concurrent grants are not lost', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    await Promise.all(
      Array.from({ length: 20 }, () => svc.grant('s1', 'seller1', 5, 'promo')),
    );
    expect((await w()).balance).toBe(200);
  });

  it('a spend racing a grant loses neither', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    await Promise.all([
      ...Array.from({ length: 10 }, () =>
        svc.deduct('s1', 'seller1', 5, 'gen'),
      ),
      ...Array.from({ length: 10 }, () =>
        svc.grant('s1', 'seller1', 5, 'refund'),
      ),
    ]);
    expect((await w()).balance).toBe(100);
  });

  it('two first-time callers create exactly one wallet (no E11000 500)', async () => {
    const res = await Promise.allSettled(
      Array.from({ length: 6 }, () => svc.getOrCreateWallet('s1', 'seller1')),
    );
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await Wallet.countDocuments({ storeId: 's1' })).toBe(1);
  });

  it('monthly reset keeps purchased credits and spends the monthly ones first', async () => {
    await svc.getOrCreateWallet('s1', 'seller1'); // 100 monthly
    await svc.grant('s1', 'seller1', 500, 'pack', 'purchase'); // 600 total, 500 purchased
    await svc.deduct('s1', 'seller1', 130, 'gen'); // monthly 100 gone first, then 30 of purchased
    expect((await w()).balance).toBe(470);
    expect((await w()).purchasedBalance).toBe(470);
    await svc.resetAllMonthlyAllowances(new Date('2026-11-01T03:00:00Z'));
    expect((await w()).balance).toBe(570); // 100 fresh monthly + 470 purchased survives
  });

  it('the monthly reset is idempotent per month: a re-run or concurrent run refills nobody twice', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    await svc.deduct('s1', 'seller1', 100, 'gen'); // 0 left
    const at = new Date('2026-11-01T03:00:00Z');
    const runs = await Promise.all([
      svc.resetAllMonthlyAllowances(at),
      svc.resetAllMonthlyAllowances(at),
      svc.resetAllMonthlyAllowances(at),
    ]);
    expect(runs.reduce((n, r) => n + r.reset, 0)).toBe(1);
    await svc.deduct('s1', 'seller1', 40, 'gen');
    await svc.resetAllMonthlyAllowances(at); // same month again
    expect((await w()).balance).toBe(60); // NOT refilled to 100
    await svc.resetAllMonthlyAllowances(new Date('2026-12-01T03:00:00Z'));
    expect((await w()).balance).toBe(100); // next month does reset
  });

  it('the ledger is capped so the wallet document cannot grow without bound', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    for (let i = 0; i < 230; i++) await svc.grant('s1', 'seller1', 1, `g${i}`);
    expect((await w()).ledger.length).toBe(200);
  });

  it('a reason that starts with "$" is stored literally, not evaluated', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    await svc.deduct('s1', 'seller1', 1, '$balance');
    expect((await w()).ledger.at(-1).reason).toBe('$balance');
  });

  it('rejects zero, negative and NaN amounts', async () => {
    await svc.getOrCreateWallet('s1', 'seller1');
    for (const bad of [0, -5, NaN, Infinity]) {
      await expect(svc.deduct('s1', 'seller1', bad, 'x')).rejects.toThrow();
      await expect(svc.grant('s1', 'seller1', bad, 'x')).rejects.toThrow();
    }
    expect((await w()).balance).toBe(100);
  });
});
