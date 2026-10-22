/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { ManualPaymentsService, REJECTED_PROOF_HOLD_DAYS } from './manual-payments.service';

const DAY = 86_400_000;

function make() {
  const proofModel: any = { findOneAndUpdate: jest.fn(), updateOne: jest.fn().mockResolvedValue({}), find: jest.fn() };
  const orderModel: any = { find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn().mockResolvedValue({}) };
  const productVariantModel: any = { updateOne: jest.fn().mockResolvedValue({}) };
  const financeService: any = { recordSaleDurable: jest.fn().mockResolvedValue({ creditStatus: 'credited' }) };
  const paymentService: any = { restoreGiftCardForItems: jest.fn().mockResolvedValue(undefined) };
  const activityLog: any = { log: jest.fn() };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const svc: any = new ManualPaymentsService(
    { repositories: { manualPaymentProofModel: proofModel, orderModel, productVariantModel } } as any,
    {} as any, paymentService, financeService, {} as any, activityLog, notifications,
  );
  return { svc, proofModel, orderModel, productVariantModel, financeService, paymentService, activityLog, notifications };
}

describe('Phase 4/D: adminApprove releases the claim when it fails midway', () => {
  const claimed = { status: 'approved', orderIds: ['o1'], amountPKR: 100, userId: 'u1', toObject() { return { ...this }; } };
  const order = { _id: 'o1', currency: 'PKR', orderStatus: 'pending', sellerOrders: [{ storeId: 's', sellerId: 'x', subtotal: 100, platformSponsoredDiscountUSD: 0, items: [{}] }] };

  it('a throw during the paid-update/credit loop puts the proof back to pending and answers 400', async () => {
    const { svc, proofModel, orderModel } = make();
    proofModel.findOneAndUpdate.mockResolvedValue(claimed);
    orderModel.find.mockResolvedValue([order]);
    orderModel.findOneAndUpdate.mockRejectedValueOnce(new Error('mongo blip'));
    await expect(svc.adminApprove('p1', 'adm')).rejects.toThrow(BadRequestException);
    expect(proofModel.updateOne).toHaveBeenCalledWith({ _id: 'p1', status: 'approved' }, { $set: expect.objectContaining({ status: 'pending', reviewedByAdminId: null }) });
  });

  it('the retry after that goes through and credits (idempotent steps)', async () => {
    const { svc, proofModel, orderModel, financeService } = make();
    proofModel.findOneAndUpdate.mockResolvedValue(claimed);
    orderModel.find.mockResolvedValue([order]);
    orderModel.findOneAndUpdate.mockRejectedValueOnce(new Error('mongo blip')).mockResolvedValue({});
    await expect(svc.adminApprove('p1', 'adm')).rejects.toThrow();
    await expect(svc.adminApprove('p1', 'adm')).resolves.toBeTruthy();
    expect(financeService.recordSaleDurable).toHaveBeenCalledTimes(1);
  });

  it('a failure in the seller credit loop is released too', async () => {
    const { svc, proofModel, orderModel, financeService } = make();
    proofModel.findOneAndUpdate.mockResolvedValue(claimed);
    orderModel.find.mockResolvedValue([order]);
    financeService.recordSaleDurable.mockRejectedValueOnce(new Error('finance down'));
    await expect(svc.adminApprove('p1', 'adm')).rejects.toThrow(BadRequestException);
    expect(proofModel.updateOne).toHaveBeenCalled();
  });
});

describe('Phase 4/D: stale rejected proofs release their unpaid orders', () => {
  const stale = { _id: 'p1', userId: 'u1', storeId: 's1', orderIds: ['o1'], status: 'rejected', reviewedAt: new Date(Date.now() - 8 * DAY) };
  const unpaid = () => ({
    _id: 'o1', isPaid: false, orderStatus: 'pending',
    sellerOrders: [{ status: 'pending', items: [{ status: 'pending', type: 'physical', variantId: 'v1', quantity: 2 }, { status: 'pending', type: 'digital', variantId: 'v2', quantity: 1 }] }],
  });

  it('claims the proof, cancels the order, restocks physical items only, notifies and logs', async () => {
    const { svc, proofModel, orderModel, productVariantModel, paymentService, activityLog, notifications } = make();
    proofModel.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [stale] }) }) });
    proofModel.findOneAndUpdate.mockResolvedValue({ _id: 'p1' });
    orderModel.findOne.mockResolvedValue(unpaid());
    orderModel.findOneAndUpdate.mockResolvedValue({ _id: 'o1' });
    const res = await svc.releaseStaleRejectedProofs(new Date());
    expect(res).toEqual({ proofs: 1, orders: 1 });
    expect(proofModel.find.mock.calls[0][0]).toMatchObject({ status: 'rejected', ordersReleasedAt: null });
    expect(proofModel.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'p1', status: 'rejected', ordersReleasedAt: null });
    const set = orderModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.orderStatus).toBe('cancelled');
    expect(set['sellerOrders.0.items.0.status']).toBe('cancelled');
    expect(productVariantModel.updateOne).toHaveBeenCalledTimes(1);
    expect(productVariantModel.updateOne).toHaveBeenCalledWith({ _id: 'v1', unlimitedStock: { $ne: true } }, { $inc: { stock: 2 } });
    expect(paymentService.restoreGiftCardForItems).toHaveBeenCalled();
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'manual_payment_orders_released' }));
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'u1' }));
  });

  it('only looks at proofs older than the hold window', async () => {
    const { svc, proofModel } = make();
    proofModel.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
    const now = new Date('2026-10-22T00:00:00Z');
    await svc.releaseStaleRejectedProofs(now);
    expect(proofModel.find.mock.calls[0][0].reviewedAt.$lte).toEqual(new Date(now.getTime() - REJECTED_PROOF_HOLD_DAYS * DAY));
  });

  it('does nothing when the buyer re-uploaded first (the claim is lost) - no cancel, no restock', async () => {
    const { svc, proofModel, orderModel, productVariantModel } = make();
    proofModel.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [stale] }) }) });
    proofModel.findOneAndUpdate.mockResolvedValue(null);
    expect(await svc.releaseStaleRejectedProofs(new Date())).toEqual({ proofs: 0, orders: 0 });
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(productVariantModel.updateOne).not.toHaveBeenCalled();
  });

  it('never restocks twice: if another path already cancelled the order, the guarded write loses', async () => {
    const { svc, proofModel, orderModel, productVariantModel } = make();
    proofModel.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [stale] }) }) });
    proofModel.findOneAndUpdate.mockResolvedValue({ _id: 'p1' });
    orderModel.findOne.mockResolvedValue(unpaid());
    orderModel.findOneAndUpdate.mockResolvedValue(null);
    expect(await svc.releaseStaleRejectedProofs(new Date())).toEqual({ proofs: 1, orders: 0 });
    expect(productVariantModel.updateOne).not.toHaveBeenCalled();
  });

  it('a paid or already cancelled order is skipped', async () => {
    const { svc, proofModel, orderModel } = make();
    proofModel.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [stale] }) }) });
    proofModel.findOneAndUpdate.mockResolvedValue({ _id: 'p1' });
    orderModel.findOne.mockResolvedValue(null);
    expect(await svc.releaseStaleRejectedProofs(new Date())).toEqual({ proofs: 1, orders: 0 });
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});