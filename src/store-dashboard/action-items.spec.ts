import { ForbiddenException } from '@nestjs/common';
import { computeActionItems, parseOrderAction, sellerOrdersActionFilter } from './action-items.util';
import { StoreDashboardService } from './store-dashboard.service';

const NOW = new Date('2026-11-05T12:00:00Z');

function models(over: Record<string, number> = {}) {
  const count = (key: string, dflt = 0) => ({ countDocuments: jest.fn().mockResolvedValue(over[key] ?? dflt) });
  const orderCalls: any[] = [];
  const orderModel = {
    countDocuments: jest.fn().mockImplementation((f: any) => {
      orderCalls.push(f);
      // 1st call = to ship, 2nd = overdue (Promise.all keeps call order)
      return Promise.resolve(orderCalls.length === 1 ? over.toShip ?? 0 : over.overdue ?? 0);
    }),
    aggregate: jest.fn().mockResolvedValue(over.returns ? [{ n: over.returns }] : []),
  };
  return { orderModel, orderCalls, conversationModel: count('unread'), questionModel: count('questions'), productModel: { countDocuments: jest.fn().mockImplementation((f: any) => Promise.resolve(f.status === 'pending_review' ? over.pending ?? 0 : f.status === 'rejected' ? over.rejected ?? 0 : 0)) } };
}

describe('action items', () => {
  it('returns every count and scopes each query to the store', async () => {
    const m = models({ toShip: 4, overdue: 1, returns: 2, unread: 3, questions: 5, pending: 6, rejected: 7 });
    const r = await computeActionItems(m as any, 'store1', 'seller1', true, NOW);
    expect(r).toEqual({
      ordersToShip: 4, ordersOverdue: 1, returnsPending: 2, unreadMessages: 3,
      unansweredQuestions: 5, pendingReview: 6, rejected: 7, payoutMissing: 1,
    });
    expect(m.conversationModel.countDocuments).toHaveBeenCalledWith({ storeId: 'store1', deletedBySeller: false, isArchived: { $ne: true }, sellerUnread: { $gt: 0 } });
    expect(m.questionModel.countDocuments).toHaveBeenCalledWith({ storeId: 'store1', answeredAt: null, hidden: false });
    expect(m.orderCalls[0]['sellerOrders.storeId']).toBe('store1');
    expect(m.orderModel.aggregate.mock.calls[0][0][0].$match['sellerOrders.storeId']).toBe('store1');
  });

  it('payout present -> 0, and zero everywhere when nothing is waiting', async () => {
    const r = await computeActionItems(models() as any, 's', 'u', false, NOW);
    expect(Object.values(r).every((n) => n === 0)).toBe(true);
  });

  it('to-ship filter excludes digital-only, platform-handled, free claims and unpaid non-COD', () => {
    const f = sellerOrdersActionFilter(['s1'], 'toship', NOW) as any;
    expect(f.isFreeClaim).toEqual({ $ne: true });
    const em = f.$and[0].sellerOrders.$elemMatch;
    expect(em.fulfillmentType).toEqual({ $in: ['physical', 'mixed'] });
    expect(em.status).toEqual({ $in: ['pending', 'processing'] });
    expect(em.fulfillmentMode).toEqual({ $ne: 'platform' });
    expect(f.$and[1].$or).toEqual(expect.arrayContaining([{ isPaid: true }, { paymentType: 'cash_on_delivery' }]));
    expect(f.$and).toHaveLength(2);
  });

  it('overdue adds a cheap 24h bound plus the exact per-package due rule', () => {
    const f = sellerOrdersActionFilter(['s1'], 'overdue', NOW) as any;
    expect(f.$and).toHaveLength(4);
    expect(f.$and[3].$expr.$anyElementTrue).toBeDefined();
    const cutoff = new Date(NOW.getTime() - 24 * 3_600_000);
    expect(f.$and[2].$or[0]).toEqual({ paidAt: { $lte: cutoff } });
    expect(f.$and[2].$or[1]).toEqual({ paidAt: null, createdAt: { $lte: cutoff } });
  });

  it('parseOrderAction only accepts the two known values', () => {
    expect(parseOrderAction('toship')).toBe('toship');
    expect(parseOrderAction('overdue')).toBe('overdue');
    expect(parseOrderAction('x')).toBeNull();
    expect(parseOrderAction(undefined)).toBeNull();
  });

  it("another seller's storeId is rejected", async () => {
    const storeModel = { findOne: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) }) };
    const svc = new StoreDashboardService({ repositories: { storeModel } } as any, {} as any, {} as any);
    await expect(svc.getSummary('intruder', 'store1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(storeModel.findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: 'store1', sellerId: 'intruder' }));
  });
});
