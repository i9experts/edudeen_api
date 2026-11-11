/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { buildRosterView, compareRoster, parseRosterQuery, rosterCsvRows, rosterStatus, type RosterRow } from './students-roster.util';

const STORE = '64b0000000000000000000a1';
const OTHER = '64b0000000000000000000a2';
const P1 = '64b0000000000000000000b1';
const P2 = '64b0000000000000000000b2';
const U1 = '64b0000000000000000000c1';
const U2 = '64b0000000000000000000c2';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), then: (r: any) => Promise.resolve(v).then(r) });

function make(opts: { owner?: string; groups?: any[]; ownsProduct?: boolean; testProducts?: string[]; orders?: any[] } = {}) {
  const groups = opts.groups ?? [];
  const products = [
    { _id: P1, name: 'Algebra', deliveryFormat: 'course', status: 'active', isTest: opts.testProducts?.includes(P1) },
    { _id: P2, name: 'Worksheet', deliveryFormat: 'download', status: 'inactive', isTest: opts.testProducts?.includes(P2) },
  ];
  const repos: any = {
    storeModel: { findById: jest.fn(async (id: string) => (id === STORE ? { _id: STORE, sellerId: opts.owner ?? 'seller1', isDelete: false } : null)) },
    productModel: {
      findOne: jest.fn(() => chain(opts.ownsProduct === false ? null : { _id: P1 })),
      find: jest.fn((f: any) => chain(f.storeId ? products.filter(p => !p.isTest) : products)),
    },
    orderModel: {
      aggregate: jest.fn(async () => groups),
      find: jest.fn(() => chain(opts.orders ?? [])),
    },
    userModel: {
      find: jest.fn(() => chain([{ _id: U1, name: 'Ali', email: 'ali.khan@gmail.com' }, { _id: U2, name: '=Evil', email: 'evil@x.com' }])),
      findById: jest.fn(() => chain({ _id: U1, name: 'Ali', email: 'ali.khan@gmail.com' })),
    },
    courseModel: { find: jest.fn(() => chain([{ productId: P1, sections: [{ title: 'S1', lessons: [{ _id: 'l1', title: 'One' }, { _id: 'l2', title: 'Two' }] }], accessDays: 30 }])) },
  };
  const progressModel: any = { find: jest.fn(() => chain([{ userId: U1, productId: P1, completedLessonIds: ['l1'], updatedAt: new Date('2026-01-05') }])) };
  const svc = new CoursesService(progressModel, { repositories: repos } as any, {} as any, {} as any);
  return { svc, repos };
}
const old = new Date(Date.now() - 100 * 86400000);
const GROUPS = [
  { _id: { u: U1, p: P1 }, firstAt: old, lastAt: old, downloads: 0, free: 0 },
  { _id: { u: U2, p: P2 }, firstAt: new Date(), lastAt: new Date(), downloads: 3, free: 1 },
];

const row = (o: Partial<RosterRow>): RosterRow => ({
  userId: 'u', name: 'A', email: null, productId: 'p', productName: 'P', kind: 'course', enrolledAt: new Date('2026-01-01'), isFree: false,
  percent: 0, completedLessons: 0, totalLessons: 4, downloads: null, lastActivityAt: null, accessEnded: false, ...o,
});

describe('store students roster', () => {
  it('rejects a store owned by someone else and a missing store', async () => {
    const { svc, repos } = make({ owner: 'other-seller' });
    await expect(svc.rosterForSeller(STORE, 'seller1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.rosterForSeller(OTHER, 'seller1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(repos.orderModel.aggregate).not.toHaveBeenCalled();
  });

  it('scopes the order query to this store and to digital, live items only', async () => {
    const { svc, repos } = make({ groups: GROUPS });
    await svc.rosterForSeller(STORE, 'seller1', {});
    const pipe = repos.orderModel.aggregate.mock.calls[0][0];
    expect(pipe[0].$match['sellerOrders.storeId']).toBe(STORE);
    const itemMatch = pipe[3].$match;
    expect(itemMatch['sellerOrders.storeId']).toBe(STORE);
    expect(itemMatch['sellerOrders.items.type'].$in).toEqual(['digital', 'educational']);
    expect(itemMatch['sellerOrders.items.status'].$nin).toEqual(['cancelled', 'refunded']);
    expect(pipe[0].$match.$or).toEqual([{ isPaid: true }, { isFreeClaim: true }]);
  });

  it('maps courses (progress, access ended, status) and files (downloads, free label)', async () => {
    const { svc } = make({ groups: GROUPS });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', { sort: 'enrolled', order: 'asc' });
    const [course, file] = out.data.rows;
    expect(course).toMatchObject({ kind: 'course', percent: 50, completedLessons: 1, totalLessons: 2, accessEnded: true, isFree: false, downloads: null, status: 'in_progress', inactive14: true });
    expect(file).toMatchObject({ kind: 'file', downloads: 3, isFree: true, percent: null, accessEnded: false, lastActivityAt: null, status: 'completed' });
    expect(out.data.stats).toMatchObject({ totalStudents: 2, avgCompletionPct: 50, active7d: 0 });
    expect(out.data.statusCounts).toEqual({ all: 2, notStarted: 0, inProgress: 1, completed: 1, inactive14: 1 });
  });

  it('product options: no test products, live ones or ones with enrolments, with counts', async () => {
    const { svc } = make({ groups: GROUPS });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', {});
    expect(out.data.products).toEqual([{ id: P1, name: 'Algebra', count: 1 }, { id: P2, name: 'Worksheet', count: 1 }]);
    const none = make({ groups: [] });
    const o2: any = await none.svc.rosterForSeller(STORE, 'seller1', {});
    expect(o2.data.products).toEqual([{ id: P1, name: 'Algebra', count: 0 }]); // inactive, no enrolments -> hidden
  });

  it('test products disappear from rows, stats, chips and CSV', async () => {
    const { svc } = make({ groups: GROUPS, testProducts: [P2] });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', {});
    expect(out.data.rows.map((r: any) => r.productId)).toEqual([P1]);
    expect(out.data.statusCounts.all).toBe(1);
    expect(out.data.stats.totalStudents).toBe(1);
    const csv: any = await svc.rosterForSeller(STORE, 'seller1', {}, true);
    expect(csv).not.toContain('Worksheet');
  });

  it('paginates in memory: 25 per page default, limit capped at 50, status filter before paging', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ _id: { u: `64b00000000000000000${String(1000 + i)}`, p: P2 }, firstAt: new Date(2026, 0, i + 1), lastAt: new Date(), downloads: 0, free: 0 }));
    const { svc } = make({ groups: many });
    const p1: any = await svc.rosterForSeller(STORE, 'seller1', {});
    const p2: any = await svc.rosterForSeller(STORE, 'seller1', { page: '2' });
    expect(p1.data.rows).toHaveLength(25);
    expect(p2.data.rows).toHaveLength(5);
    expect(p1.data).toMatchObject({ total: 30, limit: 25, totalPages: 2 });
    const big: any = await svc.rosterForSeller(STORE, 'seller1', { limit: '999' });
    expect(big.data.limit).toBe(50);
    const comp: any = await svc.rosterForSeller(STORE, 'seller1', { status: 'completed' });
    expect(comp.data.total).toBe(0); // files with 0 downloads = not started
    const ns: any = await svc.rosterForSeller(STORE, 'seller1', { status: 'not_started' });
    expect(ns.data.total).toBe(30);
  });

  it('product filter must be a valid id and a digital product of THIS store', async () => {
    await expect(make().svc.rosterForSeller(STORE, 'seller1', { productId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ ownsProduct: false }).svc.rosterForSeller(STORE, 'seller1', { productId: P1 })).rejects.toBeInstanceOf(NotFoundException);
    const { svc, repos } = make({ groups: GROUPS });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', { productId: P1 });
    expect(repos.productModel.findOne.mock.calls[0][0]).toMatchObject({ _id: P1, storeId: STORE, type: 'digital' });
    expect(out.data.rows.map((r: any) => r.productId)).toEqual([P1]);
  });

  it('search matches the NAME only (not e-mail); object input dropped', async () => {
    const { svc } = make({ groups: GROUPS });
    const byName: any = await svc.rosterForSeller(STORE, 'seller1', { q: 'ali' });
    expect(byName.data.rows.map((r: any) => r.userId)).toEqual([U1]);
    const byMail: any = await svc.rosterForSeller(STORE, 'seller1', { q: 'gmail' });
    expect(byMail.data.total).toBe(0);
    const zzzz: any = await svc.rosterForSeller(STORE, 'seller1', { q: 'zzzz' });
    expect(zzzz.data.rows).toEqual([]);
    expect(parseRosterQuery({ q: { $ne: 'x' } as any }).q).toBeUndefined();
  });

  it('bad sort / order / status values are a 400, defaults are enrolled desc / all', () => {
    expect(() => parseRosterQuery({ sort: 'email' })).toThrow(BadRequestException);
    expect(() => parseRosterQuery({ order: 'up' })).toThrow(BadRequestException);
    expect(() => parseRosterQuery({ status: 'weird' })).toThrow(BadRequestException);
    expect(() => parseRosterQuery({ sort: ['name'] as any })).toThrow(BadRequestException);
    expect(parseRosterQuery({})).toMatchObject({ sort: 'enrolled', order: 'desc', status: 'all', limit: 25, page: 1 });
  });

  it('NO response or CSV contains a full e-mail address', async () => {
    const { svc } = make({ groups: GROUPS });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', {});
    const json = JSON.stringify(out);
    expect(json).not.toContain('ali.khan@gmail.com');
    expect(json).not.toContain('evil@x.com');
    expect(json).toContain('a***n@gmail.com');
    const csv: any = await svc.rosterForSeller(STORE, 'seller1', {}, true);
    expect(csv).not.toContain('ali.khan@gmail.com');
    expect(csv).toContain('a***n@gmail.com');
    const { svc: s2 } = make({ orders: [{ orderNumber: 'ORD-1', createdAt: new Date(), isFreeClaim: false, sellerOrders: [{ storeId: STORE, items: [{ productId: P1, type: 'digital', status: 'delivered' }] }] }] });
    const d: any = await s2.rosterStudentDetail(STORE, 'seller1', U1);
    expect(JSON.stringify(d)).not.toContain('ali.khan@gmail.com');
  });

  it('export returns formula-safe CSV with status and no products list', async () => {
    const { svc } = make({ groups: GROUPS });
    const csv: any = await svc.rosterForSeller(STORE, 'seller1', {}, true);
    expect(typeof csv).toBe('string');
    expect(csv).toContain('"Student","Email"');
    expect(csv).toContain(`"'=Evil"`);
    expect(csv).toContain('"Access ended"');
    expect(csv).toContain('"In progress"');
  });

  it('export follows q, product, status and sort', async () => {
    const { svc } = make({ groups: GROUPS });
    const csv: any = await svc.rosterForSeller(STORE, 'seller1', { status: 'completed' }, true);
    expect(csv).toContain('Worksheet');
    expect(csv).not.toContain('Algebra');
  });

  it('csv rows label free claims and blank the other type\'s columns', () => {
    const rows = rosterCsvRows([row({ kind: 'file', name: 'A', productName: 'W', isFree: true, percent: null, completedLessons: null, totalLessons: null, downloads: 2, status: 'completed' })]);
    expect(rows[0]).toEqual(['A', '', 'W', 'File', '2026-01-01', 'Free', '', '', 2, '', 'Completed', 'Active']);
  });

  describe('status rule', () => {
    const now = Date.parse('2026-06-30');
    const d = (n: number) => new Date(now - n * 86400000);
    it('course: 0 / 1-99 / 100 / certificate; inactive only when in progress and idle > 14 days', () => {
      expect(rosterStatus(row({ percent: 0 }), now).status).toBe('not_started');
      expect(rosterStatus(row({ percent: 40, lastActivityAt: d(3) }), now)).toEqual({ status: 'in_progress', inactive14: false });
      expect(rosterStatus(row({ percent: 40, lastActivityAt: d(15) }), now)).toEqual({ status: 'in_progress', inactive14: true });
      expect(rosterStatus(row({ percent: 100, lastActivityAt: d(90) }), now)).toEqual({ status: 'completed', inactive14: false });
      expect(rosterStatus(row({ percent: 60, completed: true }), now).status).toBe('completed');
    });
    it('file: downloads > 0 = completed, else not started; never in progress or inactive', () => {
      expect(rosterStatus(row({ kind: 'file', percent: null, downloads: 0 }), now)).toEqual({ status: 'not_started', inactive14: false });
      expect(rosterStatus(row({ kind: 'file', percent: null, downloads: 2 }), now)).toEqual({ status: 'completed', inactive14: false });
    });
    it('chip counts equal the rows of each status filter', () => {
      const rows = [row({ userId: '1', percent: 0 }), row({ userId: '2', percent: 50, lastActivityAt: d(1) }), row({ userId: '3', percent: 50, lastActivityAt: d(30) }), row({ userId: '4', percent: 100 })];
      const q = { sort: 'name' as const, order: 'asc' as const, page: 1, limit: 25 };
      const all = buildRosterView(rows, rows, { ...q, status: 'all' }, now);
      expect(all.statusCounts).toEqual({ all: 4, notStarted: 1, inProgress: 2, completed: 1, inactive14: 1 });
      expect(buildRosterView(rows, rows, { ...q, status: 'in_progress' }, now).total).toBe(2);
      expect(buildRosterView(rows, rows, { ...q, status: 'completed' }, now).total).toBe(1);
      expect(buildRosterView(rows, rows, { ...q, status: 'inactive14' }, now).total).toBe(1);
    });
    it('stats: distinct buyers, course-only average, active in 7 days', () => {
      const rows = [row({ userId: '1', productId: 'a', percent: 100, lastActivityAt: d(2) }), row({ userId: '1', productId: 'b', percent: 0 }), row({ userId: '2', kind: 'file', percent: null, downloads: 1 })];
      expect(buildRosterView(rows, rows, { sort: 'name', order: 'asc', status: 'all', page: 1, limit: 25 }, now).stats).toEqual({ totalStudents: 2, avgCompletionPct: 50, active7d: 1 });
      const files = [row({ kind: 'file', percent: null, downloads: 0 })];
      expect(buildRosterView(files, files, { sort: 'name', order: 'asc', status: 'all', page: 1, limit: 25 }, now).stats.avgCompletionPct).toBeNull();
    });
  });

  describe('sorting', () => {
    const rows = [
      row({ userId: 'c', name: 'Cara', percent: 80, lastActivityAt: new Date('2026-03-01'), enrolledAt: new Date('2026-01-03') }),
      row({ userId: 'a', name: 'Ali', percent: 20, lastActivityAt: new Date('2026-05-01'), enrolledAt: new Date('2026-01-01') }),
      row({ userId: 'f', name: 'Fay', kind: 'file', percent: null, downloads: 1, lastActivityAt: null, enrolledAt: new Date('2026-01-02') }),
    ];
    const ids = (s: any, o: any) => [...rows].sort(compareRoster(s, o)).map(r => r.userId);
    it('progress: files (null) last in BOTH directions', () => {
      expect(ids('progress', 'asc')).toEqual(['a', 'c', 'f']);
      expect(ids('progress', 'desc')).toEqual(['c', 'a', 'f']);
    });
    it('activity: no activity last in both directions', () => {
      expect(ids('activity', 'asc')).toEqual(['c', 'a', 'f']);
      expect(ids('activity', 'desc')).toEqual(['a', 'c', 'f']);
    });
    it('name and enrolled sort both ways with a stable tiebreak', () => {
      expect(ids('name', 'asc')).toEqual(['a', 'c', 'f']);
      expect(ids('name', 'desc')).toEqual(['f', 'c', 'a']);
      expect(ids('enrolled', 'desc')).toEqual(['c', 'f', 'a']);
      const same = [row({ userId: 'b', productId: '2' }), row({ userId: 'b', productId: '1' }), row({ userId: 'a', productId: '9' })];
      expect(same.sort(compareRoster('progress', 'desc')).map(r => `${r.userId}${r.productId}`)).toEqual(['a9', 'b1', 'b2']);
    });
    it('a course with 0 lessons is 0%', async () => {
      const { svc } = make({ groups: [GROUPS[0]] });
      (svc as any).r.courseModel.find = jest.fn(() => chain([{ productId: P1, sections: [] }]));
      const out: any = await svc.rosterForSeller(STORE, 'seller1', {});
      expect(out.data.rows[0].percent).toBe(0);
    });
  });

  describe('student detail', () => {
    const order = (o: any = {}) => ({ orderNumber: 'ORD-9', createdAt: new Date('2026-02-01'), isFreeClaim: false, sellerOrders: [{ storeId: STORE, items: [{ productId: P1, type: 'digital', status: 'delivered' }, { productId: P2, type: 'digital', status: 'delivered', downloadCount: 4 }] }], ...o });
    it('other seller 403, non-student 404', async () => {
      await expect(make({ owner: 'other-seller' }).svc.rosterStudentDetail(STORE, 'seller1', U1)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(make({ orders: [] }).svc.rosterStudentDetail(STORE, 'seller1', U1)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('only a test product held = 404', async () => {
      await expect(make({ orders: [order()], testProducts: [P1, P2] }).svc.rosterStudentDetail(STORE, 'seller1', U1)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('course gets a lesson checklist, file a download count, orders listed', async () => {
      const { svc } = make({ orders: [order()] });
      const out: any = await svc.rosterStudentDetail(STORE, 'seller1', U1);
      const [course, file] = out.data.items;
      expect(course.sections[0].lessons).toEqual([{ title: 'One', done: true }, { title: 'Two', done: false }]);
      expect(course.percent).toBe(50);
      expect(file).toMatchObject({ kind: 'file', downloads: 4 });
      expect(course.orders).toEqual([{ orderNumber: 'ORD-9', free: false }]);
      expect(out.data.email).toBe('a***n@gmail.com');
    });
  });
});
