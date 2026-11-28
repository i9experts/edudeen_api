/* eslint-disable @typescript-eslint/no-unsafe-argument -- mock-heavy */
import { ForbiddenException } from '@nestjs/common';
import {
  HOME_COUNTRY,
  healthOf,
  isOverdue,
  isStuck,
  isToShip,
  medianOf,
  parseSort,
  regionOf,
  shipmentKind,
  sortRows,
  storeCountry,
  weightedPct,
  type OpenPackage,
} from './operations.util';
import { opsScopeFor } from './operations.controller';
import { OperationsService } from './operations.service';
import { permissionForRequest } from '../staff/permissions';

const NOW = new Date('2026-11-28T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const pkg = (p: Partial<OpenPackage>): OpenPackage => ({
  status: 'processing',
  fulfillmentType: 'physical',
  payable: true,
  baseAt: days(1),
  dispatchDays: 2,
  shippedAt: null,
  ...p,
});

describe('operations rules', () => {
  it('national vs international (missing country = Pakistan)', () => {
    expect(HOME_COUNTRY).toBe('PK');
    expect(regionOf('PK')).toBe('national');
    expect(regionOf(null)).toBe('national');
    expect(regionOf('pk')).toBe('national');
    expect(regionOf('AE')).toBe('international');
    expect(storeCountry('garbage')).toBe('PK');
  });

  it('domestic, cross-border or unknown parcel', () => {
    expect(shipmentKind('PK', 'PK')).toBe('domestic');
    expect(shipmentKind('PK', 'gb')).toBe('cross_border');
    expect(shipmentKind('AE', 'AE')).toBe('domestic');
    expect(shipmentKind('PK', null)).toBe('unknown');
  });

  it('stuck after 7 days domestic / unknown, 21 days cross-border', () => {
    expect(isStuck(days(6), 'domestic', NOW)).toBe(false);
    expect(isStuck(days(8), 'domestic', NOW)).toBe(true);
    expect(isStuck(days(8), 'unknown', NOW)).toBe(true);
    expect(isStuck(days(20), 'cross_border', NOW)).toBe(false);
    expect(isStuck(days(22), 'cross_border', NOW)).toBe(true);
    expect(isStuck(null, 'domestic', NOW)).toBe(false);
  });

  it('to ship only when physical, open and paid / COD; overdue past the dispatch time', () => {
    expect(isToShip(pkg({}))).toBe(true);
    expect(isToShip(pkg({ fulfillmentType: 'digital' }))).toBe(false);
    expect(isToShip(pkg({ payable: false }))).toBe(false);
    expect(isToShip(pkg({ status: 'shipped' }))).toBe(false);
    expect(isOverdue(pkg({ baseAt: days(10), dispatchDays: 2 }), NOW)).toBe(
      true,
    );
    expect(isOverdue(pkg({ baseAt: NOW, dispatchDays: 2 }), NOW)).toBe(false);
    expect(isOverdue(pkg({ baseAt: days(10), payable: false }), NOW)).toBe(
      false,
    );
  });

  it('health: late things are "action", off-target trends are "watch"', () => {
    const base = {
      overdueOrders: 0,
      unansweredOver24h: 0,
      stuckShipments: 0,
      mouStatus: null,
      responseRatePct: null,
      lateDispatchPct: null,
    };
    expect(healthOf(base).level).toBe('good');
    expect(healthOf({ ...base, overdueOrders: 2 })).toEqual({
      level: 'action',
      reasons: ['2 overdue orders'],
    });
    expect(healthOf({ ...base, unansweredOver24h: 1 }).level).toBe('action');
    expect(healthOf({ ...base, stuckShipments: 1 }).level).toBe('action');
    expect(healthOf({ ...base, mouStatus: 'expired' }).level).toBe('action');
    expect(healthOf({ ...base, mouStatus: 'expiring_soon' }).level).toBe(
      'watch',
    );
    expect(healthOf({ ...base, responseRatePct: 85 }).level).toBe('watch');
    expect(healthOf({ ...base, responseRatePct: 90 }).level).toBe('good');
    expect(healthOf({ ...base, lateDispatchPct: 11 }).level).toBe('watch');
    expect(healthOf({ ...base, lateDispatchPct: 10 }).level).toBe('good');
  });

  it('sorting puts action stores first and falls back to name', () => {
    const row = (
      name: string,
      level: 'good' | 'watch' | 'action',
      overdue = 0,
    ) => ({
      name,
      health: { level },
      listings: { active: 0 },
      orders: { toShip: 0, overdue },
      response: { unansweredOver24h: 0 },
      shipments: { stuck: 0 },
    });
    const rows = [
      row('B', 'good'),
      row('A', 'watch'),
      row('C', 'action', 1),
      row('D', 'action', 5),
    ];
    expect(sortRows(rows, 'attention').map((r) => r.name)).toEqual([
      'D',
      'C',
      'A',
      'B',
    ]);
    expect(sortRows(rows, 'name').map((r) => r.name)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(parseSort('nope')).toBe('attention');
  });

  it('summary helpers', () => {
    expect(medianOf([null, 30, 10, 20])).toBe(20);
    expect(medianOf([null])).toBeNull();
    expect(
      weightedPct([
        { pct: 100, sample: 30 },
        { pct: 50, sample: 10 },
        { pct: null, sample: 0 },
      ]),
    ).toBe(88);
    expect(weightedPct([])).toBeNull();
  });
});

describe('operations access', () => {
  it('owner and operations.view see all stores, stores.operate only assigned, others 403', () => {
    expect(opsScopeFor({ user: { userId: 'o' } })).toEqual({ all: true });
    expect(
      opsScopeFor({
        user: { userId: 's' },
        staffPermissions: new Set(['operations.view']),
      }),
    ).toEqual({ all: true });
    expect(
      opsScopeFor({
        user: { userId: 's' },
        staffPermissions: new Set(['stores.operate']),
      }),
    ).toEqual({ all: false, adminId: 's' });
    expect(() =>
      opsScopeFor({
        user: { userId: 's' },
        staffPermissions: new Set(['content.view']),
      }),
    ).toThrow(ForbiddenException);
  });

  it('the route is read-only for staff', () => {
    expect(permissionForRequest('GET', '/api/admin/operations')).toBeNull();
    expect(permissionForRequest('GET', '/api/admin/operations/abc')).toBeNull();
    expect(permissionForRequest('POST', '/api/admin/operations')).toBe(
      '__deny__',
    );
  });

  it('a team member cannot open a store that is not assigned to them', async () => {
    const svc = new OperationsService(
      { repositories: {} } as any,
      {} as any,
      {} as any,
      { exists: jest.fn().mockResolvedValue(null) } as any,
    );
    await expect(
      svc.detail({ all: false, adminId: 'a1' }, '507f1f77bcf86cd799439011'),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('operations rows (grouped queries, mocked)', () => {
  const agg = (rows: any[]) => ({
    allowDiskUse: () => Promise.resolve(rows),
    then: (f: any, r: any) => Promise.resolve(rows).then(f, r),
  });
  const lean = (rows: any[]) => ({
    select: () => ({ lean: () => Promise.resolve(rows) }),
    lean: () => Promise.resolve(rows),
  });

  it('builds one row per store from grouped results', async () => {
    const storeId = '507f1f77bcf86cd799439011';
    const orderAgg = jest
      .fn()
      // open packages
      .mockReturnValueOnce(
        agg([
          {
            orderId: 'o1',
            orderNumber: 'ED-1',
            createdAt: days(10),
            storeId,
            status: 'processing',
            fulfillmentType: 'physical',
            payable: true,
            baseAt: days(10),
            dispatchDays: 2,
            shippedAt: null,
            buyerCountry: 'PK',
          },
          {
            orderId: 'o2',
            orderNumber: 'ED-2',
            createdAt: days(30),
            storeId,
            status: 'shipped',
            fulfillmentType: 'physical',
            payable: true,
            baseAt: days(30),
            dispatchDays: 2,
            shippedAt: days(25),
            buyerCountry: 'GB',
          },
          {
            orderId: 'o3',
            orderNumber: 'ED-3',
            createdAt: days(0),
            storeId,
            status: 'pending',
            fulfillmentType: 'physical',
            payable: true,
            baseAt: NOW,
            dispatchDays: 2,
            shippedAt: null,
            buyerCountry: null,
          },
        ]),
      )
      // recent packages
      .mockReturnValueOnce(
        agg([
          {
            _id: { storeId, country: 'PK' },
            total: 4,
            delivered: 3,
            cancelledBySeller: 1,
          },
          {
            _id: { storeId, country: 'GB' },
            total: 1,
            delivered: 0,
            cancelledBySeller: 0,
          },
          {
            _id: { storeId, country: null },
            total: 2,
            delivered: 1,
            cancelledBySeller: 0,
          },
        ]),
      )
      // open returns
      .mockReturnValueOnce(agg([{ _id: storeId, n: 2 }]));
    const db: any = {
      repositories: {
        sellerModel: {
          find: () => lean([{ _id: 's1', name: 'Seller', email: 's@x.com' }]),
        },
        adminModel: { find: () => lean([{ _id: 'a1', name: 'Ali' }]) },
        productModel: {
          aggregate: () =>
            agg([
              {
                _id: storeId,
                active: 5,
                drafts: 1,
                pendingReview: 1,
                rejected: 1,
                inactive: 0,
                missingPhotos: 2,
              },
            ]),
          find: () =>
            lean([
              { _id: 'p1', storeId },
              { _id: 'p2', storeId },
            ]),
        },
        productVariantModel: {
          aggregate: () =>
            agg([
              { _id: 'p1', stock: 0, unlimited: 0 },
              { _id: 'p2', stock: 3, unlimited: 0 },
            ]),
        },
        conversationModel: {
          aggregate: () =>
            agg([{ _id: storeId, unanswered: 3, over24h: 2, oldest: days(3) }]),
        },
        orderModel: { aggregate: orderAgg },
      },
    };
    const questions: any = { aggregate: () => agg([{ _id: storeId, n: 4 }]) };
    const assignments: any = {
      find: () => lean([{ storeId, adminId: 'a1', role: 'account_manager' }]),
    };
    const svc = new OperationsService(db, {} as any, questions, assignments);
    const [row] = await svc.buildRows(
      [
        {
          _id: storeId,
          name: 'Karachi Books',
          slug: 'kb',
          sellerId: 's1',
          country: 'PK',
          managementType: 'managed',
          mou: {
            commissionRate: 0.3,
            startDate: days(100),
            endDate: days(-10),
          },
          responseStats: { medianReplyMinutes: 45 },
          trustStats: {
            responseRate: { pct: 80, sample: 20 },
            dispatch: { pct: 85, sample: 20 },
          },
        },
      ],
      NOW,
    );

    expect(row.listings).toEqual({
      active: 5,
      drafts: 1,
      pendingReview: 1,
      rejected: 1,
      inactive: 0,
      missingPhotos: 2,
      outOfStock: 1,
      issues: 4,
    });
    expect(row.response).toMatchObject({
      medianReplyMinutes: 45,
      responseRatePct: 80,
      unanswered: 3,
      unansweredOver24h: 2,
      unansweredQuestions: 4,
    });
    expect(row.orders).toEqual({
      new: 1,
      toShip: 2,
      overdue: 1,
      inTransit: 1,
      delivered30d: 4,
      cancelledBySeller30d: 1,
      returnsOpen: 2,
    });
    expect(row.shipments).toMatchObject({
      inTransit: 1,
      stuck: 1,
      onTimeDispatchPct: 85,
      lateDispatchPct: 15,
      domestic30d: 4,
      crossBorder30d: 1,
      unknown30d: 2,
    });
    expect(row.mouStatus).toBe('expiring_soon');
    expect(row.commissionRate).toBe(0.3);
    expect(row.assignees).toEqual([
      { adminId: 'a1', name: 'Ali', role: 'account_manager' },
    ]);
    expect(row.region).toBe('national');
    expect(row.health.level).toBe('action');
  });
});
