/* eslint-disable prettier/prettier */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveDateRange } from './analytics-date.util';

// Real aggregation pipelines need a real mongod. Uses MONGOD_BIN, or the binary cached by
// mongodb-memory-server (~/.cache/mongodb-binaries). Without one the DB suite is skipped, not faked.
// The mongodb driver cannot complete its handshake inside Jest's sandbox, so the seeded run happens
// in a plain node process (seller-overview.dbcheck.ts) and this spec asserts on its JSON output.
function findMongod(): string | null {
  if (process.env.MONGOD_BIN && existsSync(process.env.MONGOD_BIN)) return process.env.MONGOD_BIN;
  const dir = join(homedir(), '.cache', 'mongodb-binaries');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^mongod/.test(n));
  return f ? join(dir, f) : null;
}
const MONGOD = findMongod();
const d = MONGOD ? describe : describe.skip;

d('seller analytics overview (seeded in-memory mongod)', () => {
  let res: any;

  beforeAll(() => {
    const run = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', join(__dirname, 'seller-overview.dbcheck.ts'), MONGOD!],
      { encoding: 'utf8', timeout: 90000 },
    );
    const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`dbcheck failed: ${run.stderr || run.stdout}`);
    res = JSON.parse(line.slice('RESULT:'.length));
  }, 120000);

  it('excludes free claims and cancelled; AOV = booked value / booked count; collected = paid only', () => {
    expect(res.stats.bookedCount).toBe(2);
    expect(res.stats.bookedValue).toBe(150);
    expect(res.stats.avgOrderValue).toBe(75);
    expect(res.stats.collected).toBe(100);
    expect(res.stats.freeClaims).toBe(1);
    expect(res.stats.cancelledCount).toBe(1);
  });

  it('custom "to" is inclusive to the end of that PKT day (23:30 counted, next day not)', () => {
    expect(res.inclusive).toBe(2);
  });

  it('new vs returning: 7d new <= 30d new, free claims ignored', () => {
    expect(res.s30).toEqual({ unique: 4, newCustomers: 3, returningCustomers: 1 });
    expect(res.s7).toEqual({ unique: 4, newCustomers: 2, returningCustomers: 2 });
    expect(res.s7.newCustomers).toBeLessThanOrEqual(res.s30.newCustomers);
  });
});

describe('resolveDateRange (PKT)', () => {
  it('previous period has the same length, ends 1 ms before the current one, no overlap', () => {
    const r = resolveDateRange({ range: 'custom', from: '2020-03-10', to: '2020-03-16' }, { pkt: true });
    expect(r.previousTo.getTime()).toBe(r.from.getTime() - 1);
    expect(r.to.getTime() - r.from.getTime()).toBe(r.previousTo.getTime() - r.previousFrom.getTime());
    expect(r.from.toISOString()).toBe('2020-03-09T19:00:00.000Z');
    expect(r.to.toISOString()).toBe('2020-03-16T18:59:59.999Z');
  });

  it('"Last 7 days" is today plus the previous 6 PKT days; bad ranges are refused', () => {
    const r = resolveDateRange({ range: '7d' }, { pkt: true });
    expect(Math.round((r.to.getTime() - r.from.getTime() + 1) / 86400000)).toBe(7);
    expect(() => resolveDateRange({ range: 'custom', from: '2020-03-10', to: '2020-03-01' }, { pkt: true })).toThrow();
    expect(() => resolveDateRange({ range: 'custom', from: '2030-01-01', to: '2030-01-05' }, { pkt: true })).toThrow(); // future
    expect(() => resolveDateRange({ range: 'custom', from: '2018-01-01', to: '2020-03-01' }, { pkt: true })).toThrow(); // > 12 months
  });
});
