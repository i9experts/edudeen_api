/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { parseRosterQuery, rosterCsvRows } from './students-roster.util';

const STORE = '64b0000000000000000000a1';
const OTHER = '64b0000000000000000000a2';
const P1 = '64b0000000000000000000b1';
const P2 = '64b0000000000000000000b2';
const U1 = '64b0000000000000000000c1';
const U2 = '64b0000000000000000000c2';
const chain = (v: any) => ({ select: () => chain(v), lean: () => Promise.resolve(v), sort: () => chain(v), limit: () => chain(v), then: (r: any) => Promise.resolve(v).then(r) });

function make(opts: { owner?: string; groups?: any[]; total?: number; ownsProduct?: boolean } = {}) {
  const groups = opts.groups ?? [];
  const repos: any = {
    storeModel: { findById: jest.fn(async (id: string) => (id === STORE ? { _id: STORE, sellerId: opts.owner ?? 'seller1', isDelete: false } : null)) },
    productModel: {
      findOne: jest.fn(() => chain(opts.ownsProduct === false ? null : { _id: P1 })),
      find: jest.fn((f: any) => chain(f.storeId ? [{ _id: P1, name: 'Algebra' }, { _id: P2, name: 'Worksheet' }] : [
        { _id: P1, name: 'Algebra', deliveryFormat: 'course' }, { _id: P2, name: 'Worksheet', deliveryFormat: 'download' },
      ])),
    },
    orderModel: {
      distinct: jest.fn(async () => [U1, U2]),
      aggregate: jest.fn(async () => [{ total: [{ n: opts.total ?? groups.length }], page: groups }]),
    },
    userModel: { find: jest.fn(() => chain([{ _id: U1, name: 'Ali', email: 'ali@x.com' }, { _id: U2, name: '=Evil', email: 'e@x.com' }])) },
    courseModel: { find: jest.fn(() => chain([{ productId: P1, sections: [{ lessons: [{ _id: 'l1' }, { _id: 'l2' }] }], accessDays: 30 }])) },
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

  it('maps courses (progress, access ended) and files (downloads, free label)', async () => {
    const { svc } = make({ groups: GROUPS });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', {});
    const [course, file] = out.data.rows;
    expect(course).toMatchObject({ kind: 'course', percent: 50, completedLessons: 1, totalLessons: 2, accessEnded: true, isFree: false, downloads: null });
    expect(file).toMatchObject({ kind: 'file', downloads: 3, isFree: true, percent: null, accessEnded: false, lastActivityAt: null });
    expect(out.data.products).toHaveLength(2);
  });

  it('paginates: skip/limit from page, limit capped at 50, totals reported', async () => {
    const { svc, repos } = make({ groups: GROUPS, total: 120 });
    const out: any = await svc.rosterForSeller(STORE, 'seller1', { page: '3', limit: '999' });
    const facet = repos.orderModel.aggregate.mock.calls[0][0].at(-1).$facet.page;
    expect(facet).toEqual([{ $skip: 100 }, { $limit: 50 }]);
    expect(out.data).toMatchObject({ total: 120, page: 3, limit: 50, totalPages: 3 });
  });

  it('product filter must be a valid id and a digital product of THIS store', async () => {
    await expect(make().svc.rosterForSeller(STORE, 'seller1', { productId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ ownsProduct: false }).svc.rosterForSeller(STORE, 'seller1', { productId: P1 })).rejects.toBeInstanceOf(NotFoundException);
    const { svc, repos } = make({ groups: GROUPS });
    await svc.rosterForSeller(STORE, 'seller1', { productId: P1 });
    expect(repos.productModel.findOne.mock.calls[0][0]).toMatchObject({ _id: P1, storeId: STORE, type: 'digital' });
    expect(repos.orderModel.aggregate.mock.calls[0][0][3].$match['sellerOrders.items.productId']).toBe(P1);
  });

  it('search narrows to matching buyers of the store (escaped regex, object input dropped)', async () => {
    const { svc, repos } = make({ groups: GROUPS });
    await svc.rosterForSeller(STORE, 'seller1', { q: 'a.li' });
    const rx: RegExp = repos.userModel.find.mock.calls[0][0].$or[0].name;
    expect(rx.test('a.li')).toBe(true);
    expect(rx.test('Ali')).toBe(false); // dot is literal
    expect(parseRosterQuery({ q: { $ne: 'x' } as any }).q).toBeUndefined();
  });

  it('export returns formula-safe CSV and no products list', async () => {
    const { svc } = make({ groups: GROUPS });
    const csv: any = await svc.rosterForSeller(STORE, 'seller1', {}, true);
    expect(typeof csv).toBe('string');
    expect(csv).toContain('"Student","Email"');
    expect(csv).toContain(`"'=Evil"`);
    expect(csv).toContain('"Access ended"');
  });

  it('csv rows label free claims and blank the other type\'s columns', () => {
    const rows = rosterCsvRows([{ userId: 'u', name: 'A', email: null, productId: 'p', productName: 'W', kind: 'file', enrolledAt: new Date('2026-01-02'), isFree: true, percent: null, completedLessons: null, totalLessons: null, downloads: 2, lastActivityAt: null, accessEnded: false }]);
    expect(rows[0]).toEqual(['A', '', 'W', 'File', '2026-01-02', 'Free', '', '', 2, '', 'Active']);
  });
});
