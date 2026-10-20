/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';

function buildAggregateMock(resultsQueue: any[][]) {
  const queue = [...resultsQueue];
  return jest.fn().mockImplementation(async () => queue.shift() ?? []);
}

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let orderModel: any;
  let storeModel: any;
  let productModel: any;
  let productVariantModel: any;
  let userModel: any;
  let subscriptionInvoiceModel: any;
  let db: DatabaseService;
  let redis: RedisService;

  beforeEach(() => {
    orderModel = { aggregate: jest.fn().mockResolvedValue([]) };
    storeModel = {
      findOne: jest.fn().mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, name: 'Test Store' }),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: STORE_ID, baseCurrency: 'USD' }]) }) }),
    };
    productModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    productVariantModel = { aggregate: jest.fn().mockResolvedValue([]), find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    userModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    subscriptionInvoiceModel = { aggregate: jest.fn().mockResolvedValue([]) };

    db = {
      repositories: {
        orderModel, storeModel, productModel, productVariantModel, userModel, subscriptionInvoiceModel,
      },
    } as any;

    redis = { isConnected: false, get: jest.fn(), set: jest.fn(), del: jest.fn() } as any;

    service = new AnalyticsService(db, redis);
  });

  describe('ownership', () => {
    it('rejects access when the store does not belong to the requesting seller', async () => {
      storeModel.findOne.mockResolvedValueOnce(null); // simulates no match for {_id, sellerId}

      await expect(service.getOverview(SELLER_ID, STORE_ID, { range: '30d' })).rejects.toThrow(ForbiddenException);
    });

    it('scopes the ownership lookup by both storeId and sellerId, never storeId alone', async () => {
      await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(storeModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false }),
      );
    });
  });

  describe('zero-order store', () => {
    it('returns a fully zeroed overview instead of erroring', async () => {
      orderModel.aggregate.mockResolvedValue([]); // every aggregation call returns no rows

      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });

      expect(result.success).toBe(true);
      expect(result.data.totalRevenue).toBe(0);
      expect(result.data.totalOrders).toBe(0);
      expect(result.data.repeatBuyerPercent).toBe(0);
      expect(result.data.newCustomersCount).toBe(0);
      expect(result.data.refundRatePercent).toBe(0);
    });

    it('returns an empty (not errored) revenue-over-time series, zero-filled across the requested range', async () => {
      orderModel.aggregate.mockResolvedValue([]);

      const result = await service.getRevenueOverTime(SELLER_ID, STORE_ID, { range: '7d' });

      expect(result.success).toBe(true);
      expect(result.data.series.length).toBeGreaterThan(0);
      expect(result.data.series.every((s: any) => s.grossRevenue === 0 && s.netRevenue === 0)).toBe(true);
    });

    it('returns an empty top-products list instead of erroring', async () => {
      orderModel.aggregate.mockResolvedValue([]);
      const result = await service.getTopProducts(SELLER_ID, STORE_ID, { range: '30d' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('net vs gross revenue', () => {
    it('subtracts item-level refunds from gross subtotal to produce net revenue', async () => {
      orderModel.aggregate = buildAggregateMock([
        // periodTotals (current)
        [{ orderCount: 3, cancelledCount: 0, refundedCount: 1, grossRevenue: 300, refundAmount: 50, buyerIds: ['u1', 'u2'] }],
        // periodTotals (previous)
        [{ orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, buyerIds: [] }],
        // repeatBuyerPercent (current)
        [{ totalCustomers: 2, repeatCustomers: 0 }],
        // repeatBuyerPercent (previous)
        [],
        // returningBuyerSet
        [],
      ]);

      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });

      expect(result.data.grossRevenue).toBe(300);
      expect(result.data.totalRevenue).toBe(250); // net = gross - refunds
      expect(result.data.totalRefunds).toBe(50);
      expect(result.data.refundRatePercent).toBeCloseTo((50 / 300) * 100, 1); // service rounds to 2 decimals
    });
  });

  describe('repeat-buyer percent', () => {
    it('computes repeat buyers as a percentage of unique buyers in the period', async () => {
      orderModel.aggregate = buildAggregateMock([
        [{ orderCount: 5, cancelledCount: 0, refundedCount: 0, grossRevenue: 500, refundAmount: 0, buyerIds: ['a', 'b', 'c', 'd'] }],
        [{ orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, buyerIds: [] }],
        [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }, { _id: 'd' }], // buyers in the period
        [], // previous period buyers
        [{ _id: 'a', orders: 2 }, { _id: 'b', orders: 1 }, { _id: 'c', orders: 1 }, { _id: 'd', orders: 1 }], // lifetime orders
      ]);

      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(result.data.repeatBuyerPercent).toBe(25); // 1 of 4 buyers has 2+ orders
      expect(result.data.returningCustomersCount).toBe(1); // same query -> same number
      expect(result.data.newCustomersCount).toBe(3);
    });
  });

  describe('customer analytics — lifetime value', () => {
    it('computes LTV as net revenue (gross minus refunds) per customer, all-time for the store', async () => {
      orderModel.aggregate = buildAggregateMock([
        // allTimeCustomerAggregate
        [
          { _id: 'u1', firstOrderAt: new Date('2026-01-01'), lastOrderAt: new Date('2026-03-01'), totalOrders: 3, grossRevenue: 300, refundAmount: 20 },
          { _id: 'u2', firstOrderAt: new Date('2026-02-01'), lastOrderAt: new Date('2026-02-01'), totalOrders: 1, grossRevenue: 50, refundAmount: 0 },
        ],
        // periodRows (new vs returning)
        [],
        // geoRows
        [],
      ]);

      const result = await service.getCustomerAnalytics(SELLER_ID, STORE_ID, { range: '90d' });

      expect(result.data.topCustomersByLtv[0].lifetimeValue).toBe(280); // 300 - 20
      expect(result.data.topCustomersByLtv[1].lifetimeValue).toBe(50);
      expect(result.data.averageLifetimeValue).toBe((280 + 50) / 2);
    });
  });
});
