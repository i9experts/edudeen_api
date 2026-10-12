/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { PaymentService } from './payment.service';

// removeCheckedOutItemsFromCart touches no injected state, so build the service without its dependencies.
const svc: any = Object.create(PaymentService.prototype);

/** An in-memory stand-in for the cart collection: one document per (userId, storeId). */
function fakeCartModel(carts: any[]) {
  const apply = async (filter: any, update: any) => {
    const cart = carts.find(
      (c) =>
        c.userId === filter.userId &&
        c.storeId === filter.storeId &&
        c.status === 'active' &&
        !c.isDelete,
    );
    if (!cart) return { matchedCount: 0 };
    const ors: any[] = update.$pull.items.$or;
    cart.items = cart.items.filter(
      (it: any) =>
        !ors.some(
          (o) =>
            o.productId === it.productId &&
            o.productVariantId === it.productVariantId,
        ),
    );
    return { matchedCount: 1 };
  };
  // both write styles, so this runs against the old (findOneAndUpdate) and new (updateOne) implementation alike
  return { updateOne: jest.fn(apply), findOneAndUpdate: jest.fn(apply) };
}
const cart = (storeId: string, ...ids: string[]) => ({
  userId: 'u1',
  storeId,
  status: 'active',
  isDelete: false,
  items: ids.map((id) => ({
    productId: `p-${id}`,
    productVariantId: `v-${id}`,
  })),
});
const line = (storeId: string, id: string) => ({
  storeId,
  productId: `p-${id}`,
  variantId: `v-${id}`,
});

describe('removeCheckedOutItemsFromCart — multi-store checkout', () => {
  it("empties EACH store's cart of the purchased lines (it used to clean only the first store's)", async () => {
    const carts = [cart('A', '1', '2'), cart('B', '3')];
    await svc.removeCheckedOutItemsFromCart(
      'u1',
      { items: [line('A', '1'), line('A', '2'), line('B', '3')] },
      fakeCartModel(carts),
    );
    expect(carts[0].items).toHaveLength(0);
    expect(carts[1].items).toHaveLength(0);
  });

  it('leaves unselected lines and carts of stores that were not part of the checkout alone', async () => {
    const carts = [cart('A', '1', '2'), cart('B', '3', '4'), cart('C', '5')];
    await svc.removeCheckedOutItemsFromCart(
      'u1',
      { items: [line('A', '1'), line('B', '3')] },
      fakeCartModel(carts),
    );
    expect(carts[0].items.map((i: any) => i.productId)).toEqual(['p-2']);
    expect(carts[1].items.map((i: any) => i.productId)).toEqual(['p-4']);
    expect(carts[2].items.map((i: any) => i.productId)).toEqual(['p-5']);
  });

  it("never touches another user's cart for the same store, and is idempotent on a webhook replay", async () => {
    const other = { ...cart('A', '1'), userId: 'u2' };
    const carts = [cart('A', '1', '2'), other];
    const model = fakeCartModel(carts);
    const checkout = { items: [line('A', '1')] };
    await svc.removeCheckedOutItemsFromCart('u1', checkout, model);
    await svc.removeCheckedOutItemsFromCart('u1', checkout, model); // replay
    expect(carts[0].items.map((i: any) => i.productId)).toEqual(['p-2']);
    expect(other.items).toHaveLength(1);
  });

  it('a store-scoped (single store) checkout cleans exactly as before', async () => {
    const carts = [cart('A', '1', '2')];
    await svc.removeCheckedOutItemsFromCart(
      'u1',
      { items: [line('A', '1')] },
      fakeCartModel(carts),
    );
    expect(carts[0].items.map((i: any) => i.productId)).toEqual(['p-2']);
  });
});
