import { DISPATCH_HOURS } from 'src/messaging/response-stats.util';
import { packageStatusesForTab, parseOrderTab, sellerShipBy, shipByUrgencySort } from './action-items.util';

const T0 = new Date('2026-11-01T10:00:00Z');
const pkg = (o: any = {}) => ({ fulfillmentType: 'physical', status: 'pending', ...o });

describe('seller order tabs', () => {
  it('parses tabs and rejects unknown ones', () => {
    expect(parseOrderTab(undefined)).toBeNull();
    expect(parseOrderTab('')).toBeNull();
    expect(parseOrderTab('shipped')).toBe('shipped');
    expect(parseOrderTab('bogus')).toBe('invalid');
    expect(parseOrderTab(['all'])).toBe('invalid');
  });

  it('maps tabs to package statuses', () => {
    expect(packageStatusesForTab('needs_action')).toEqual(['pending', 'processing']);
    expect(packageStatusesForTab('cancelled')).toEqual(['cancelled']);
    expect(packageStatusesForTab('all')).toBeNull();
  });

  it('ship-by = payment time + DISPATCH_HOURS (COD: creation)', () => {
    const paid = sellerShipBy({ isPaid: true, paidAt: T0, createdAt: new Date('2026-10-30T00:00:00Z') }, pkg());
    expect(paid!.getTime()).toBe(T0.getTime() + DISPATCH_HOURS * 3_600_000);
    const cod = sellerShipBy({ paymentType: 'cash_on_delivery', paidAt: null, createdAt: T0 }, pkg());
    expect(cod!.getTime()).toBe(T0.getTime() + DISPATCH_HOURS * 3_600_000);
  });

  it('no ship-by for digital, shipped, platform-fulfilled or unpaid non-COD packages', () => {
    const paid = { isPaid: true, paidAt: T0, createdAt: T0 };
    expect(sellerShipBy(paid, pkg({ fulfillmentType: 'digital' }))).toBeNull();
    expect(sellerShipBy(paid, pkg({ status: 'shipped' }))).toBeNull();
    expect(sellerShipBy(paid, pkg({ fulfillmentMode: 'platform' }))).toBeNull();
    expect(sellerShipBy({ isPaid: false, paymentType: 'bank_transfer', createdAt: T0 }, pkg())).toBeNull();
  });

  it('urgency pipeline sorts by ship-by key first', () => {
    const stages = shipByUrgencySort(['s1']);
    expect(stages[stages.length - 1]).toEqual({ $sort: { _shipKey: 1, createdAt: -1, _id: 1 } });
  });
});
