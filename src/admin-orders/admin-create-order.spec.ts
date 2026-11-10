/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminCreateOrderService } from './admin-create-order.service';

const chain = (v: any) => ({ select: () => ({ limit: () => ({ lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) });

const BUYER = { _id: 'buyer-1', name: 'Sara Khan', email: 'sara@mail.com' };
const DIGITAL_PRODUCT = { _id: 'p-digital', name: 'E-book', type: 'digital', storeId: 'store-1' };
const PHYSICAL_PRODUCT = { _id: 'p-physical', name: 'Workbook', type: 'physical', storeId: 'store-1' };
const VARIANT = { _id: 'v-1' };

function build(opts: { product?: any; checkoutTotal?: number } = {}) {
  const product = opts.product ?? PHYSICAL_PRODUCT;
  const userModel: any = { findOne: jest.fn(() => chain(BUYER)) };
  const productModel: any = { findOne: jest.fn(() => chain(product)), find: jest.fn(() => chain([])) };
  const productVariantModel: any = { findOne: jest.fn(() => chain(VARIANT)) };
  const databaseService: any = { repositories: { userModel, productModel, productVariantModel } };

  const activityLogService: any = { log: jest.fn().mockResolvedValue(true) };
  const addressService: any = { addAddress: jest.fn().mockResolvedValue({ success: true, data: { _id: 'addr-1' } }) };
  const checkoutService: any = {
    createCheckout: jest.fn().mockResolvedValue({
      success: true,
      data: { checkout: { _id: 'checkout-1' }, summary: { totalAmount: opts.checkoutTotal ?? 500 } },
    }),
  };
  const order = { orderId: 'order-1', orderNumber: 'ED-9001' };
  const paymentService: any = {
    freeCheckout: jest.fn().mockResolvedValue({ success: true, message: 'Order placed successfully', data: { orders: [order] } }),
    codPayment: jest.fn().mockResolvedValue({ success: true, message: 'Order placed successfully (Cash on Delivery)', data: { orders: [order] } }),
  };

  const svc = new AdminCreateOrderService(databaseService, activityLogService, addressService, checkoutService, paymentService);
  return { svc, activityLogService, addressService, checkoutService, paymentService, productModel, userModel };
}

const ADDRESS = { phoneNumber: '03001234567', addressLine1: '123 Main St', state: 'Sindh', city: 'Karachi', zipCode: '74000' };
const dto = (extra: any = {}) => ({ buyerId: 'buyer-1', productId: 'p-physical', variantId: 'v-1', quantity: 1, reason: 'Phone order', address: ADDRESS, ...extra });

describe('AdminCreateOrderService.create', () => {
  it('rejects an unknown buyer', async () => {
    const { svc, userModel } = build();
    userModel.findOne.mockReturnValueOnce(chain(null));
    await expect(svc.create('admin-1', dto())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unknown or unpublished product', async () => {
    const { svc, productModel } = build();
    productModel.findOne.mockReturnValueOnce(chain(null));
    await expect(svc.create('admin-1', dto())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires a shipping address for a physical product', async () => {
    const { svc } = build();
    await expect(svc.create('admin-1', dto({ address: undefined }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('places a priced physical order via Cash on Delivery, saving the address first', async () => {
    const { svc, addressService, checkoutService, paymentService, activityLogService } = build({ checkoutTotal: 500 });
    const res = await svc.create('admin-1', dto());
    expect(addressService.addAddress).toHaveBeenCalledWith('buyer-1', ADDRESS);
    expect(checkoutService.createCheckout).toHaveBeenCalledWith('buyer-1', expect.objectContaining({
      buyNow: { productId: 'p-physical', variantId: 'v-1', quantity: 1 },
      addressId: 'addr-1',
    }));
    expect(paymentService.codPayment).toHaveBeenCalledWith('buyer-1', { checkoutId: 'checkout-1' });
    expect(paymentService.freeCheckout).not.toHaveBeenCalled();
    expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'manual_order_created', actorId: 'admin-1', targetId: 'order-1' }));
    expect(res.data).toEqual({ orderId: 'order-1', orderNumber: 'ED-9001' });
  });

  it('places a free ($0) digital order without an address', async () => {
    const { svc, paymentService } = build({ product: DIGITAL_PRODUCT, checkoutTotal: 0 });
    const res = await svc.create('admin-1', dto({ productId: 'p-digital', address: undefined }));
    expect(paymentService.freeCheckout).toHaveBeenCalledWith('buyer-1', { checkoutId: 'checkout-1' });
    expect(paymentService.codPayment).not.toHaveBeenCalled();
    expect(res.data.orderNumber).toBe('ED-9001');
  });

  it('refuses a priced digital item — no payment-collection path exists for it yet', async () => {
    const { svc, paymentService } = build({ product: DIGITAL_PRODUCT, checkoutTotal: 500 });
    await expect(svc.create('admin-1', dto({ productId: 'p-digital', address: undefined }))).rejects.toBeInstanceOf(BadRequestException);
    expect(paymentService.codPayment).not.toHaveBeenCalled();
    expect(paymentService.freeCheckout).not.toHaveBeenCalled();
  });
});

describe('AdminCreateOrderService.searchProducts', () => {
  it('returns nothing for a too-short query, without hitting the database', async () => {
    const { svc, productModel } = build();
    const res = await svc.searchProducts('a');
    expect(res.data.items).toEqual([]);
    expect(productModel.find).not.toHaveBeenCalled();
  });
});
