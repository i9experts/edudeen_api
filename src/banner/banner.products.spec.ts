/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { BannersService } from './banner.service';

function build(rows: any[] = []) {
  const created: any[] = [];
  const bannerModel: any = {
    find: jest.fn(() => ({
      sort: () => ({ lean: () => Promise.resolve(rows) }),
    })),
    countDocuments: jest.fn().mockResolvedValue(rows.length),
    create: jest.fn((doc: any) => {
      created.push(doc);
      return Promise.resolve({ _id: 'new-banner', ...doc });
    }),
    findById: jest.fn((id: string) =>
      Promise.resolve(rows.find((r) => r._id === id) ?? null),
    ),
    findByIdAndUpdate: jest.fn((id: string, { $set }: any) =>
      Promise.resolve({ ...rows.find((r) => r._id === id), ...$set }),
    ),
  };
  const productsService: any = {
    getShapedProductsByIds: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids
          .filter((id) => id !== 'missing')
          .map((id) => ({ _id: id, name: `Product ${id}` })),
      ),
    ),
  };
  const svc = new BannersService(
    { repositories: { bannerModel } } as any,
    { getPlacementLimit: jest.fn() } as any,
    {} as any,
    productsService,
  );
  return { svc, bannerModel, productsService, created };
}

describe('BannersService — products banners', () => {
  describe('createFromProducts', () => {
    it('rejects more products than the style allows', async () => {
      const { svc } = build();
      await expect(
        svc.createFromProducts({
          style: 'spotlight',
          productIds: ['a', 'b'],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a kind:"products" banner within the style\'s limit', async () => {
      const { svc, created } = build();
      const res: any = await svc.createFromProducts({
        style: 'lineup',
        productIds: ['a', 'b', 'c'],
      } as any);
      expect(created[0]).toEqual(
        expect.objectContaining({
          kind: 'products',
          style: 'lineup',
          productIds: ['a', 'b', 'c'],
        }),
      );
      expect(res.success).toBe(true);
    });
  });

  describe('updateBanner', () => {
    it('rejects a style change that no longer fits the stored productIds', async () => {
      const { svc } = build([
        {
          _id: 'b1',
          kind: 'products',
          style: 'lineup',
          productIds: ['a', 'b', 'c'],
        },
      ]);
      await expect(
        svc.updateBanner('b1', { style: 'spotlight' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects clearing productIds down to zero on a products banner', async () => {
      const { svc } = build([
        { _id: 'b1', kind: 'products', style: 'spotlight', productIds: ['a'] },
      ]);
      await expect(
        svc.updateBanner('b1', { productIds: [] } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a productIds change that still fits the stored style', async () => {
      const { svc, bannerModel } = build([
        { _id: 'b1', kind: 'products', style: 'lineup', productIds: ['a'] },
      ]);
      await svc.updateBanner('b1', { productIds: ['a', 'b'] } as any);
      expect(bannerModel.findByIdAndUpdate).toHaveBeenCalledWith(
        'b1',
        { $set: expect.objectContaining({ productIds: ['a', 'b'] }) },
        expect.anything(),
      );
    });
  });

  describe('live product resolution (findAll / findAllForAdmin)', () => {
    it('attaches live products in selection order and drops ones that no longer resolve', async () => {
      const { svc } = build([
        {
          _id: 'b1',
          kind: 'products',
          productIds: ['a', 'missing', 'b'],
          status: 'active',
          endAt: null,
        },
      ]);
      const res: any = await svc.findAll();
      expect(res.data[0].products.map((p: any) => p._id)).toEqual(['a', 'b']);
    });

    it('drops a products banner from the PUBLIC feed once every product is gone, but keeps it for admin', async () => {
      const row = {
        _id: 'b1',
        kind: 'products',
        productIds: ['missing'],
        status: 'active',
        endAt: null,
      };
      const { svc: pub } = build([row]);
      const publicRes: any = await pub.findAll();
      expect(publicRes.data).toHaveLength(0);

      const { svc: admin } = build([row]);
      const adminRes: any = await admin.findAllForAdmin();
      expect(adminRes.data).toHaveLength(1);
      expect(adminRes.data[0].products).toEqual([]);
    });

    it('leaves image banners untouched', async () => {
      const { svc, productsService } = build([
        {
          _id: 'b1',
          kind: 'image',
          bannerImage: 'x.jpg',
          status: 'active',
          endAt: null,
        },
      ]);
      const res: any = await svc.findAll();
      expect(res.data[0].products).toBeUndefined();
      expect(productsService.getShapedProductsByIds).not.toHaveBeenCalled();
    });
  });

  describe('previewProducts', () => {
    it('resolves live products in the given order', async () => {
      const { svc } = build();
      const res: any = await svc.previewProducts(['a', 'missing', 'b']);
      expect(res.data.map((p: any) => p._id)).toEqual(['a', 'b']);
    });
  });
});
