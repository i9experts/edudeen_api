import { PaymentService } from './payment.service';

describe('PaymentService.formatOrder items', () => {
  const fmt = (o: any) => (PaymentService.prototype as any).formatOrder.call({}, o);
  const base = (items: any[]) => ({ _id: 'o1', sellerOrders: [{ items }] });

  it('exposes productId as a string (null when missing)', () => {
    const out = fmt(
      base([
        { productId: { toString: () => 'abc123' }, name: 'A', quantity: 1, price: 5, totalPrice: 5 },
        { name: 'B', quantity: 1, price: 1, totalPrice: 1 },
      ]),
    );
    expect(out.items[0].productId).toBe('abc123');
    expect(out.items[1].productId).toBeNull();
  });
});

