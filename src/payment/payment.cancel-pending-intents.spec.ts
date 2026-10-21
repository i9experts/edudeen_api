import { PaymentService } from './payment.service';

// cancelPendingCardIntents is private and only needs `stripe` + the transaction model,
// so the service is built without its (large) dependency graph.
function build(pending: any[], cancel: jest.Mock) {
  const paymentTransactionModel = {
    find: jest.fn().mockResolvedValue(pending),
    findByIdAndUpdate: jest.fn().mockResolvedValue(null),
  };
  const svc: any = Object.create(PaymentService.prototype);
  svc.stripe = { paymentIntents: { cancel } };
  svc.databaseService = { repositories: { paymentTransactionModel } };
  return { svc, paymentTransactionModel };
}

describe('PaymentService.cancelPendingCardIntents', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('cancels the open intent and marks its transaction failed', async () => {
    const cancel = jest.fn().mockResolvedValue({});
    const { svc, paymentTransactionModel } = build([{ _id: 't1', stripePaymentIntentId: 'pi_1' }], cancel);
    await svc.cancelPendingCardIntents('c1');
    expect(cancel).toHaveBeenCalledWith('pi_1');
    expect(paymentTransactionModel.findByIdAndUpdate).toHaveBeenCalledWith('t1', { status: 'failed' });
  });

  it('keeps the transaction pending when Stripe refuses (already paid) so the refund path can run', async () => {
    const cancel = jest.fn().mockRejectedValue(new Error('PaymentIntent has status succeeded'));
    const { svc, paymentTransactionModel } = build([{ _id: 't1', stripePaymentIntentId: 'pi_1' }], cancel);
    await expect(svc.cancelPendingCardIntents('c1')).resolves.toBeUndefined();
    expect(paymentTransactionModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('does nothing without Stripe configured or without an intent id', async () => {
    const cancel = jest.fn();
    const a = build([{ _id: 't1', stripePaymentIntentId: null }], cancel);
    await a.svc.cancelPendingCardIntents('c1');
    expect(cancel).not.toHaveBeenCalled();
    const b = build([{ _id: 't1', stripePaymentIntentId: 'pi_1' }], cancel);
    b.svc.stripe = null;
    await b.svc.cancelPendingCardIntents('c1');
    expect(cancel).not.toHaveBeenCalled();
  });
});
