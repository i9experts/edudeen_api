/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy test */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PromotionsService } from './promotions.service';

const DAY = 86_400_000;

function make(requestDoc: any, opts: { refundFails?: boolean; existingRefund?: boolean } = {}) {
  const promotionRequestModel: any = {
    findOne: jest.fn().mockResolvedValue(requestDoc),
    findById: jest.fn().mockResolvedValue(requestDoc ? { ...requestDoc, toObject: () => ({ ...requestDoc }) } : null),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    exists: jest.fn().mockResolvedValue(requestDoc ? { _id: 'x' } : null),
    find: jest.fn(),
    countDocuments: jest.fn(),
  };
  const bannerModel: any = {
    countDocuments: jest.fn().mockResolvedValue(2),
    create: jest.fn().mockResolvedValue({ _id: 'b1' }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const adminModel: any = { find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ email: 'a@x.com' }]) }) }) };
  const repositories = { promotionRequestModel, bannerModel, adminModel, storeModel: {} };
  const activityLog = { log: jest.fn() };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const svc: any = new PromotionsService(
    { repositories } as any, {} as any, {} as any, activityLog as any, notifications as any, email as any, {} as any,
    { get: () => undefined } as any, {} as any,
  );
  const stripe: any = {
    paymentIntents: { retrieve: jest.fn().mockResolvedValue({ id: 'pi_1', latest_charge: 'ch_1', status: 'succeeded' }) },
    refunds: {
      list: jest.fn().mockResolvedValue({ data: opts.existingRefund ? [{ amount: 500, status: 'succeeded' }] : [] }),
      create: opts.refundFails ? jest.fn().mockRejectedValue(new Error('stripe down')) : jest.fn().mockResolvedValue({ id: 're_1' }),
    },
  };
  svc.stripe = stripe;
  return { svc, promotionRequestModel, bannerModel, activityLog, notifications, email, stripe };
}

const paidActive = () => ({
  _id: 'req1', sellerId: 'sel1', storeId: 'st1', status: 'active', paymentStatus: 'paid', priceUSD: 100,
  stripePaymentIntentId: 'pi_1', resultingBannerId: 'b9', placement: 'homepageHero',
  startAt: new Date(Date.now() - 5 * DAY), endAt: new Date(Date.now() + 5 * DAY),
});

describe('Phase 4/B: seller cancel is refund-gated and pro-rated', () => {
  it('pro-rates: full before start, remaining share while live, nothing after the end', () => {
    const { svc } = make(null);
    const now = new Date();
    expect(svc.proratedRefundUSD({ priceUSD: 100, startAt: new Date(+now + DAY), endAt: new Date(+now + 3 * DAY) }, now)).toBe(100);
    expect(svc.proratedRefundUSD({ priceUSD: 100, startAt: new Date(+now - 5 * DAY), endAt: new Date(+now + 5 * DAY) }, now)).toBe(50);
    expect(svc.proratedRefundUSD({ priceUSD: 100, startAt: new Date(+now - 5 * DAY), endAt: new Date(+now - DAY) }, now)).toBe(0);
  });

  it('refund fails -> NOT cancelled, error to the seller, admin alert (activity log + e-mail)', async () => {
    const { svc, promotionRequestModel, activityLog, email } = make(paidActive(), { refundFails: true });
    await expect(svc.cancel('sel1', 'req1')).rejects.toThrow(BadRequestException);
    expect(promotionRequestModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'promotion_refund_alert', isSecurityAlert: true }));
    expect(email.sendMail).toHaveBeenCalled();
  });

  it('refund ok -> cancelled in one atomic write with the refunded amount, banner switched off', async () => {
    const { svc, promotionRequestModel, bannerModel, stripe } = make(paidActive());
    promotionRequestModel.findOneAndUpdate.mockResolvedValue({ ...paidActive(), status: 'cancelled' });
    await svc.cancel('sel1', 'req1');
    const refundArgs = stripe.refunds.create.mock.calls[0];
    expect(refundArgs[0].amount).toBeGreaterThan(4900);
    expect(refundArgs[0].amount).toBeLessThanOrEqual(5000); // ~half of 100 USD in cents
    const [filter, update] = promotionRequestModel.findOneAndUpdate.mock.calls[0];
    expect(filter.status).toEqual({ $in: ['pending', 'approved', 'active'] });
    expect(update.$set).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    expect(update.$set.refundedUSD).toBeGreaterThan(49);
    expect(bannerModel.findByIdAndUpdate).toHaveBeenCalledWith('b9', { $set: { status: 'expired', isActive: false } });
  });

  it('never refunds twice: an existing refund on the charge is reused', async () => {
    const { svc, promotionRequestModel, stripe } = make(paidActive(), { existingRefund: true });
    promotionRequestModel.findOneAndUpdate.mockResolvedValue({ ...paidActive(), status: 'cancelled' });
    await svc.cancel('sel1', 'req1');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(promotionRequestModel.findOneAndUpdate.mock.calls[0][1].$set.refundedUSD).toBe(5);
  });

  it('an unpaid pending request cancels with no Stripe call', async () => {
    const { svc, promotionRequestModel, stripe } = make({ ...paidActive(), status: 'pending', paymentStatus: 'pending', resultingBannerId: null });
    promotionRequestModel.findOneAndUpdate.mockResolvedValue({ status: 'cancelled' });
    await svc.cancel('sel1', 'req1');
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('a cancel that loses a race (status changed) is a 400, not a silent success', async () => {
    const { svc, promotionRequestModel } = make({ ...paidActive(), status: 'pending', paymentStatus: 'pending', resultingBannerId: null });
    promotionRequestModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(svc.cancel('sel1', 'req1')).rejects.toThrow(BadRequestException);
  });
});

describe('Phase 4/C: payment webhook is status-checked and activation is atomic', () => {
  const approved = () => ({ _id: 'req1', sellerId: 'sel1', storeId: 'st1', status: 'approved', paymentStatus: 'pending', priceUSD: 100, stripePaymentIntentId: 'pi_1', placement: 'homepageHero', startAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + DAY), creativeUrl: 'u', creativePublicId: 'p', linkTarget: 't' });

  it('a payment on an approved request is claimed atomically (only approved + unpaid) and activates', async () => {
    const { svc, promotionRequestModel, bannerModel } = make(approved());
    promotionRequestModel.findOneAndUpdate
      .mockResolvedValueOnce({ ...approved(), paymentStatus: 'paid' }) // paid claim
      .mockResolvedValueOnce({ ...approved(), paymentStatus: 'paid', status: 'active' }); // activation claim
    await svc.handlePaymentSucceeded({ id: 'pi_1', metadata: { promotionRequestId: 'req1' } });
    expect(promotionRequestModel.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'req1', status: 'approved', paymentStatus: { $in: ['pending', 'failed'] } });
    expect(promotionRequestModel.findOneAndUpdate.mock.calls[1][0]).toEqual({ _id: 'req1', status: 'approved', paymentStatus: 'paid', resultingBannerId: null });
    expect(bannerModel.create).toHaveBeenCalledTimes(1);
  });

  it('a LATE payment on a cancelled request is refunded automatically and no banner goes live', async () => {
    const cancelled = { ...approved(), status: 'cancelled' };
    const { svc, promotionRequestModel, bannerModel, stripe, activityLog } = make(cancelled);
    promotionRequestModel.findOneAndUpdate.mockResolvedValueOnce(null);
    await svc.handlePaymentSucceeded({ id: 'pi_1', metadata: { promotionRequestId: 'req1' } });
    expect(stripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ charge: 'ch_1', amount: 10000 }), expect.anything());
    expect(promotionRequestModel.updateOne).toHaveBeenCalledWith({ _id: 'req1' }, { $set: expect.objectContaining({ paymentStatus: 'refunded' }) });
    expect(bannerModel.create).not.toHaveBeenCalled();
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'promotion_refund_alert' }));
  });

  it('a late payment whose auto-refund fails is kept as paid and admins are alerted to refund by hand', async () => {
    const { svc, promotionRequestModel, activityLog, bannerModel } = make({ ...approved(), status: 'rejected' }, { refundFails: true });
    promotionRequestModel.findOneAndUpdate.mockResolvedValueOnce(null);
    await svc.handlePaymentSucceeded({ id: 'pi_1', metadata: { promotionRequestId: 'req1' } });
    expect(promotionRequestModel.updateOne).toHaveBeenCalledWith({ _id: 'req1' }, { $set: { paymentStatus: 'paid' } });
    expect(activityLog.log.mock.calls[0][0].description).toMatch(/FAILED/);
    expect(bannerModel.create).not.toHaveBeenCalled();
  });

  it('two racing activations create ONE banner: the loser of the atomic claim does nothing', async () => {
    const { svc, promotionRequestModel, bannerModel } = make(approved());
    promotionRequestModel.findOneAndUpdate.mockResolvedValue(null);
    await svc['activatePaidRequest']({ _id: 'req1' });
    expect(bannerModel.create).not.toHaveBeenCalled();
  });

  it('a banner that cannot be created hands the claim back for the next cron run', async () => {
    const { svc, promotionRequestModel, bannerModel } = make(approved());
    promotionRequestModel.findOneAndUpdate.mockResolvedValue({ ...approved(), status: 'active' });
    bannerModel.create.mockRejectedValueOnce(new Error('db'));
    await svc['activatePaidRequest']({ _id: 'req1' });
    expect(promotionRequestModel.updateOne).toHaveBeenCalledWith({ _id: 'req1', status: 'active', resultingBannerId: null }, { $set: { status: 'approved' } });
  });

  it('cancelled between claim and linking: the new banner is switched off, not left live', async () => {
    const { svc, promotionRequestModel, bannerModel } = make(approved());
    promotionRequestModel.findOneAndUpdate.mockResolvedValue({ ...approved(), status: 'active' });
    promotionRequestModel.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await svc['activatePaidRequest']({ _id: 'req1' });
    expect(bannerModel.findByIdAndUpdate).toHaveBeenCalledWith('b1', { $set: { status: 'expired', isActive: false } });
  });

  it('confirmPayment reports a refunded late payment instead of "confirmed"', async () => {
    const { svc, promotionRequestModel } = make({ ...approved(), status: 'cancelled' });
    promotionRequestModel.findOneAndUpdate.mockResolvedValueOnce(null);
    await expect(svc.confirmPayment('sel1', 'req1')).rejects.toThrow(/refunded/);
  });
});

describe('Phase 4/C: approve / reject are status-guarded atomic updates; admin list is paginated', () => {
  it('approve only flips a pending request; otherwise 400, or 404 when missing', async () => {
    const { svc, promotionRequestModel } = make({ _id: 'req1' });
    promotionRequestModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(svc.approve('adm', 'req1')).rejects.toThrow(/Only pending/);
    expect(promotionRequestModel.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'req1', status: 'pending' });
    promotionRequestModel.exists.mockResolvedValue(null);
    await expect(svc.approve('adm', 'req1')).rejects.toThrow(NotFoundException);
  });

  it('reject needs a reason and is guarded the same way', async () => {
    const { svc, promotionRequestModel } = make({ _id: 'req1' });
    await expect(svc.reject('adm', 'req1', ' ')).rejects.toThrow(BadRequestException);
    promotionRequestModel.findOneAndUpdate.mockResolvedValue({ _id: 'req1', storeId: 's', sellerId: 'x', placement: 'p' });
    await svc.reject('adm', 'req1', 'bad image');
    expect(promotionRequestModel.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'req1', status: 'pending' });
  });

  it('adminList caps the page size and returns pagination', async () => {
    const { svc, promotionRequestModel } = make(null);
    const chain: any = { sort: () => chain, skip: jest.fn(() => chain), limit: jest.fn(() => chain), lean: () => Promise.resolve([{ _id: 'a' }]) };
    promotionRequestModel.find.mockReturnValue(chain);
    promotionRequestModel.countDocuments.mockResolvedValue(450);
    const res = await svc.adminList('pending', 2, 5000);
    expect(chain.limit).toHaveBeenCalledWith(200);
    expect(chain.skip).toHaveBeenCalledWith(200);
    expect(res.pagination).toEqual({ page: 2, limit: 200, total: 450, totalPages: 3 });
  });
});