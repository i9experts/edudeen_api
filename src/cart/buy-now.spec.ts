import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CartService } from './cart.service';
import { CheckoutService } from '../checkout/checkout.service';
import { PaymentService } from '../payment/payment.service';

const PID = 'a'.repeat(24);
const VID = 'b'.repeat(24);

describe('Buy Now never touches the cart', () => {
  describe('CheckoutService.parseBuyNow', () => {
    const parse = (raw: any) => (Object.create(CheckoutService.prototype) as any).parseBuyNow(raw);

    it('is null when absent', () => {
      expect(parse(undefined)).toBeNull();
      expect(parse(null)).toBeNull();
    });
    it('accepts a valid selection and defaults the quantity to 1', () => {
      expect(parse({ productId: PID, variantId: VID, quantity: 3 })).toEqual({ productId: PID, variantId: VID, quantity: 3 });
      expect(parse({ productId: PID, variantId: VID })).toEqual({ productId: PID, variantId: VID, quantity: 1 });
    });
    it.each([
      [{ productId: 'x', variantId: VID, quantity: 1 }],
      [{ productId: PID, variantId: { $ne: 1 }, quantity: 1 }],
      [{ productId: PID, variantId: VID, quantity: 0 }],
      [{ productId: PID, variantId: VID, quantity: 100 }],
      [{ productId: PID, variantId: VID, quantity: 1.5 }],
    ])('rejects %j', (raw) => {
      expect(() => parse(raw)).toThrow(BadRequestException);
    });
  });

  describe('PaymentService.removeCheckedOutItemsFromCart', () => {
    const run = (checkout: any) => {
      const cartModel = { updateOne: jest.fn().mockResolvedValue({}) };
      return (Object.create(PaymentService.prototype) as any)
        .removeCheckedOutItemsFromCart('u1', checkout, cartModel)
        .then(() => cartModel);
    };
    const items = [{ storeId: 's1', productId: PID, variantId: VID }];

    it('leaves the cart alone for a Buy Now checkout', async () => {
      expect((await run({ isBuyNow: true, items })).updateOne).not.toHaveBeenCalled();
    });
    it('still removes bought lines for a normal checkout', async () => {
      expect((await run({ isBuyNow: false, items })).updateOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('CartService.getBuyNowCart', () => {
    function build(opts: { product?: any; store?: any; variant?: any } = {}) {
      const lean = (v: any) => ({ lean: () => Promise.resolve(v), select: () => ({ lean: () => Promise.resolve(v) }) });
      const cartModel = { findOne: jest.fn(), create: jest.fn(), updateOne: jest.fn() };
      const svc: any = Object.create(CartService.prototype);
      svc.databaseService = {
        repositories: {
          cartModel,
          productModel: { findOne: jest.fn(() => lean(opts.product ?? null)) },
          storeModel: { findOne: jest.fn(() => lean(opts.store ?? null)) },
          productVariantModel: { findOne: jest.fn(() => lean(opts.variant ?? null)) },
        },
      };
      svc.getCart = jest.fn().mockResolvedValue({ data: { userId: 'u1', storeId: 's1', items: [{ productId: PID }] } });
      return { svc, cartModel };
    }
    const product = { _id: PID, storeId: 's1', name: 'Worksheet', images: ['p.png'] };
    const store = { name: 'Store', slug: 'store', logo: null };
    const variant = { _id: VID, price: 5, currency: 'USD', options: [] };

    it('prices the line in memory and returns a one-store my-carts shape', async () => {
      const { svc, cartModel } = build({ product, store, variant });
      const res = await svc.getBuyNowCart('u1', PID, VID, '2');
      expect(svc.getCart).toHaveBeenCalledWith('u1', 's1', { items: [expect.objectContaining({ productId: PID, productVariantId: VID, quantity: 2, price: 5 })] });
      expect(res.data).toHaveLength(1);
      expect(res.data[0].store).toMatchObject({ storeId: 's1', name: 'Store' });
      expect(cartModel.findOne).not.toHaveBeenCalled();
      expect(cartModel.create).not.toHaveBeenCalled();
      expect(cartModel.updateOne).not.toHaveBeenCalled();
    });
    it('rejects bad ids / quantity and unavailable products', async () => {
      await expect(build().svc.getBuyNowCart('u1', 'nope', VID)).rejects.toBeInstanceOf(BadRequestException);
      await expect(build({ product, store, variant }).svc.getBuyNowCart('u1', PID, VID, '0')).rejects.toBeInstanceOf(BadRequestException);
      await expect(build().svc.getBuyNowCart('u1', PID, VID)).rejects.toBeInstanceOf(NotFoundException);
      await expect(build({ product, store }).svc.getBuyNowCart('u1', PID, VID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
