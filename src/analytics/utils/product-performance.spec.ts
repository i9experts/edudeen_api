/* eslint-disable prettier/prettier */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { productTypeOf } from './product-performance.util';

// Same approach as seller-overview.spec.ts: the seeded run happens in a plain node child against a real mongod.
function findMongod(): string | null {
  if (process.env.MONGOD_BIN && existsSync(process.env.MONGOD_BIN)) return process.env.MONGOD_BIN;
  const dir = join(homedir(), '.cache', 'mongodb-binaries');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^mongod/.test(n));
  return f ? join(dir, f) : null;
}
const MONGOD = findMongod();
const d = MONGOD ? describe : describe.skip;

d('product performance + Free->Paid (seeded mongod)', () => {
  let res: any;
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', join(__dirname, 'product-performance.dbcheck.ts'), MONGOD!], { encoding: 'utf8', timeout: 90000 });
    const line = (run.stdout ?? '').split('\n').find((l: string) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`dbcheck failed: ${run.stderr || run.stdout}`);
    res = JSON.parse(line.slice('RESULT:'.length));
  }, 120000);

  it('revenue of all products equals the overview booked value (cancelled, free claims and other stores excluded)', () => {
    expect(res.totalRevenue).toBe(245);
    expect(res.totalRevenue).toBe(res.bookedValue);
    expect(res.A.revenue).toBeCloseTo(150, 6);
    expect(res.B.revenue).toBeCloseTo(40, 6);
    expect(res.unallocated.revenue).toBe(55); // package without item rows still counts toward the total
  });

  it('a product twice in one package is one order; free claims are counted apart and add no revenue', () => {
    expect(res.A.orders).toBe(2);
    expect(res.A.trackedOrders).toBe(2);
    expect(res.A.freeClaims).toBe(1);
    expect(res.B.orders).toBe(1);
    expect(res.B.freeClaims).toBe(0);
  });

  it('Free->Paid: paid-before-claim, unpaid, cancelled, other-store and out-of-range claimers do not count', () => {
    // cohort = c1..c7 + c9 (c8 first claimed before the range); only c1 paid inside 30 days
    expect(res.f30).toEqual({ days: 30, claimers: 8, matured: 8, pending: 0, converted: 1, percent: 12.5 });
  });

  it('Free->Paid: longer window catches the late payer; open windows are reported as pending, not as failures', () => {
    expect(res.f90.converted).toBe(2);
    expect(res.f90.pending).toBe(1);
    expect(res.f90.matured).toBe(7);
    expect(res.f90.percent).toBeCloseTo(28.57, 2);
    expect(res.fOpen.pending).toBe(1);
    expect(res.fOpen.percent).toBeCloseTo(14.29, 2);
  });
});

describe('productTypeOf', () => {
  it('maps legacy educational to digital and courses by delivery format', () => {
    expect(productTypeOf({ productType: 'educational' })).toBe('digital');
    expect(productTypeOf({ productType: 'digital', deliveryFormat: 'course' })).toBe('course');
    expect(productTypeOf({ productType: 'physical' })).toBe('physical');
    expect(productTypeOf({})).toBe('digital');
  });
});
