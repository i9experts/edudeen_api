/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
import { ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const P1 = '64b0000000000000000000a1';

function make(order: any, product: any) {
  const repos: any = {
    orderModel: { findOne: jest.fn(() => Promise.resolve(order)) },
    productModel: { findOne: jest.fn(() => Promise.resolve(product)) },
  };
  const notify = jest.fn(() => Promise.resolve());
  const svc = new OrdersService({ repositories: repos } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { notify } as any, {} as any, {} as any);
  return { svc, notify };
}
const order = (extra: any = {}) => ({
  _id: 'o1', orderNumber: 'ED-1', userId: 'u1', isPaid: true, paidAt: new Date(),
  sellerOrders: [{ items: [{ productId: P1, type: 'digital', status: 'completed' }] }], ...extra,
});

describe('resendDownloadLink', () => {
  it('notifies the owner with an email pointing at My Library (no file token)', async () => {
    const { svc, notify } = make(order(), { name: 'Algebra Pack', digital: { files: [{ name: 'a.pdf' }] } });
    const res: any = await svc.resendDownloadLink('u1', 'o1', P1);
    expect(res.success).toBe(true);
    const arg = (notify.mock.calls[0] as any[])[0];
    expect(arg).toMatchObject({ recipientId: 'u1', recipientRole: 'user', type: 'download_link_resent' });
    expect(arg.email.html).toContain('/account/downloads');
    expect(arg.email.html).not.toContain('token');
  });

  it('refuses another buyer\'s order', async () => {
    const { svc, notify } = make(order({ userId: 'someone-else' }), { name: 'X', digital: { files: [{ name: 'a.pdf' }] } });
    await expect(svc.resendDownloadLink('u1', 'o1', P1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a refunded item and an admin takedown', async () => {
    const refunded = make(order({ sellerOrders: [{ items: [{ productId: P1, type: 'digital', status: 'refunded' }] }] }), { name: 'X', digital: { files: [{}] } });
    await expect(refunded.svc.resendDownloadLink('u1', 'o1', P1)).rejects.toBeDefined();
    const removed = make(order(), { name: 'X', removedByAdmin: true, digital: { files: [{}] } });
    await expect(removed.svc.resendDownloadLink('u1', 'o1', P1)).rejects.toBeDefined();
    expect(refunded.notify).not.toHaveBeenCalled();
    expect(removed.notify).not.toHaveBeenCalled();
  });
});