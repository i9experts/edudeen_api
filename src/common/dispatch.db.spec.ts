/* eslint-disable prettier/prettier */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Needs a real mongod (MONGOD_BIN or ~/.cache/mongodb-binaries); skipped, never faked, without one.
function findMongod(): string | null {
  if (process.env.MONGOD_BIN && existsSync(process.env.MONGOD_BIN)) return process.env.MONGOD_BIN;
  const dir = join(homedir(), '.cache', 'mongodb-binaries');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^mongod/.test(n));
  return f ? join(dir, f) : null;
}
const MONGOD = findMongod();
const d = MONGOD ? describe : describe.skip;

d('dispatch due date in Mongo == JS (seeded real mongod)', () => {
  let res: any;
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', join(__dirname, 'dispatch.dbcheck.ts'), MONGOD!], { encoding: 'utf8', timeout: 90000 });
    const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`dbcheck failed: ${run.stderr || run.stdout}`);
    res = JSON.parse(line.slice('RESULT:'.length));
  }, 120000);

  it('expression matches addWorkingDays / legacy 48 h for every weekday and N', () => {
    expect(res.exprChecked).toBe(14 * 8);
    expect(res.exprMismatches).toBe(0);
  });
  it('overdue count == JS ship-by rule; legacy and platform/shipped rows behave', () => {
    expect(res.overdueMongo).toEqual(res.overdueJs);
    expect(res.overdueMongo).toEqual([1, 2, 4]);
    expect(res.toshipMongo).toBe(res.toshipJs);
    expect(res.toshipMongo).toBe(6);
  });
  it('urgency sort order == JS order', () => {
    expect(res.sortMongo).toEqual(res.sortJs);
  });
  it('overdue query examines about the waiting packages, not the whole order history (indexed)', () => {
    expect(res.bigOverdue).toBe(50);
    expect(res.bigDocsExamined).toBeLessThan(res.bigTotal / 10);
  });
});
