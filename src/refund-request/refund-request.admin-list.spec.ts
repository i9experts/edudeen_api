/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { RefundRequestService } from './refund-request.service';

const REQUESTS = [
  { _id: 'r1', orderId: 'order-1', storeId: 'store-1', requestedBy: 'buyer-1', status: 'pending', createdAt: new Date('2026-01-01') },
  { _id: 'r2', orderId: 'order-2', storeId: 'store-2', requestedBy: 'buyer-2', status: 'approved', createdAt: new Date('2026-01-03') },
];
const ORDERS = [{ _id: 'order-1', orderNumber: 'O-100' }, { _id: 'order-2', orderNumber: 'O-200' }];
const STORES = [{ _id: 'store-1', name: 'Books Corner' }, { _id: 'store-2', name: 'Gadget Hub' }];
const USERS = [{ _id: 'buyer-1', name: 'Alice', email: 'alice@example.com' }, { _id: 'buyer-2', name: 'Bob', email: 'bob@example.com' }];

/** A chainable `.find()` stub that just records the filter it was called with
 *  and resolves to a fixed row set — same approach as admin-orders.spec.ts,
 *  since these tests exercise the service's shaping/enrichment, not Mongo's
 *  own query matching. */
function chain(rows: any[], onFind?: (filter: any) => void) {
  return jest.fn((filter: any) => {
    onFind?.(filter);
    let sortArg: Record<string, 1 | -1> | null = null;
    const api: any = {
      sort: (s: any) => { sortArg = s; return api; },
      select: () => api,
      skip: () => api,
      limit: () => api,
      lean: () => Promise.resolve(sortArg ? sortRows(rows, sortArg) : rows),
    };
    return api;
  });
}
function sortRows(rows: any[], sort: Record<string, 1 | -1>) {
  const [key, dir] = Object.entries(sort)[0];
  return [...rows].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir as number));
}

function build() {
  let lastMatch: any = null;
  const refundRequestModel: any = {
    find: chain(REQUESTS, (f) => { lastMatch = f; }),
    countDocuments: jest.fn((f: any) => { lastMatch = f; return Promise.resolve(REQUESTS.length); }),
  };
  const orderModel: any = { find: chain(ORDERS) };
  const storeModel: any = { find: chain(STORES) };
  const userModel: any = { find: chain(USERS) };
  const repos = { refundRequestModel, orderModel, storeModel, userModel };
  const svc = new RefundRequestService(
    { repositories: repos } as any, {} as any, {} as any, {} as any, { log: jest.fn() } as any,
  );
  return { svc, repos, getLastMatch: () => lastMatch };
}

describe('RefundRequestService.listForAdmin', () => {
  it('enriches rows with order number, store name and requester name/email', async () => {
    const { svc } = build();
    const res = await svc.listForAdmin({});
    // No status filter sorts newest-first (r2, created 2026-01-03, before r1).
    expect(res.data.items).toEqual([
      expect.objectContaining({ _id: 'r2', orderNumber: 'O-200', storeName: 'Gadget Hub', requester: { name: 'Bob', email: 'bob@example.com' } }),
      expect.objectContaining({ _id: 'r1', orderNumber: 'O-100', storeName: 'Books Corner', requester: { name: 'Alice', email: 'alice@example.com' } }),
    ]);
    expect(res.data.total).toBe(2);
  });

  it('passes status, storeId and date range through to the query', async () => {
    const { svc, getLastMatch } = build();
    await svc.listForAdmin({ status: 'approved', storeId: 'store-2', from: '2026-01-01', to: '2026-01-31' });
    const match = getLastMatch();
    expect(match.status).toBe('approved');
    expect(match.storeId).toBe('store-2');
    expect(match.createdAt.$gte).toEqual(new Date('2026-01-01'));
    expect(match.createdAt.$lte.getDate()).toBe(31);
  });

  it('sorts oldest-first when filtering to pending, newest-first otherwise', async () => {
    const { svc: pendingSvc } = build();
    const pending = await pendingSvc.listForAdmin({ status: 'pending' });
    expect(pending.data.items.map((i: any) => i._id)).toEqual(['r1', 'r2']); // ascending createdAt

    const { svc: allSvc } = build();
    const all = await allSvc.listForAdmin({});
    expect(all.data.items.map((i: any) => i._id)).toEqual(['r2', 'r1']); // descending createdAt
  });

  it('a free-text search that matches no order or requester returns empty without querying refund requests', async () => {
    const { svc, repos } = build();
    (repos.orderModel.find as jest.Mock).mockReturnValueOnce({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    (repos.userModel.find as jest.Mock).mockReturnValueOnce({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    const res = await svc.listForAdmin({ q: 'no-such-thing' });
    expect(res.data).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    expect(repos.refundRequestModel.find).not.toHaveBeenCalled();
  });

  it('a search matching an order narrows the query to that order id', async () => {
    const { svc, repos, getLastMatch } = build();
    (repos.orderModel.find as jest.Mock).mockReturnValueOnce({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([{ _id: 'order-1' }]) }) }) });
    (repos.userModel.find as jest.Mock).mockReturnValueOnce({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    await svc.listForAdmin({ q: 'O-100' });
    expect(getLastMatch().$or).toEqual([{ orderId: { $in: ['order-1'] } }]);
  });
});
