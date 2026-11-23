/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- mock-heavy tests */
import { ProductsService } from './products.service';

const chain = (v: any) => { const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(v), then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return c; };
const P = '507f1f77bcf86cd799439011';
const A = '507f1f77bcf86cd799439012';

function make(product: any, coRows: any[]) {
  const productModel: any = { findOne: jest.fn(() => chain(product)), find: jest.fn(() => chain([{ _id: A }])) };
  const orderModel: any = { aggregate: jest.fn(async () => coRows) };
  const svc: any = Object.create(ProductsService.prototype);
  svc.databaseService = { repositories: { productModel, orderModel } };
  svc.getShapedProductsByIds = jest.fn(async (ids: string[]) => ids.map((id) => ({ _id: id })));
  svc.attachVariantsAndPricing = jest.fn(async (rows: any[]) => rows);
  svc.restrictToActiveStores = jest.fn(async () => undefined);
  return { svc, productModel };
}

describe('getAlsoBought heading basis matches the cards', () => {
  it('co-purchases exist: bought_together and NOT topped up with other items', async () => {
    const { svc, productModel } = make({ _id: P, categoryId: 'c1', educationLevel: 'primary' }, [{ _id: A, n: 2 }]);
    const res = await svc.getAlsoBought(P, 8, null);
    expect(res.data.basis).toBe('bought_together');
    expect(res.data.products.map((p: any) => p._id)).toEqual([A]);
    expect(productModel.find).not.toHaveBeenCalled();
  });

  it('no co-purchases + product has a level: same_level, query filters category AND level', async () => {
    const { svc, productModel } = make({ _id: P, categoryId: 'c1', educationLevel: 'primary' }, []);
    const res = await svc.getAlsoBought(P, 8, null);
    const q = productModel.find.mock.calls[0][0];
    expect(res.data.basis).toBe('same_level');
    expect(q.categoryId).toBe('c1');
    expect(q.educationLevel).toBe('primary');
    expect(q._id).toEqual({ $ne: P });
  });

  it('no co-purchases + no level: similar (category only)', async () => {
    const { svc, productModel } = make({ _id: P, categoryId: 'c1' }, []);
    const res = await svc.getAlsoBought(P, 8, null);
    expect(res.data.basis).toBe('similar');
    expect(productModel.find.mock.calls[0][0].educationLevel).toBeUndefined();
  });
});
