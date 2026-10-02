/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { OrdersService } from './orders.service';

const P1 = '64b0000000000000000000a1';
const P2 = '64b0000000000000000000a2';
const lean = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }), lean: () => Promise.resolve(v) });

function make(orders: any[], products: any[]) {
  const repos: any = {
    orderModel: { find: jest.fn(() => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve(orders) }) }) }) })) },
    productModel: { find: jest.fn(() => lean(products)) },
    categoryModel: { find: jest.fn(() => lean([{ _id: 'c1', name: 'Mathematics' }, { _id: 'c11', name: 'Algebra' }])) },
    storeModel: { find: jest.fn(() => lean([{ _id: 's1', name: 'Uzair Book Center', slug: 'uzair' }])) },
  };
  const svc = new OrdersService({ repositories: repos } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc };
}

const order = (id: string, at: string, items: any[], extra: any = {}) => ({
  _id: id, orderNumber: `ED-${id}`, isPaid: true, orderStatus: 'completed', createdAt: new Date(at),
  sellerOrders: [{ storeId: 's1', status: 'completed', items }], ...extra,
});

describe('My Library', () => {
  it('lists each digital product once (newest purchase), with subject and grade, skipping physical and refunded items', async () => {
    const { svc } = make(
      [
        order('o2', '2026-09-30', [{ _id: 'i3', productId: P1, name: 'Algebra Pack', type: 'digital', status: 'completed', licenseType: 'school' }]),
        order('o1', '2026-09-01', [
          { _id: 'i1', productId: P1, name: 'Algebra Pack', type: 'digital', status: 'completed' },
          { _id: 'i2', productId: P2, name: 'Refunded Book', type: 'digital', status: 'refunded' },
          { _id: 'i4', productId: 'x', name: 'Notebook', type: 'physical', status: 'completed' },
        ]),
      ],
      [{ _id: P1, slug: 'algebra', categoryId: 'c1', subCategoryId: 'c11', educationLevel: 'middle_school', curricula: ['punjab'], digital: { files: [{}, {}] } }],
    );
    const res: any = await svc.getMyLibrary('u1');
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0]).toEqual(expect.objectContaining({
      orderId: 'o2', productId: P1, licenseType: 'school', category: 'Mathematics', subCategory: 'Algebra',
      educationLevel: 'middle_school', fileCount: 2, storeName: 'Uzair Book Center', reviewable: true,
    }));
  });

  it('drops a resource an admin took down', async () => {
    const { svc } = make(
      [order('o1', '2026-09-01', [{ _id: 'i1', productId: P1, name: 'Copied Book', type: 'digital', status: 'completed' }])],
      [{ _id: P1, removedByAdmin: true }],
    );
    const res: any = await svc.getMyLibrary('u1');
    expect(res.data.items).toEqual([]);
  });
});
