/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';

const PID = '64b000000000000000000a01';
const VID = '64b000000000000000000a02';
const ZID = '64b000000000000000000a03';

const lean = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) });

function make(opts: { type?: string; codEnabled?: boolean; platformCod?: boolean; maxPKR?: number | null; zone?: any } = {}) {
  const repositories: any = {
    productModel: { findOne: jest.fn(() => lean({ _id: PID, productType: opts.type ?? 'physical', storeId: 's1' })) },
    productVariantModel: { findOne: jest.fn(() => lean({ _id: VID, price: 1000, currency: 'PKR' })) },
    storeModel: {
      findById: jest.fn(() => lean({ _id: 's1', codEnabled: opts.codEnabled ?? true, baseCurrency: 'PKR' })),
      find: jest.fn(() => lean([{ _id: 's1', baseCurrency: 'PKR' }])),
    },
    shippingZoneModel: { findOne: jest.fn(() => lean(opts.zone ?? null)) },
  };
  const admin: any = {
    isCodOffered: jest.fn().mockResolvedValue(opts.platformCod ?? true),
    getCodConfig: jest.fn().mockResolvedValue({ maxPerPackagePKR: opts.maxPKR ?? null, feePerPackagePKR: 0 }),
  };
  const fx: any = {
    buildSnapshots: jest.fn().mockResolvedValue([]),
    convertWithSnapshots: jest.fn((n: number) => n),
  };
  const svc: any = new CheckoutService({ repositories } as any, {} as any, admin, fx, {} as any, {} as any);
  return { svc, repositories };
}

describe('getDeliveryInfo (read-only)', () => {
  it('digital product: instant, no delivery numbers', async () => {
    const { svc } = make({ type: 'digital' });
    const r = await svc.getDeliveryInfo({ productId: PID });
    expect(r.data).toEqual({ kind: 'digital' });
  });

  it('physical without a zone: fee unknown, COD offered when store + platform allow it', async () => {
    const { svc } = make();
    const r = await svc.getDeliveryInfo({ productId: PID, variantId: VID, currency: 'PKR' });
    expect(r.data).toEqual(expect.objectContaining({ kind: 'physical', fee: null, cod: true }));
  });

  it('uses the same checkout fee code when a zone is known', async () => {
    const { svc } = make({ zone: { shippingPrice: 250, estimatedDeliveryTime: '2-3 days' } });
    const spy = jest.spyOn(svc, 'computeShippingLines');
    const r = await svc.getDeliveryInfo({ productId: PID, variantId: VID, zoneId: ZID, currency: 'PKR' });
    expect(spy).toHaveBeenCalled();
    expect(r.data).toEqual(expect.objectContaining({ fee: 250, estimate: '2-3 days', freeShipping: false }));
  });

  it('COD hidden when the store opted out, platform COD is off, or the package is over the admin limit', async () => {
    expect((await make({ codEnabled: false }).svc.getDeliveryInfo({ productId: PID, variantId: VID })).data.cod).toBe(false);
    expect((await make({ platformCod: false }).svc.getDeliveryInfo({ productId: PID, variantId: VID })).data.cod).toBe(false);
    expect((await make({ maxPKR: 500 }).svc.getDeliveryInfo({ productId: PID, variantId: VID, currency: 'PKR' })).data.cod).toBe(false);
  });

  it('rejects a bad productId', async () => {
    await expect(make().svc.getDeliveryInfo({ productId: 'nope' })).rejects.toThrow(BadRequestException);
  });
});
