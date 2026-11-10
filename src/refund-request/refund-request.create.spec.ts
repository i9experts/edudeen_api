/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RefundRequestService } from './refund-request.service';
import { cleanEvidenceImages, cleanRefundEvidence } from './refund-evidence.util';

const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/uploads/images/a.jpg';
const NOTE = 'The cover was torn when the parcel arrived.';

function build(itemType: 'physical' | 'digital' = 'physical') {
  const sellerOrder = {
    _id: { toString: () => 'so-1' }, storeId: 'store-1', sellerId: 'seller-1', status: 'delivered',
    items: [{ _id: { toString: () => 'item-1' }, name: 'Book', type: itemType, status: 'delivered', downloadCount: 0 }],
  };
  const order = { _id: 'order-1', userId: 'buyer-1', orderNumber: 'O1', isPaid: true, paymentType: 'stripe', sellerOrders: [sellerOrder] };
  const rows: any[] = [];
  const model: any = {
    // yield so a racing caller would see the same empty table
    findOne: jest.fn(async (q: any) => { await Promise.resolve(); return rows.find((r) => r.status === 'pending' && q.itemIds.$in.some((i: string) => r.itemIds.includes(i))) ?? null; }),
    create: jest.fn(async (doc: any) => { await new Promise((r) => setTimeout(r, 5)); const d = { _id: { toString: () => 'rr-' + rows.length }, ...doc }; rows.push(d); return d; }),
  };
  const repos: any = {
    refundRequestModel: model,
    orderModel: { findOne: jest.fn().mockResolvedValue(order) },
    storeModel: { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ sellerId: 'seller-1' }) }) }) },
  };
  const held = new Set<string>();
  const redis: any = {
    isConnected: true,
    withLock: jest.fn(async (key: string, _ttl: number, fn: () => Promise<void>) => {
      if (held.has(key)) return 'lock_not_acquired';
      held.add(key);
      try { await fn(); return 'ran'; } finally { held.delete(key); }
    }),
  };
  const svc = new RefundRequestService(
    { repositories: repos } as any, {} as any, {} as any, {} as any,
    { log: jest.fn().mockResolvedValue(true) } as any, undefined, redis,
  );
  return { svc, rows };
}

const dto = (extra: any = {}) => ({ orderId: 'order-1', sellerOrderId: 'so-1', itemIds: ['item-1'], reasonCode: 'damaged', note: NOTE, ...extra });

describe('refund request evidence', () => {
  it('another user gets 403', async () => {
    const { svc } = build();
    await expect(svc.createRequest('intruder', 'user', dto())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('two parallel submits create exactly one request', async () => {
    const { svc, rows } = build();
    const res = await Promise.allSettled([svc.createRequest('buyer-1', 'user', dto()), svc.createRequest('buyer-1', 'user', dto())]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('stores reason code, note and photos for a physical item', async () => {
    const { svc, rows } = build();
    await svc.createRequest('buyer-1', 'user', dto({ evidenceImages: [IMG] }));
    expect(rows[0]).toMatchObject({ reasonCode: 'damaged', note: NOTE, evidenceImages: [IMG], reason: 'Item arrived damaged' });
  });

  it('old-style request (reason only) still works', async () => {
    const { svc, rows } = build();
    await svc.createRequest('buyer-1', 'user', { orderId: 'order-1', sellerOrderId: 'so-1', itemIds: ['item-1'], reason: 'Broken spine' });
    expect(rows[0].reason).toBe('Broken spine');
    expect(rows[0].evidenceImages).toBeUndefined();
  });

  it('rejects photos on a digital item', async () => {
    const { svc } = build('digital');
    await expect(svc.createRequest('buyer-1', 'user', dto({ reasonCode: 'digital_not_working', evidenceImages: [IMG] }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores the opening trail entry', async () => {
    const { svc, rows } = build();
    await svc.createRequest('buyer-1', 'user', dto());
    expect(rows[0].history).toEqual([expect.objectContaining({ status: 'requested', by: 'buyer-1', byRole: 'user' })]);
  });

  it('a code from the OLD list is no longer accepted for new requests', async () => {
    const { svc } = build();
    await expect(svc.createRequest('buyer-1', 'user', dto({ reasonCode: 'incomplete' }))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('refund evidence validation', () => {
  it('rejects non-image uploads (raw / pdf / other host / http)', () => {
    for (const bad of [
      'https://res.cloudinary.com/demo/raw/upload/v1/uploads/documents/a.pdf',
      'https://res.cloudinary.com/demo/image/upload/v1/a.svg',
      'https://evil.example.com/image/upload/a.jpg',
      'http://res.cloudinary.com/demo/image/upload/a.jpg',
    ]) expect(() => cleanEvidenceImages([bad])).toThrow(BadRequestException);
  });
  it('max 4 photos', () => {
    const imgs = ['a', 'b', 'c', 'd', 'e'].map((n) => IMG.replace('a.jpg', `${n}.jpg`));
    expect(cleanEvidenceImages(imgs.slice(0, 4))).toHaveLength(4);
    expect(() => cleanEvidenceImages(imgs)).toThrow(BadRequestException);
  });
  it('note must be 20-1000 chars', () => {
    expect(() => cleanRefundEvidence({ reasonCode: 'damaged', note: 'short' }, ['physical'])).toThrow(BadRequestException);
    expect(() => cleanRefundEvidence({ reasonCode: 'damaged', note: 'x'.repeat(1001) }, ['physical'])).toThrow(BadRequestException);
  });
  it('unknown reason code and file-access reason on physical are refused', () => {
    expect(() => cleanRefundEvidence({ reasonCode: 'nope', note: NOTE }, ['physical'])).toThrow(BadRequestException);
    expect(() => cleanRefundEvidence({ reasonCode: 'digital_not_working', note: NOTE }, ['physical'])).toThrow(BadRequestException);
    expect(() => cleanRefundEvidence({ reasonCode: 'cant_access_file', note: NOTE }, ['digital'])).toThrow(BadRequestException);
    expect(cleanRefundEvidence({ reasonCode: 'other', note: NOTE }, ['physical']).reasonCode).toBe('other');
  });
});
