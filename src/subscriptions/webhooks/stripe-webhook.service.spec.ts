/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
import { StripeWebhookService } from './stripe-webhook.service';

describe('StripeWebhookService.receive — event loss window', () => {
  const build = (existingStatus: string | null) => {
    const event = { id: 'evt_1', type: 'invoice.payment_succeeded', data: { object: { id: 'in_1' } } };
    const webhookEventModel: any = {
      create: jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 })),
      findOne: jest.fn().mockReturnValue({ select: () => ({ lean: async () => (existingStatus ? { status: existingStatus } : null) }) }),
    };
    const queue: any = { add: jest.fn().mockResolvedValue(undefined) };
    const gateway: any = { stripeClient: { webhooks: { constructEvent: () => event } } };
    const config: any = { get: () => 'whsec_x' };
    const svc: any = new StripeWebhookService(config, gateway, { repositories: { webhookEventModel } } as any, queue);
    jest.spyOn(svc.logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc.logger, 'log').mockImplementation(() => undefined);
    return { svc, queue };
  };

  it('a duplicate of an event that was recorded but never processed is re-enqueued, not dropped', async () => {
    const { svc, queue } = build('received');
    const res = await svc.receive(Buffer.from('{}'), 'sig');
    expect(queue.add).toHaveBeenCalledWith(expect.anything(), { eventId: 'evt_1', type: 'invoice.payment_succeeded' }, { jobId: 'evt_1' });
    expect(res).toEqual({ received: true });
  });

  it('a duplicate of an already-processed event is ignored', async () => {
    const { svc, queue } = build('processed');
    const res = await svc.receive(Buffer.from('{}'), 'sig');
    expect(queue.add).not.toHaveBeenCalled();
    expect(res).toEqual({ received: true, duplicate: true });
  });
});
