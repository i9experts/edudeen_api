/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- mock-heavy tests */
/* eslint-disable prettier/prettier */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ManualPaymentsService } from './manual-payments.service';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { PaymentService } from '../payment/payment.service';
import { FinanceService } from '../finance/finance.service';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';

const USER_ID = 'user-1';
const FAKE_FILE = { originalname: 'receipt.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('x') } as any;

function makeSellerOrder(overrides: Partial<Record<string, any>> = {}) {
  return {
    storeId: 'store-1', sellerId: 'seller-1', subtotal: 100, platformSponsoredDiscountUSD: 0,
    items: [{ campaignSponsorType: null, campaignId: null }],
    ...overrides,
  };
}

describe('ManualPaymentsService', () => {
  let service: ManualPaymentsService;
  let proofModel: any;
  let orderModel: any;
  let userModel: any;
  let uploadService: UploadService;
  let paymentService: PaymentService;
  let financeService: FinanceService;
  let adminConfigService: AdminConfigService;
  let activityLogService: ActivityLogService;
  let notificationsService: NotificationsService;

  beforeEach(() => {
    proofModel = { create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) }), countDocuments: jest.fn().mockResolvedValue(0) };
    orderModel = { find: jest.fn(), findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
    userModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };

    const db = { repositories: { manualPaymentProofModel: proofModel, orderModel, userModel } } as unknown as DatabaseService;

    uploadService = {
      uploadFile: jest.fn(),
      uploadPrivateFile: jest.fn().mockResolvedValue({ publicId: 'private/payment-proofs/p1', resourceType: 'image' }),
      generateSignedUrl: jest.fn().mockReturnValue('https://signed.example.com/proof.jpg?sig=x'),
    } as any;
    paymentService = { manualBankTransferPayment: jest.fn() } as any;
    financeService = { recordSale: jest.fn().mockResolvedValue(undefined) } as any;
    adminConfigService = { getManualPaymentConfig: jest.fn().mockResolvedValue({ enabled: true, usdToPkrRate: 278, bankName: 'Meezan' }) } as any;
    activityLogService = { log: jest.fn() } as any;
    notificationsService = { notify: jest.fn().mockResolvedValue(undefined) } as any;

    service = new ManualPaymentsService(db, uploadService, paymentService, financeService, adminConfigService, activityLogService, notificationsService);
  });

  describe('getBankDetails', () => {
    it('throws when the platform admin has not enabled manual payment', async () => {
      adminConfigService.getManualPaymentConfig = jest.fn().mockResolvedValue({ enabled: false });
      await expect(service.getBankDetails()).rejects.toThrow(BadRequestException);
    });

    it('returns bank details without leaking internal-only fields', async () => {
      const result = await service.getBankDetails();
      expect(result.bankName).toBe('Meezan');
      expect(result.usdToPkrRate).toBe(278);
    });
  });

  describe('submitPayment', () => {
    it('rejects a submission with no file attached', async () => {
      await expect(service.submitPayment(USER_ID, { checkoutId: 'c1' } as any, undefined)).rejects.toThrow(BadRequestException);
    });

    it('uploads the proof BEFORE placing orders: a failed upload leaves no orphan order', async () => {
      (uploadService.uploadPrivateFile as jest.Mock).mockRejectedValueOnce(new Error('cloudinary down'));
      paymentService.manualBankTransferPayment = jest.fn();
      await expect(service.submitPayment(USER_ID, { checkoutId: 'c1' } as any, FAKE_FILE)).rejects.toThrow('cloudinary down');
      expect(paymentService.manualBankTransferPayment).not.toHaveBeenCalled();
    });

    it('places the order via PaymentService, uploads the proof, and records both USD and PKR amounts', async () => {
      const orders = [{ _id: 'order-1', orderNumber: 'ORD-1', totalAmount: 27800, currency: 'PKR' }];
      paymentService.manualBankTransferPayment = jest.fn().mockResolvedValue({ orders, amountUSD: 100, amountPKR: 27800, fxRate: 278 });
      proofModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'proof-1' }));

      const result = await service.submitPayment(USER_ID, { checkoutId: 'c1', transactionReference: 'TXN1' } as any, FAKE_FILE);

      expect(paymentService.manualBankTransferPayment).toHaveBeenCalledWith(USER_ID, 'c1');
      expect(uploadService.uploadFile).not.toHaveBeenCalled(); // proofs must never go through the public upload
      expect(uploadService.uploadPrivateFile).toHaveBeenCalledWith(FAKE_FILE, 'private/payment-proofs');
      expect(proofModel.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: USER_ID, checkoutId: 'c1', amountUSD: 100, amountPKR: 27800, fxRateUsed: 278,
        proofPublicId: 'private/payment-proofs/p1', transactionReference: 'TXN1', status: 'pending',
      }));
      expect(result.proof._id).toBe('proof-1');
      expect(result.proof.proofImageUrl).toBe('https://signed.example.com/proof.jpg?sig=x'); // clients still get a usable URL
      expect((result.proof as any).proofPublicId).toBeUndefined(); // storage id not leaked
      expect(notificationsService.notify).toHaveBeenCalled();
    });
  });

  describe('reuploadPayment', () => {
    it('throws NotFoundException when the proof does not belong to this user', async () => {
      proofModel.findOne.mockResolvedValue(null);
      await expect(service.reuploadPayment(USER_ID, 'p1', {}, FAKE_FILE)).rejects.toThrow(NotFoundException);
    });

    it('rejects a re-upload attempt on a proof that is not currently rejected', async () => {
      proofModel.findOne.mockResolvedValue({ status: 'pending' });
      await expect(service.reuploadPayment(USER_ID, 'p1', {}, FAKE_FILE)).rejects.toThrow(BadRequestException);
    });

    it('resets a rejected proof back to pending with the new image and increments reuploadCount', async () => {
      const proof: any = { status: 'rejected', rejectionReason: 'bad amount', reuploadCount: 1, save: jest.fn() };
      proofModel.findOne.mockResolvedValue(proof);

      await service.reuploadPayment(USER_ID, 'p1', { transactionReference: 'TXN2' } as any, FAKE_FILE);

      expect(proof.status).toBe('pending');
      expect(proof.rejectionReason).toBeNull();
      expect(proof.reuploadCount).toBe(2);
      expect(proof.proofPublicId).toBe('private/payment-proofs/p1');
      expect(proof.proofImageUrl).toBeNull();
      expect(uploadService.uploadFile).not.toHaveBeenCalled();
      expect(proof.save).toHaveBeenCalled();
    });
  });

  describe('adminApprove', () => {
    const lean = (v: any) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }) });
    const claimed = (o: any = {}) => ({ status: 'approved', orderIds: ['order-1'], amountPKR: 27800, userId: USER_ID, toObject() { return { ...this }; }, ...o });
    beforeEach(() => {
      proofModel.findOneAndUpdate = jest.fn();
      proofModel.updateOne = jest.fn().mockResolvedValue({});
      orderModel.findOneAndUpdate = jest.fn().mockResolvedValue({});
    });

    it('a second approve (double-click / second admin) loses the atomic claim and credits nobody', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue(null);
      proofModel.findById.mockReturnValue(lean({ status: 'approved' }));
      await expect(service.adminApprove('p1', 'admin-1')).rejects.toThrow(/status "approved"/);
      expect(financeService.recordSale).not.toHaveBeenCalled();
      expect(orderModel.find).not.toHaveBeenCalled();
    });

    it('404 for a missing proof', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue(null);
      proofModel.findById.mockReturnValue(lean(null));
      await expect(service.adminApprove('nope', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('claims only a pending proof, marks live orders paid, and credits each seller in the order currency', async () => {
      const order = { _id: 'order-1', currency: 'PKR', orderStatus: 'pending', sellerOrders: [makeSellerOrder()] };
      proofModel.findOneAndUpdate.mockResolvedValue(claimed());
      orderModel.find.mockResolvedValue([order]);

      await service.adminApprove('p1', 'admin-1');

      expect(proofModel.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'p1', status: 'pending' }, expect.anything(), expect.anything());
      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'order-1', isPaid: { $ne: true }, orderStatus: { $ne: 'cancelled' } },
        { $set: expect.objectContaining({ isPaid: true, paymentStatus: 'paid', orderStatus: 'completed' }) },
      );
      expect(financeService.recordSale).toHaveBeenCalledWith('store-1', 'seller-1', 'order-1', 100, expect.any(String), 0, null, 'PKR', 'manual_bank_transfer');
      expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'manual_payment_approved' }));
      expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual_payment_approved' }));
    });

    it('never revives a cancelled order: no paid flag, no seller credit, claim released', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue(claimed());
      orderModel.find.mockResolvedValue([{ _id: 'order-1', currency: 'PKR', orderStatus: 'cancelled', sellerOrders: [makeSellerOrder()] }]);
      await expect(service.adminApprove('p1', 'admin-1')).rejects.toThrow(/cancelled/);
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(financeService.recordSale).not.toHaveBeenCalled();
      expect(proofModel.updateOne).toHaveBeenCalledWith({ _id: 'p1', status: 'approved' }, { $set: expect.objectContaining({ status: 'pending' }) });
    });

    it('skips cancelled/refunded sub-orders and items when completing and crediting', async () => {
      const live = makeSellerOrder();
      const dead = { ...makeSellerOrder(), storeId: 'store-2', sellerId: 'seller-2', status: 'cancelled' };
      proofModel.findOneAndUpdate.mockResolvedValue(claimed());
      orderModel.find.mockResolvedValue([{ _id: 'order-1', currency: 'PKR', orderStatus: 'pending', sellerOrders: [live, dead] }]);
      await service.adminApprove('p1', 'admin-1');
      expect(financeService.recordSale).toHaveBeenCalledTimes(1);
      expect(financeService.recordSale).toHaveBeenCalledWith('store-1', 'seller-1', 'order-1', 100, expect.any(String), 0, null, 'PKR', 'manual_bank_transfer'); // store-2 (cancelled) is never credited
      const set = (orderModel.findOneAndUpdate as jest.Mock).mock.calls[0][1].$set;
      expect(Object.keys(set).some((k) => k.startsWith('sellerOrders.1.'))).toBe(false);
    });

    it('releases the claim when the proof has no orders, so it can be retried', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue(claimed());
      orderModel.find.mockResolvedValue([]);
      await expect(service.adminApprove('p1', 'admin-1')).rejects.toThrow(NotFoundException);
      expect(proofModel.updateOne).toHaveBeenCalled();
    });
  });

  describe('adminReject', () => {
    const lean = (v: any) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }) });
    beforeEach(() => { proofModel.findOneAndUpdate = jest.fn(); });

    it('throws NotFoundException for a missing proof', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue(null);
      proofModel.findById.mockReturnValue(lean(null));
      await expect(service.adminReject('missing', 'admin-1', 'reason')).rejects.toThrow(NotFoundException);
    });

    it('cannot reject a proof that was already approved', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue(null);
      proofModel.findById.mockReturnValue(lean({ status: 'approved' }));
      await expect(service.adminReject('p1', 'admin-1', 'reason')).rejects.toThrow(/status "approved"/);
    });

    it('atomically marks the proof rejected with the given reason and notifies the buyer', async () => {
      proofModel.findOneAndUpdate.mockResolvedValue({ status: 'rejected', amountPKR: 27800, userId: USER_ID, toObject() { return { ...this }; } });
      await service.adminReject('p1', 'admin-1', 'Amount mismatch');
      expect(proofModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'p1', status: 'pending' },
        { $set: expect.objectContaining({ status: 'rejected', rejectionReason: 'Amount mismatch' }) },
        expect.anything(),
      );
      expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual_payment_rejected' }));
    });
  });

  describe('proof viewing', () => {
    const lean = (v: any) => ({ lean: jest.fn().mockResolvedValue(v) });

    it('owner: mints a short-lived signed URL, inline, for a private proof', async () => {
      proofModel.findOne.mockReturnValue(lean({ proofPublicId: 'private/payment-proofs/p1', proofResourceType: 'image' }));
      const res = await service.getOwnProofUrl(USER_ID, 'proof-1');
      expect(proofModel.findOne).toHaveBeenCalledWith({ _id: 'proof-1', userId: USER_ID }); // scoped to caller
      expect(uploadService.generateSignedUrl).toHaveBeenCalledWith('private/payment-proofs/p1', 'image', 600, undefined, true);
      expect(res.url).toContain('signed.example.com');
    });

    it("owner: another buyer's proof is a 404", async () => {
      proofModel.findOne.mockReturnValue(lean(null));
      await expect(service.getOwnProofUrl('someone-else', 'proof-1')).rejects.toThrow(NotFoundException);
    });

    it('legacy proof with only a public URL keeps working (no signing)', async () => {
      proofModel.findOne.mockReturnValue(lean({ proofImageUrl: 'https://res.cloudinary.com/old/proof.jpg' }));
      const res = await service.getOwnProofUrl(USER_ID, 'proof-1');
      expect(res.url).toBe('https://res.cloudinary.com/old/proof.jpg');
      expect(uploadService.generateSignedUrl).not.toHaveBeenCalled();
    });

    it('admin: can view any proof; unknown id is a 404', async () => {
      proofModel.findById.mockReturnValue(lean({ proofPublicId: 'x', proofResourceType: 'image' }));
      expect((await service.adminGetProofUrl('proof-1')).url).toContain('signed.example.com');
      proofModel.findById.mockReturnValue(lean(null));
      await expect(service.adminGetProofUrl('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
