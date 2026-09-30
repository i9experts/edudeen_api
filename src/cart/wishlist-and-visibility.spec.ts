/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { CartService } from './cart.service';
import { ProductsService } from '../products/products.service';

const PID = '64f0c0ffee0c0ffee0c0ff01';
const VID = '64f0c0ffee0c0ffee0c0ff02';
const SID = '64f0c0ffee0c0ffee0c0ff03';
const lean = (v: any) => {
  const r: any = Promise.resolve(v);
  r.lean = () => Promise.resolve(v);
  return r;
};

function makeCart(over: any = {}) {
  const repos: any = {
    productModel: {
      findOne: jest.fn().mockReturnValue(
        lean(
          over.product === undefined
            ? {
                _id: PID,
                storeId: SID,
                digital: {
                  files: [{ url: 'private/digital-products/x' }],
                  buyerDeliveryMessage: 'KEY-123',
                  preview: { enabled: false },
                },
              }
            : over.product,
        ),
      ),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    },
    productVariantModel: {
      findOne: jest
        .fn()
        .mockReturnValue(
          lean(
            over.variant === undefined
              ? { _id: VID, productId: PID, status: 'active', isDelete: false }
              : over.variant,
          ),
        ),
    },
    storeModel: { exists: jest.fn().mockResolvedValue(over.storeLive ?? true) },
    wishListModel: {
      findOne: jest.fn().mockResolvedValue(null),
      countDocuments: jest.fn().mockResolvedValue(over.count ?? 0),
      create: jest.fn().mockResolvedValue({ _id: 'w1' }),
      find: jest.fn(),
    },
  };
  return { svc: new CartService({ repositories: repos } as any), repos };
}

describe('wishlist', () => {
  it('rejects a product that is not live, or whose store is not live', async () => {
    await expect(
      makeCart({ product: null }).svc.addToWishlist('u1', SID, {
        productId: PID,
        productVariantId: VID,
      }),
    ).rejects.toThrow(/Product not found/);
    await expect(
      makeCart({ storeLive: false }).svc.addToWishlist('u1', SID, {
        productId: PID,
        productVariantId: VID,
      }),
    ).rejects.toThrow(/Product not found/);
  });

  it('rejects a variant that belongs to another product / is inactive, and a mismatched storeId', async () => {
    await expect(
      makeCart({
        variant: { _id: VID, productId: 'other', status: 'active' },
      }).svc.addToWishlist('u1', SID, {
        productId: PID,
        productVariantId: VID,
      }),
    ).rejects.toThrow(/variant not found/);
    await expect(
      makeCart({
        variant: { _id: VID, productId: PID, status: 'inactive' },
      }).svc.addToWishlist('u1', SID, {
        productId: PID,
        productVariantId: VID,
      }),
    ).rejects.toThrow(/variant not found/);
    await expect(
      makeCart().svc.addToWishlist('u1', '64f0c0ffee0c0ffee0c0ffff', {
        productId: PID,
        productVariantId: VID,
      }),
    ).rejects.toThrow(/not sold by this store/);
  });

  it('rejects non-id values (no CastError 500) and a full wishlist', async () => {
    await expect(
      makeCart().svc.addToWishlist('u1', SID, {
        productId: { $ne: 1 },
        productVariantId: VID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      makeCart({ count: 200 }).svc.addToWishlist('u1', SID, {
        productId: PID,
        productVariantId: VID,
      }),
    ).rejects.toThrow(/wishlist is full/);
  });

  it('the response never carries the private file manifest or the post-purchase delivery message', async () => {
    const { svc, repos } = makeCart();
    const res: any = await svc.addToWishlist('u1', SID, {
      productId: PID,
      productVariantId: VID,
    });
    expect(res.data.product.digital).toEqual({
      fileCount: 1,
      previewAvailable: false,
    });
    expect(JSON.stringify(res)).not.toMatch(
      /KEY-123|private\/digital-products/,
    );
    expect(repos.productModel.findByIdAndUpdate).toHaveBeenCalled(); // valid add still counts
  });

  it('wishlist counts are NOT inflated for an invalid add', async () => {
    const { svc, repos } = makeCart({ product: null });
    await svc
      .addToWishlist('u1', SID, { productId: PID, productVariantId: VID })
      .catch(() => undefined);
    expect(repos.productModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('getWishlist silently drops removed/non-live products instead of serving them', async () => {
    const { svc, repos } = makeCart({ product: null });
    repos.wishListModel.find.mockReturnValue({
      sort: () => ({
        limit: async () => [{ productId: PID, productVariantId: VID }],
      }),
    });
    const res: any = await svc.getWishlist('u1', SID);
    expect(res.data).toEqual([]);
  });
});

describe('cart add', () => {
  it('refuses an inactive variant and a product of a non-live store', async () => {
    const mk = (over: any) => {
      const repos: any = {
        productModel: {
          findById: () => ({
            lean: async () => ({
              _id: PID,
              storeId: SID,
              status: 'active',
              isDelete: false,
              images: [],
            }),
          }),
        },
        productVariantModel: {
          findById: () => ({
            lean: async () =>
              over.variant ?? {
                _id: VID,
                productId: PID,
                status: 'active',
                isDelete: false,
              },
          }),
        },
        storeModel: {
          exists: jest.fn().mockResolvedValue(over.storeLive ?? true),
        },
        cartModel: { findOne: jest.fn() },
      };
      return new CartService({ repositories: repos } as any);
    };
    await expect(
      mk({ storeLive: false }).addToCart('u1', undefined, {
        productId: PID,
        productVariantId: VID,
        quantity: 1,
      } as any),
    ).rejects.toThrow(/Product not found/);
    await expect(
      mk({
        variant: {
          _id: VID,
          productId: PID,
          status: 'inactive',
          isDelete: false,
        },
      }).addToCart('u1', undefined, {
        productId: PID,
        productVariantId: VID,
        quantity: 1,
      } as any),
    ).rejects.toThrow(/variant not found/);
  });
});

describe('ProductsService store-scoped public reads', () => {
  const make = (storeLive: boolean) => {
    const svc: any = Object.create(ProductsService.prototype);
    const productModel: any = { find: jest.fn() };
    svc.databaseService = {
      repositories: {
        storeModel: {
          exists: jest.fn().mockResolvedValue(storeLive),
          findOne: jest.fn().mockReturnValue(lean(null)),
        },
        productModel,
        productVariantModel: { findOne: jest.fn() },
      },
    };
    return { svc, productModel };
  };

  it('new arrivals / best sellers / trending return nothing for a pending or suspended store', async () => {
    const { svc, productModel } = make(false);
    for (const res of [
      await svc.getNewArrivals(PID),
      await svc.getBestSellers(PID),
      await svc.getTrendingProducts(PID),
    ]) {
      expect(res.data.products).toEqual([]);
    }
    expect(productModel.find).not.toHaveBeenCalled();
  });

  it('a malformed store or variant id is a clean miss, not a CastError 500', async () => {
    const { svc } = make(true);
    expect((await svc.getPinnedProducts('nope')).data.products).toEqual([]);
    expect(await svc.getVariantById('nope')).toMatchObject({ success: false });
    expect((await svc.getNewArrivals('nope')).data.products).toEqual([]);
  });
});
