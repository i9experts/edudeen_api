import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const STORE = 'a'.repeat(24);
const O1 = '1'.repeat(24);
const O2 = '2'.repeat(24);
const U = '3'.repeat(24);

const chain = (v: any) => ({ select: () => ({ lean: async () => v }), lean: async () => v });

function make(orders: any[], store: any = { _id: STORE, name: 'Noor', logo: null }) {
  const svc: any = Object.create(OrdersService.prototype);
  svc.databaseService = {
    repositories: {
      storeModel: { findOne: () => chain(store) },
      orderModel: { find: () => ({ lean: async () => orders }) },
      userModel: { find: () => chain([{ _id: U, name: 'Ali', phone: '0300' }]) },
      productVariantModel: { find: () => chain([]) },
    },
  };
  return svc as OrdersService;
}

const order = (id: string, extra: any = {}) => ({
  _id: id, orderNumber: `N-${id[0]}`, userId: U, currency: 'PKR', paymentType: 'cash_on_delivery', isPaid: false,
  shippingAddress: { recipientName: 'Ali', addressLine1: 'House 1 Street 2', city: 'Lahore' },
  sellerOrders: [{ storeId: STORE, fulfillmentType: 'physical', status: 'pending', subtotal: 500, shippingFee: 100, codAmount: 600,
    items: [{ name: 'Book', sku: 'S-1', quantity: 2, price: 250, totalPrice: 500, type: 'physical' }] }],
  ...extra,
});

describe('getSellerOrdersForPrint', () => {
  it('returns one row per id in request order, with prices', async () => {
    const r: any = await make([order(O2), order(O1)]).getSellerOrdersForPrint('s', STORE, `${O1},${O2}`);
    expect(r.data.orders.map((o: any) => o.orderId)).toEqual([O1, O2]);
    expect(r.data.orders[0].items[0].price).toBe(250);
    expect(r.data.store.name).toBe('Noor');
  });
  it('omits every price on gift orders', async () => {
    const r: any = await make([order(O1, { giftWrap: true, giftMessage: 'Happy birthday' })]).getSellerOrdersForPrint('s', STORE, O1);
    const o = r.data.orders[0];
    expect(o.pricesHidden).toBe(true);
    expect(o.items[0].price).toBeNull();
    expect(o.items[0].totalPrice).toBeNull();
    expect(o.subtotal).toBeNull();
    expect(o.shippingFee).toBeNull();
    expect(o.codAmount).toBeNull();
    expect(o.giftMessage).toBe('Happy birthday');
  });
  it('404 when any id is not an order of this store', async () => {
    await expect(make([order(O1)]).getSellerOrdersForPrint('s', STORE, `${O1},${O2}`)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('403 for a store that is not the seller\'s', async () => {
    await expect(make([order(O1)], null).getSellerOrdersForPrint('s', STORE, O1)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('400 for missing, invalid or too many ids', async () => {
    const s = make([]);
    await expect(s.getSellerOrdersForPrint('s', STORE, '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.getSellerOrdersForPrint('s', STORE, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    const many = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(24, '0')).join(',');
    await expect(s.getSellerOrdersForPrint('s', STORE, many)).rejects.toBeInstanceOf(BadRequestException);
  });
});
