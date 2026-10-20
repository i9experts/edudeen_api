import { BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

describe('NotificationsService.updatePreferences - reminders need WhatsApp or SMS', () => {
  const make = (current: Record<string, any> | null) => {
    const model = {
      findOne: jest.fn(() => ({ select: () => ({ lean: async () => current }) })),
      findOneAndUpdate: jest.fn(async (_f: any, u: any) => ({ _id: 'p1', ...u.$set })),
    };
    const db: any = { repositories: { notificationPreferenceModel: model } };
    const svc = new NotificationsService(db, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, model };
  };

  it('rejects turning reminders on while WhatsApp and SMS are both off', async () => {
    const { svc, model } = make({ whatsappEnabled: false, smsEnabled: false });
    await expect(svc.updatePreferences('u1', 'user', { retentionChannelsEnabled: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects it for a user with no preference document yet', async () => {
    const { svc } = make(null);
    await expect(svc.updatePreferences('u1', 'user', { retentionChannelsEnabled: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows it when WhatsApp or SMS is already on', async () => {
    const { svc, model } = make({ whatsappEnabled: false, smsEnabled: true });
    await svc.updatePreferences('u1', 'user', { retentionChannelsEnabled: true });
    expect(model.findOneAndUpdate.mock.calls[0][1].$set.retentionChannelsEnabled).toBe(true);
  });

  it('allows it when the same request turns a channel on (changes are applied first)', async () => {
    const { svc, model } = make({ whatsappEnabled: false, smsEnabled: false });
    await svc.updatePreferences('u1', 'user', { whatsappEnabled: true, retentionChannelsEnabled: true });
    const set = model.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.whatsappEnabled).toBe(true);
    expect(set.retentionChannelsEnabled).toBe(true);
  });

  it('rejects turning the last channel off AND reminders on in one request', async () => {
    const { svc } = make({ whatsappEnabled: true, smsEnabled: false });
    await expect(svc.updatePreferences('u1', 'user', { whatsappEnabled: false, retentionChannelsEnabled: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('switches reminders off when the last channel is turned off', async () => {
    const { svc, model } = make({ whatsappEnabled: true, smsEnabled: false, retentionChannelsEnabled: true });
    await svc.updatePreferences('u1', 'user', { whatsappEnabled: false });
    expect(model.findOneAndUpdate.mock.calls[0][1].$set.retentionChannelsEnabled).toBe(false);
  });

  it('keeps reminders when another channel stays on', async () => {
    const { svc, model } = make({ whatsappEnabled: true, smsEnabled: true, retentionChannelsEnabled: true });
    await svc.updatePreferences('u1', 'user', { whatsappEnabled: false });
    expect(model.findOneAndUpdate.mock.calls[0][1].$set.retentionChannelsEnabled).toBeUndefined();
  });

  it('does not touch the channel check for unrelated topic toggles', async () => {
    const { svc, model } = make({ whatsappEnabled: false, smsEnabled: false });
    await svc.updatePreferences('u1', 'user', { orders: false });
    expect(model.findOne).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate.mock.calls[0][1].$set['prefs.orders']).toBe(false);
  });
});
