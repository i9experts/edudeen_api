/* eslint-disable prettier/prettier */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Real aggregation needs a real mongod (same approach as analytics seller-overview.spec): the seeded run
// happens in a plain node process and this spec asserts on its JSON. Skipped when no mongod binary exists.
function findMongod(): string | null {
  if (process.env.MONGOD_BIN && existsSync(process.env.MONGOD_BIN)) return process.env.MONGOD_BIN;
  const dir = join(homedir(), '.cache', 'mongodb-binaries');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^mongod/.test(n));
  return f ? join(dir, f) : null;
}
const MONGOD = findMongod();
const d = MONGOD ? describe : describe.skip;

d('promotionStats (seeded mongod)', () => {
  let res: any;
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', join(__dirname, 'promotion-stats.dbcheck.ts'), MONGOD!], { encoding: 'utf8', timeout: 90000 });
    const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`dbcheck failed: ${run.stderr || run.stdout}`);
    res = JSON.parse(line.slice('RESULT:'.length));
  }, 120000);

  it('a coupon order adds to that coupon: orders, discount and ITS package revenue (new couponId + legacy code match)', () => {
    // 3 orders: 200 (2 lines = 1 order) + 100 (20 d ago) + 300 (multi-store, own package) + legacy 50
    expect(res.c1_30).toMatchObject({ uses: 4, orders: 4, discount: 30 + 5 + 15 + 4, revenue: 200 + 100 + 300 + 50 });
  });

  it('range filter: 7 days leaves out the 20-day-old order', () => {
    expect(res.c1_7).toMatchObject({ uses: 3, discount: 30 + 15 + 4, revenue: 200 + 300 + 50 });
  });

  it('automatic discount and platform sale are reported by their own ids', () => {
    expect(res.a1).toMatchObject({ orders: 1, discount: 8, revenue: 80 });
    expect(res.cam1).toMatchObject({ orders: 1, discount: 12, revenue: 80 });
  });

  it('multi-store order counts only this store: other stores promotions and subtotals never appear', () => {
    expect(res.s1_hasOtherStoreIds).toBe(false);
    expect(res.s2).toEqual(['coupon:C2:1:90:900', 'discount:A9:1:7:900']);
  });

  it("another seller's / unknown store gets nothing", () => {
    expect(res.other).toBe(0);
  });
});
