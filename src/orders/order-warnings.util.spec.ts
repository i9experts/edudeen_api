import {
  addressWarnings,
  findPossibleDuplicates,
  isDuplicatePair,
  normalizePkPhone,
  phonesMismatch,
  toDupCandidate,
  DUPLICATE_WINDOW_MS,
} from './order-warnings.util';

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

const order = (id: string, atMs: number, over: any = {}) => ({
  _id: id,
  orderNumber: `ORD-${id}`,
  userId: 'buyer1',
  createdAt: new Date(atMs),
  sellerOrders: [{ storeId: 'store1', status: 'pending', items: [{ productId: 'p1' }] }],
  ...over,
});
const cand = (o: any) => toDupCandidate(o, 'store1')!;

describe('duplicate window', () => {
  it('23h59 apart is a duplicate, 24h01 is not, exactly 24h counts', () => {
    const a = cand(order('a', T0));
    expect(isDuplicatePair(a, cand(order('b', T0 + 23 * H + 59 * 60000)))).toBe(true);
    expect(isDuplicatePair(a, cand(order('b', T0 + DUPLICATE_WINDOW_MS)))).toBe(true);
    expect(isDuplicatePair(a, cand(order('b', T0 + 24 * H + 60000)))).toBe(false);
    expect(isDuplicatePair(a, cand(order('b', T0 - 24 * H - 60000)))).toBe(false);
  });

  it('ignores cancelled packages, other buyers and different product sets', () => {
    const a = cand(order('a', T0));
    const cancelled = order('b', T0 + H, { sellerOrders: [{ storeId: 'store1', status: 'cancelled', items: [{ productId: 'p1' }] }] });
    expect(isDuplicatePair(a, cand(cancelled))).toBe(false);
    expect(isDuplicatePair(a, cand(order('b', T0 + H, { userId: 'other' })))).toBe(false);
    const other = order('b', T0 + H, { sellerOrders: [{ storeId: 'store1', status: 'pending', items: [{ productId: 'p1' }, { productId: 'p2' }] }] });
    expect(isDuplicatePair(a, cand(other))).toBe(false);
  });

  it('same product set in a different order/quantity still matches; free claims are skipped', () => {
    const two = (ids: string[]) => order('x' + ids.join(''), T0, { sellerOrders: [{ storeId: 'store1', status: 'pending', items: ids.map(productId => ({ productId })) }] });
    const a = cand({ ...two(['p1', 'p2']), _id: 'a' });
    const b = cand({ ...two(['p2', 'p1', 'p1']), _id: 'b' });
    expect(isDuplicatePair(a, b)).toBe(true);
    expect(toDupCandidate(order('f', T0, { isFreeClaim: true }), 'store1')).toBeNull();
  });
});

describe('findPossibleDuplicates (one query)', () => {
  it('flags both orders with a single find call', async () => {
    const o1 = order('a', T0);
    const o2 = order('b', T0 + 2 * H);
    const find = jest.fn().mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [o1, o2] }) }) });
    const map = await findPossibleDuplicates({ find }, [o1, o2], () => 'store1');
    expect(find).toHaveBeenCalledTimes(1);
    expect(map.get('a')).toEqual({ orderId: 'b', orderNumber: 'ORD-b' });
    expect(map.get('b')).toEqual({ orderId: 'a', orderNumber: 'ORD-a' });
  });

  it('returns an empty map when the query fails', async () => {
    const find = jest.fn(() => { throw new Error('db down'); });
    const map = await findPossibleDuplicates({ find }, [order('a', T0)], () => 'store1');
    expect(map.size).toBe(0);
  });
});

describe('phone normalisation', () => {
  it('03343413883 equals +923343413883, 923343413883 and 00923343413883', () => {
    for (const v of ['+923343413883', '923343413883', '0092 334 3413883', '0334-3413883']) {
      expect(normalizePkPhone(v)).toBe('3343413883');
      expect(phonesMismatch('03343413883', v)).toBe(false);
    }
  });
  it('different numbers mismatch; blank side is not a mismatch', () => {
    expect(phonesMismatch('03343413883', '03001234567')).toBe(true);
    expect(phonesMismatch(null, '03001234567')).toBe(false);
    expect(phonesMismatch('03001234567', '')).toBe(false);
  });
});

describe('addressWarnings', () => {
  const good = { addressLine1: 'House 12, Street 4, Gulshan-e-Iqbal', city: 'Karachi', zipCode: '75300', phoneNumber: '+923343413883' };
  it('clean address has no warnings', () => {
    expect(addressWarnings(good, '03343413883')).toEqual([]);
  });
  it('short line, no area, bad postal and phone mismatch each give a reason', () => {
    const codes = addressWarnings({ ...good, addressLine1: 'House 5', zipCode: '7530', phoneNumber: '03001234567' }, '03343413883').map(w => w.code);
    expect(codes).toEqual(['short_address', 'no_area', 'bad_postal', 'phone_mismatch']);
  });
  it('no address = no warnings', () => {
    expect(addressWarnings(null, '0300')).toEqual([]);
  });
});
