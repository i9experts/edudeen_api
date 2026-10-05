/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';

const ADDR_ID = '64b000000000000000000a01';
const ZONE_ID = '64b000000000000000000z01'.replace('z', 'f');

const chain = (value: any) => ({ select: () => ({ lean: () => Promise.resolve(value) }), sort: () => ({ lean: () => Promise.resolve(value) }), lean: () => Promise.resolve(value) });

// A physical cart from one store, with every collaborator stubbed out.
function makeService(opts: { pickedAddress?: any; zonesConfigured?: boolean } = {}) {
  const checkoutDoc = { _id: { toString: () => 'chk1' }, items: [] };
  const addressModel = {
    findOne: jest.fn((filter: any) => {
      if (filter._id) return Promise.resolve(opts.pickedAddress === undefined ? { _id: ADDR_ID } : opts.pickedAddress);
      return Promise.resolve({ _id: 'default-addr', isDefault: true });
    }),
  };
  const checkoutModel = {
    create: jest.fn().mockResolvedValue(checkoutDoc),
    findById: jest.fn().mockResolvedValue({ ...checkoutDoc, shippingFee: 250 }),
  };
  const repositories: any = {
    cartModel: { findOne: jest.fn().mockResolvedValue({ items: [{ productId: 'p1', productVariantId: 'v1', quantity: 1 }] }) },
    productModel: { findOne: jest.fn().mockResolvedValue({ _id: { toString: () => 'p1' }, storeId: 's1', sellerId: 'sel1', type: 'physical', name: 'Workbook', images: [] }) },
    productVariantModel: { findOne: jest.fn().mockResolvedValue({ _id: { toString: () => 'v1' }, productId: 'p1', price: 900, stock: 5, currency: 'PKR' }) },
    storeModel: {
      findOne: jest.fn(() => chain({ status: 'active' })),
      find: jest.fn(() => chain([{ codEnabled: true }])),
    },
    sellerModel: { find: jest.fn(() => chain([])) },
    subscriptionPlanModel: { findOne: jest.fn(() => chain(null)) },
    addressModel,
    checkoutModel,
    shippingZoneModel: { exists: jest.fn().mockResolvedValue(opts.zonesConfigured ? { _id: ZONE_ID } : null) },
  };
  const svc: any = new CheckoutService(
    { repositories } as any,
    { getActiveBenefits: jest.fn().mockResolvedValue(null), resolveProductDiscount: jest.fn() } as any,
    { getActiveCampaignsForStores: jest.fn().mockResolvedValue(new Map()) } as any,
    { isManualPaymentEnabled: jest.fn().mockResolvedValue(false) } as any,
    { buildSnapshots: jest.fn().mockResolvedValue([]) } as any,
    {} as any,
    { getActiveDiscountsForStores: jest.fn().mockResolvedValue(new Map()) } as any,
  );
  jest.spyOn(svc, 'resolveCheckoutCurrency').mockResolvedValue('PKR');
  jest.spyOn(svc, 'convertedSubtotal').mockReturnValue(900);
  const addShipping = jest.spyOn(svc, 'addShippingInCheckout').mockResolvedValue({ data: { shippingFee: 250, totalAmount: 1150 } });
  return { svc, addressModel, checkoutModel, addShipping };
}

describe('createCheckout uses what the buyer picked', () => {
  it('ships to the selected address and charges the selected shipping zone', async () => {
    const { svc, addressModel, checkoutModel, addShipping } = makeService();
    const res = await svc.createCheckout('u1', { storeId: 's1', addressId: ADDR_ID, shippingZoneId: ZONE_ID });

    expect(addressModel.findOne).toHaveBeenCalledWith({ _id: ADDR_ID, userId: 'u1', isDelete: false });
    expect(checkoutModel.create).toHaveBeenCalledWith(expect.objectContaining({ addressId: ADDR_ID }));
    expect(addShipping).toHaveBeenCalledWith('u1', { checkoutId: 'chk1', shippingZoneId: ZONE_ID });
    expect(res.data.summary).toEqual(expect.objectContaining({ shippingFee: 250, totalAmount: 1150 }));
  });

  it("refuses an address that isn't the buyer's", async () => {
    const { svc, checkoutModel } = makeService({ pickedAddress: null });
    await expect(svc.createCheckout('u1', { storeId: 's1', addressId: ADDR_ID })).rejects.toThrow(BadRequestException);
    expect(checkoutModel.create).not.toHaveBeenCalled();
  });

  it('without a shipping zone (none configured) the order still goes through with free shipping', async () => {
    const { svc, addShipping } = makeService();
    const res = await svc.createCheckout('u1', { storeId: 's1', addressId: ADDR_ID });
    expect(addShipping).not.toHaveBeenCalled();
    expect(res.data.summary.shippingFee).toBe(0);
  });

  it('once delivery zones exist, a physical order must pick one (no skipping the shipping charge)', async () => {
    const { svc, checkoutModel } = makeService({ zonesConfigured: true });
    await expect(svc.createCheckout('u1', { storeId: 's1', addressId: ADDR_ID })).rejects.toThrow('Choose a delivery option');
    expect(checkoutModel.create).not.toHaveBeenCalled();
  });
});

describe('admin shipping zones', () => {
  const svcWith = (shippingZoneModel: any) =>
    new CheckoutService({ repositories: { shippingZoneModel } } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  it('creates a zone with trimmed fields and a whole-rupee price', async () => {
    const shippingZoneModel = { create: jest.fn((d: any) => Promise.resolve(d)) };
    await svcWith(shippingZoneModel).adminCreateShippingZone({ country: ' Pakistan ', province: 'Sindh', city: 'Karachi', shippingPrice: '249.6', estimatedDeliveryTime: '2-3 days', isDelete: true });
    expect(shippingZoneModel.create).toHaveBeenCalledWith({ country: 'Pakistan', province: 'Sindh', city: 'Karachi', shippingPrice: 250, estimatedDeliveryTime: '2-3 days' });
  });

  it('rejects a zone with no country or a negative price', async () => {
    const svc = svcWith({ create: jest.fn() });
    await expect(svc.adminCreateShippingZone({ shippingPrice: 100 })).rejects.toThrow(/country is required/);
    await expect(svc.adminCreateShippingZone({ country: 'Pakistan', shippingPrice: -5 })).rejects.toThrow(/shippingPrice/);
  });
});
