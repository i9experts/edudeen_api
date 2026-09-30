/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { JwtService } from '@nestjs/jwt';
import { OrdersService } from './orders.service';

const SECRET = 'test-secret';
const USER = 'buyer-1';

function makeOrder(itemOverrides: Record<string, any> = {}, orderOverrides: Record<string, any> = {}) {
  return {
    _id: 'order-1',
    userId: USER,
    isPaid: true,
    paidAt: new Date(),
    orderNumber: 'ED-1001',
    sellerOrders: [
      { items: [{ productId: 'p1', type: 'digital', status: 'completed', downloadCount: 0, ...itemOverrides }] },
    ],
    ...orderOverrides,
  };
}

function makeProduct(digitalOverrides: Record<string, any> = {}, productOverrides: Record<string, any> = {}) {
  return {
    _id: 'p1',
    isDelete: false,
    removedByAdmin: false,
    digital: {
      files: [{ url: 'private/digital-products/f1', name: 'worksheet.zip', mimeType: 'application/zip' }],
      downloadLimit: 'unlimited',
      linkExpiryDays: null,
      pdfStampingEnabled: false,
      ...digitalOverrides,
    },
    ...productOverrides,
  };
}

describe('OrdersService — digital delivery', () => {
  let service: OrdersService;
  let orderModel: any;
  let productModel: any;
  let jwt: JwtService;

  const setup = (order: any, product: any, updateModified = 1) => {
    orderModel = {
      findOne: jest.fn().mockResolvedValue(order),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: updateModified }),
    };
    productModel = { findOne: jest.fn().mockResolvedValue(product) };
    jwt = new JwtService({ secret: SECRET });
    const db: any = { repositories: { orderModel, productModel, userModel: {} } };
    const upload: any = {
      resolveMimeType: (_n: string, fb: string) => fb,
      generateSignedUrl: () => 'https://signed.example/file',
    };
    const config: any = { get: () => SECRET };
    service = new OrdersService(db, upload, jwt, config, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  };

  // On newer Node versions restoreAllMocks can leave global.fetch undefined
  // after a spy on it, which makes the next spyOn(global, 'fetch') throw.
  const realFetch = global.fetch;
  afterEach(() => {
    jest.restoreAllMocks();
    if (typeof global.fetch !== 'function') global.fetch = realFetch;
  });

  it('issues typed download tokens for a paid, active item', async () => {
    setup(makeOrder(), makeProduct());
    const res = await service.getDownloadUrls(USER, 'order-1', 'p1');
    const payload: any = jwt.verify(res.data.files[0].token, { secret: SECRET });
    expect(payload.typ).toBe('download');
    expect(res.data.remaining).toBe('unlimited');
  });

  it('revokes access once the item is refunded', async () => {
    setup(makeOrder({ status: 'refunded' }), makeProduct());
    await expect(service.getDownloadUrls(USER, 'order-1', 'p1')).rejects.toThrow(/revoked/);
  });

  it('revokes access once the item is cancelled', async () => {
    setup(makeOrder({ status: 'cancelled' }), makeProduct());
    await expect(service.getDownloadLink(USER, 'order-1', 'p1', 0)).rejects.toThrow(/revoked/);
  });

  it('rejects another user', async () => {
    setup(makeOrder(), makeProduct());
    await expect(service.getDownloadUrls('someone-else', 'order-1', 'p1')).rejects.toThrow(/Unauthorized/);
  });

  it('keeps access after the seller deletes the listing', async () => {
    setup(makeOrder(), makeProduct({}, { isDelete: true }));
    await expect(service.getDownloadUrls(USER, 'order-1', 'p1')).resolves.toBeDefined();
  });

  it('blocks access after an admin takedown', async () => {
    setup(makeOrder(), makeProduct({}, { isDelete: true, removedByAdmin: true }));
    await expect(service.getDownloadUrls(USER, 'order-1', 'p1')).rejects.toThrow(/no longer available/);
  });

  it('enforces link expiry on the single-link path too', async () => {
    const paidAt = new Date(Date.now() - 10 * 86_400_000);
    setup(makeOrder({}, { paidAt }), makeProduct({ linkExpiryDays: 3 }));
    await expect(service.getDownloadLink(USER, 'order-1', 'p1', 0)).rejects.toThrow(/expired/);
  });

  it('enforces the download limit before issuing links', async () => {
    setup(makeOrder({ downloadCount: 3 }), makeProduct({ downloadLimit: '3' }));
    await expect(service.getDownloadUrls(USER, 'order-1', 'p1')).rejects.toThrow(/limit reached/);
  });

  it('refuses an access token replayed as a download token', async () => {
    setup(makeOrder(), makeProduct());
    const accessLike = jwt.sign({ sub: USER, typ: 'access', userId: USER, orderId: 'order-1', productId: 'p1', fileIndex: 0 });
    await expect(service.downloadByToken(accessLike)).rejects.toThrow(/expired or invalid/);
  });

  it('refuses to serve a stamped PDF through the raw download path', async () => {
    setup(makeOrder(), makeProduct({
      pdfStampingEnabled: true,
      files: [{ url: 'x', name: 'book.pdf', mimeType: 'application/pdf' }],
    }));
    const { data } = await service.getDownloadLink(USER, 'order-1', 'p1', 0);
    expect(data.endpoint).toBe('/api/orders/stream-pdf-token');
    await expect(service.downloadByToken(data.token)).rejects.toThrow(/stamped/);
  });

  it('counts every download atomically, even when unlimited', async () => {
    setup(makeOrder(), makeProduct());
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('file-bytes', { status: 200, headers: { 'content-length': '10' } }) as any,
    );
    const { data } = await service.getDownloadLink(USER, 'order-1', 'p1', 0);
    const out = await service.downloadByToken(data.token);
    expect(out.contentLength).toBe(10);
    expect(orderModel.updateOne).toHaveBeenCalledWith(
      { _id: 'order-1' },
      { $inc: { 'sellerOrders.0.items.0.downloadCount': 1 } },
    );
  });

  it('uses a conditional update so concurrent downloads cannot exceed the limit', async () => {
    // updateOne reports nothing modified → another request consumed the last slot
    setup(makeOrder({ downloadCount: 2 }), makeProduct({ downloadLimit: '3' }), 0);
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('x', { status: 200 }) as any);
    const { data } = await service.getDownloadLink(USER, 'order-1', 'p1', 0);
    await expect(service.downloadByToken(data.token)).rejects.toThrow(/limit reached/);
    expect(orderModel.updateOne).toHaveBeenCalledWith(
      { _id: 'order-1', 'sellerOrders.0.items.0.downloadCount': { $lt: 3 } },
      { $inc: { 'sellerOrders.0.items.0.downloadCount': 1 } },
    );
  });
});
