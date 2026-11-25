import { CheckoutService } from './checkout.service';

// splitSubtotalsByType: each line's totalPrice is in its OWN seller currency and must be converted to the checkout currency.
describe('CheckoutService.splitSubtotalsByType', () => {
  const rate = (c: string) => (c === 'USD' ? 1 : 280);
  const svc: any = Object.create(CheckoutService.prototype);
  svc.exchangeRateService = {
    convertWithSnapshots: (n: number, from: string, to: string) => (from === to ? n : Math.round((n / rate(from)) * rate(to) * 100) / 100),
  };
  const snaps = [{ currency: 'PKR', ratePerUSD: 280 }];

  it('converts a PKR digital line and a USD physical line into a USD checkout', () => {
    const items = [
      { type: 'digital', totalPrice: 2800, currency: 'PKR' },
      { type: 'physical', totalPrice: 5, currency: 'USD' },
    ];
    expect(svc.splitSubtotalsByType(items, 'USD', snaps)).toEqual({ digitalSubtotal: 10, physicalSubtotal: 5 });
  });

  it('keeps raw sums when no checkout currency is given (old callers)', () => {
    const items = [{ type: 'digital', totalPrice: 7 }, { type: 'physical', totalPrice: 3 }];
    expect(svc.splitSubtotalsByType(items)).toEqual({ digitalSubtotal: 7, physicalSubtotal: 3 });
  });

  it('a line without a currency is treated as already in the checkout currency', () => {
    expect(svc.splitSubtotalsByType([{ type: 'digital', totalPrice: 4 }], 'PKR', snaps)).toEqual({ digitalSubtotal: 4, physicalSubtotal: 0 });
  });
});
