/* eslint-disable prettier/prettier */
import { NotificationsService } from './notifications.service';

const SID = 'a'.repeat(24);

function make() {
  const model: any = {
    countDocuments: jest.fn(async () => 0),
    updateMany: jest.fn(async () => ({})),
    deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
    find: jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) })),
  };
  const svc: any = new NotificationsService({ repositories: { notificationModel: model } } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, model };
}

describe('seller notification scope', () => {
  it('unread count, mark-all and clear-read stay inside the open store', async () => {
    const { svc, model } = make();
    await svc.unreadCount('u1', { storeId: SID });
    await svc.markAllRead('u1', { storeId: SID });
    await svc.clearRead('u1', { storeId: SID });
    for (const call of [model.countDocuments.mock.calls[0][0], model.updateMany.mock.calls[0][0], model.deleteMany.mock.calls[0][0]]) {
      expect(call.recipientId).toBe('u1');
      expect(JSON.stringify(call.$or)).toContain(SID);
    }
  });

  it('no store = account-wide (buyers / old clients); bad ids are ignored', async () => {
    const { svc, model } = make();
    await svc.markAllRead('u1');
    await svc.markAllRead('u1', { storeId: 'nope' });
    expect(model.updateMany.mock.calls[0][0]).toEqual({ recipientId: 'u1', isRead: false });
    expect(model.updateMany.mock.calls[1][0]).toEqual({ recipientId: 'u1', isRead: false });
  });

  it('scope=account only matches notices that belong to no store', async () => {
    const { svc, model } = make();
    await svc.unreadCount('u1', { scope: 'account' });
    expect(model.countDocuments.mock.calls[0][0].$and).toBeTruthy();
  });
});
