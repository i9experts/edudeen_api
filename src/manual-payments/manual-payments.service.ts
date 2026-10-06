/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';
import { PaymentService } from 'src/payment/payment.service';
import { FinanceService } from 'src/finance/finance.service';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { round } from 'src/common/number.util';
import type { ManualPaymentProof } from './schemas/manual-payment-proof.schema';
import { SubmitManualPaymentDto } from './dto/submit-manual-payment.dto';
import { ReuploadManualPaymentDto } from './dto/reupload-manual-payment.dto';

import { clampInt } from 'src/common/query-safety.util';
import { hasDirectPayment, type DirectPaymentDetails } from 'src/common/direct-payment.util';
/** Mirrors OrdersService's local `sellerPayoutBasis`/`sellerPayoutCurrency` —
 *  settlement must always be computed and labeled in the SELLER'S OWN
 *  currency (so.settlementCurrency), independent of `order.currency` (the
 *  buyer's paid currency, which for every manual-bank-transfer order is
 *  forced to 'PKR' regardless of the seller's actual store currency — see
 *  PaymentService.manualBankTransferPayment). Falls back to the old
 *  order-currency-denominated calculation only for orders placed before
 *  settlementAmount/settlementCurrency existed. */
function sellerPayoutBasis(so: any): number {
  if (so.settlementAmount != null) return so.settlementAmount;
  return round(so.subtotal + (so.platformSponsoredDiscountUSD ?? 0));
}

function sellerPayoutCurrency(so: any, order: any): string {
  return so.settlementCurrency ?? order.currency ?? 'USD';
}

type ProofLike = Partial<ManualPaymentProof> & { toObject?: () => Partial<ManualPaymentProof> };

const PROOF_FOLDER = 'private/payment-proofs';
const PROOF_URL_TTL_SECONDS = 10 * 60;

@Injectable()
export class ManualPaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly paymentService: PaymentService,
    private readonly financeService: FinanceService,
    private readonly adminConfigService: AdminConfigService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get proofModel() { return this.db.repositories.manualPaymentProofModel; }
  private get orderModel() { return this.db.repositories.orderModel; }

  /** Signed, short-lived view URL for a private proof; legacy proofs keep
   *  their stored public URL. Never persisted. */
  private proofViewUrl(proof: Partial<ManualPaymentProof> | null | undefined): string | null {
    if (proof?.proofPublicId) {
      return this.uploadService.generateSignedUrl(
        proof.proofPublicId, proof.proofResourceType ?? 'image', PROOF_URL_TTL_SECONDS, undefined, true,
      );
    }
    return proof?.proofImageUrl ?? null;
  }

  /** Response shape: `proofImageUrl` stays populated (signed for private
   *  proofs) so existing clients keep working; the storage ids are hidden. */
  private presentProof(proof: ProofLike): Partial<ManualPaymentProof> & Record<string, unknown> {
    const plain = typeof proof.toObject === 'function' ? proof.toObject() : proof;
    const rest: Partial<ManualPaymentProof> & Record<string, unknown> = { ...plain };
    delete rest.proofPublicId;
    delete rest.proofResourceType;
    return { ...rest, proofImageUrl: this.proofViewUrl(plain) };
  }

  /** Owner-only signed URL for viewing a proof. */
  async getOwnProofUrl(userId: string, proofId: string) {
    const proof = await this.proofModel.findOne({ _id: proofId, userId }).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return { url: this.proofViewUrl(proof), expiresInSeconds: proof.proofPublicId ? PROOF_URL_TTL_SECONDS : null };
  }

  /** Admin signed URL for viewing any proof. */
  async adminGetProofUrl(proofId: string) {
    const proof = await this.proofModel.findById(proofId).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return { url: this.proofViewUrl(proof), expiresInSeconds: proof.proofPublicId ? PROOF_URL_TTL_SECONDS : null };
  }

  /** The details a buyer pays into: the SELLER'S own account for this checkout's store. */
  async getBankDetails(userId: string, checkoutId: string) {
    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    const checkout = await this.db.repositories.checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false }).select('items.storeId').lean<{ items?: { storeId: string }[] }>();
    if (!checkout) throw new NotFoundException('Checkout not found');
    const store = await this.db.repositories.storeModel.findById(checkout.items?.[0]?.storeId).select('name directPayment').lean<{ name?: string; directPayment?: DirectPaymentDetails | null }>();
    const dp = store?.directPayment;
    if (!hasDirectPayment(dp)) {
      throw new BadRequestException('This seller has not set up bank transfer yet — please use another payment method.');
    }
    // The authoritative PKR amount is still locked in server-side at submission;
    // `usdToPkrRate` is only for the "approximately" hint shown before submitting.
    const config = await this.adminConfigService.getManualPaymentConfig().catch(() => null);
    return {
      payeeName: store?.name ?? null,
      bankName: dp?.bankName ?? null,
      accountTitle: dp?.accountTitle ?? null,
      accountNumber: dp?.accountNumber ?? null,
      iban: dp?.iban ?? null,
      jazzcashNumber: dp?.jazzcashNumber ?? null,
      easypaisaNumber: dp?.easypaisaNumber ?? null,
      instructions: dp?.instructions ?? null,
      usdToPkrRate: config?.usdToPkrRate ?? 0,
    };
  }
  /** Places the order(s) (unpaid, `pending_verification`) and attaches the buyer's uploaded proof in one step. */
  async submitPayment(userId: string, dto: SubmitManualPaymentDto, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');

    // Upload FIRST: if it fails, nothing has been placed. (Placing the orders
    // first left unpaid orders with no proof and no way for the buyer to retry.)
    const upload = await this.uploadService.uploadPrivateFile(file, PROOF_FOLDER);
    const { orders, amountUSD, amountPKR, fxRate } = await this.paymentService.manualBankTransferPayment(userId, dto.checkoutId);

    const proof = await this.proofModel.create({
      userId,
      checkoutId: dto.checkoutId,
      orderIds: orders.map((o: any) => o._id.toString()),
      storeId: orders[0]?.sellerOrders?.[0]?.storeId ?? null,
      amountUSD,
      amountPKR,
      fxRateUsed: fxRate,
      proofPublicId: upload.publicId,
      proofResourceType: upload.resourceType,
      transactionReference: dto.transactionReference ?? null,
      senderName: dto.senderName ?? null,
      status: 'pending',
    });

    this.notificationsService
      .notify({
        recipientId: userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.MANUAL_PAYMENT_SUBMITTED,
        title: 'Payment proof received',
        body: `We've received your transfer proof for PKR ${amountPKR.toFixed(2)} — we're verifying it now.`,
        data: { proofId: proof._id.toString(), orderIds: proof.orderIds },
      })
      .catch(() => {});

    this.notifySellerOfProof(proof).catch(() => {});

    return {
      proof: this.presentProof(proof),
      orders: orders.map((o: any) => ({ orderId: o._id, orderNumber: o.orderNumber, totalAmount: o.totalAmount, currency: o.currency })),
      message: "We're verifying your payment — you'll be notified once it's confirmed.",
    };
  }

  /** After a rejection, the buyer can try again with a fresh screenshot/reference without re-placing the order. */
  async reuploadPayment(userId: string, proofId: string, dto: ReuploadManualPaymentDto, file: Express.Multer.File | undefined) {
    const proof = await this.proofModel.findOne({ _id: proofId, userId });
    if (!proof) throw new NotFoundException('Payment proof not found');
    if (proof.status !== 'rejected') {
      throw new BadRequestException(`Cannot re-upload — this proof is currently "${proof.status}"`);
    }
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');

    const upload = await this.uploadService.uploadPrivateFile(file, PROOF_FOLDER);

    proof.proofPublicId = upload.publicId;
    proof.proofResourceType = upload.resourceType;
    proof.proofImageUrl = null; // supersedes any legacy public URL
    proof.transactionReference = dto.transactionReference ?? proof.transactionReference;
    proof.senderName = dto.senderName ?? proof.senderName;
    proof.status = 'pending';
    proof.rejectionReason = null;
    proof.reviewedByAdminId = null;
    proof.reviewedAt = null;
    proof.reuploadCount = (proof.reuploadCount ?? 0) + 1;
    await proof.save();

    return this.presentProof(proof);
  }

  async getProofStatus(userId: string, proofId: string) {
    const proof = await this.proofModel.findOne({ _id: proofId, userId }).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return this.presentProof(proof);
  }

  async getMyProofs(userId: string) {
    const proofs = await this.proofModel.find({ userId }).sort({ createdAt: -1 }).lean();
    return proofs.map((p: any) => this.presentProof(p));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Pending Manual Payments queue
  // ═══════════════════════════════════════════════════════════════════════

  async adminListQueue(query: any) {
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(100, clampInt(query.limit, 20, 1, 100));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (query.status) filter.status = query.status;

    const [proofs, total] = await Promise.all([
      this.proofModel.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
      this.proofModel.countDocuments(filter),
    ]);

    const userIds = [...new Set((proofs as any[]).map((p) => p.userId))];
    const users = await this.db.repositories.userModel.find({ _id: { $in: userIds } }).select('name email').lean();
    const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

    return {
      proofs: (proofs as any[]).map((p) => ({
        ...this.presentProof(p),
        buyerName: userMap.get(p.userId)?.name ?? 'Unknown buyer',
        buyerEmail: userMap.get(p.userId)?.email ?? '',
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    };
  }

  async adminGetById(proofId: string) {
    const proof = await this.proofModel.findById(proofId).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return this.presentProof(proof);
  }

  /** `scope.storeId` = the seller confirming a transfer into their own account (only their proofs match). */
  async adminApprove(proofId: string, adminId: string, ip?: string, userAgent?: string, scope?: { storeId: string }) {
    // Claim the proof atomically BEFORE any side effect: two admins clicking
    // approve together (or a retry) can't both run the crediting below.
    const now = new Date();
    const proof = await this.proofModel.findOneAndUpdate(
      { _id: proofId, status: 'pending', ...(scope ? { storeId: scope.storeId } : {}) },
      { $set: { status: 'approved', reviewedByAdminId: adminId, reviewedAt: now } },
      { returnDocument: 'after' },
    );
    if (!proof) {
      const existing = await this.proofModel.findById(proofId).select('status').lean();
      if (!existing) throw new NotFoundException('Payment proof not found');
      throw new BadRequestException(`Cannot approve a proof with status "${(existing as any).status}"`);
    }

    const releaseClaim = () =>
      this.proofModel.updateOne({ _id: proofId, status: 'approved' }, { $set: { status: 'pending', reviewedByAdminId: null, reviewedAt: null } });

    const orders = await this.orderModel.find({ _id: { $in: proof.orderIds }, isDelete: false });
    if (orders.length === 0) {
      await releaseClaim();
      throw new NotFoundException('No orders found for this payment proof');
    }
    // A buyer may have cancelled the order while the proof was pending — never
    // revive it, credit the seller, or hand over digital goods for it.
    const payable = (orders as any[]).filter((o) => o.orderStatus !== 'cancelled');
    if (payable.length === 0) {
      await releaseClaim();
      throw new BadRequestException('All orders for this payment proof have been cancelled');
    }

    const isLive = (x: any) => !['cancelled', 'refunded'].includes(x?.status);
    for (const order of payable) {
      const updateData: Record<string, any> = {
        isPaid: true,
        paymentStatus: 'paid',
        paidAt: now,
        orderStatus: 'completed',
      };
      order.sellerOrders.forEach((so: any, soIndex: number) => {
        if (!isLive(so)) return;
        updateData[`sellerOrders.${soIndex}.status`] = 'completed';
        updateData[`sellerOrders.${soIndex}.deliveredAt`] = now;
        so.items.forEach((item: any, itemIndex: number) => {
          if (isLive(item)) updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] = 'completed';
        });
      });
      // Guarded: if markPaid (or an earlier approval attempt) already paid this
      // order, leave it alone. recordSale is idempotent per order+store, so a
      // retry after a partial failure only fills in the sellers still missing.
      await this.orderModel.findOneAndUpdate(
        { _id: order._id, isPaid: { $ne: true }, orderStatus: { $ne: 'cancelled' } },
        { $set: updateData },
      );

      // Direct-to-seller transfers: the money is already in the seller's own account,
      // so nothing is credited to a platform balance (it would be paid out twice).
      if (proof.storeId) continue;
      for (const so of order.sellerOrders) {
        if (!isLive(so)) continue;
        const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
        const sponsoredCampaignId = so.items.find((i: any) => i.campaignSponsorType === 'platform')?.campaignId ?? null;
        try {
          await this.financeService.recordSale(
            so.storeId, so.sellerId, order._id.toString(), sellerPayoutBasis(so),
            `Sale — Order #${order._id} (manual bank transfer, verified)`,
            platformSponsoredUSD, sponsoredCampaignId, sellerPayoutCurrency(so, order),
            order.paymentType || 'manual_bank_transfer',
          );
        } catch (e: any) {
          console.error('Finance recordSale failed (manual payment approval):', e?.message);
        }
      }
    }

    this.activityLogService.log({
      storeId: proof.storeId ?? 'platform',
      category: 'finance',
      action: 'manual_payment_approved',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} approved for ${payable.length} order(s)`,
      actorId: adminId,
      actorRole: scope ? 'seller' : 'admin',
      targetId: proofId,
      targetType: 'manual_payment_proof',
      ip, userAgent,
    });

    this.notificationsService
      .notify({
        recipientId: proof.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.MANUAL_PAYMENT_APPROVED,
        title: 'Payment confirmed',
        body: 'Your bank transfer has been verified — your order is now confirmed.',
        data: { proofId, orderIds: proof.orderIds },
      })
      .catch(() => {});

    return this.presentProof(proof);
  }

  async adminReject(proofId: string, adminId: string, reason: string, ip?: string, userAgent?: string, scope?: { storeId: string }) {
    const proof = await this.proofModel.findOneAndUpdate(
      { _id: proofId, status: 'pending', ...(scope ? { storeId: scope.storeId } : {}) },
      { $set: { status: 'rejected', rejectionReason: reason, reviewedByAdminId: adminId, reviewedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!proof) {
      const existing = await this.proofModel.findById(proofId).select('status').lean();
      if (!existing) throw new NotFoundException('Payment proof not found');
      throw new BadRequestException(`Cannot reject a proof with status "${(existing as any).status}"`);
    }

    this.activityLogService.log({
      storeId: proof.storeId ?? 'platform',
      category: 'finance',
      action: 'manual_payment_rejected',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} rejected — ${reason}`,
      actorId: adminId,
      actorRole: scope ? 'seller' : 'admin',
      targetId: proofId,
      targetType: 'manual_payment_proof',
      ip, userAgent,
    });

    this.notificationsService
      .notify({
        recipientId: proof.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.MANUAL_PAYMENT_REJECTED,
        title: 'Payment could not be verified',
        body: `We couldn't verify your transfer: ${reason}. You can re-upload your proof or cancel the order.`,
        data: { proofId, orderIds: proof.orderIds, reason },
      })
      .catch(() => {});

    return this.presentProof(proof);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SELLER — receives the transfer directly, so the seller confirms it
  // ═══════════════════════════════════════════════════════════════════════

  private async ownStore(sellerId: string, storeId: string) {
    const store = await this.db.repositories.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('directPayment sellerId').lean<any>();
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  /** Tells the seller a transfer is waiting for them to confirm. */
  private async notifySellerOfProof(proof: any) {
    if (!proof.storeId) return;
    const store = await this.db.repositories.storeModel.findById(proof.storeId).select('sellerId').lean<{ sellerId?: string }>();
    if (!store?.sellerId) return;
    await this.notificationsService.notify({
      recipientId: String(store.sellerId),
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.MANUAL_PAYMENT_SUBMITTED,
      title: 'A buyer sent a bank transfer',
      body: `Check your account for PKR ${Number(proof.amountPKR).toFixed(2)}, then confirm the payment so the order can proceed.`,
      data: { proofId: String(proof._id), orderIds: proof.orderIds },
    });
  }

  async getStorePaymentSettings(sellerId: string, storeId: string) {
    const store = await this.ownStore(sellerId, storeId);
    return { directPayment: store.directPayment ?? null, enabled: hasDirectPayment(store.directPayment) };
  }

  async updateStorePaymentSettings(sellerId: string, storeId: string, dto: DirectPaymentDetails) {
    await this.ownStore(sellerId, storeId);
    const clean = (v?: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const details = {
      bankName: clean(dto.bankName), accountTitle: clean(dto.accountTitle), accountNumber: clean(dto.accountNumber),
      iban: clean(dto.iban), jazzcashNumber: clean(dto.jazzcashNumber), easypaisaNumber: clean(dto.easypaisaNumber),
      instructions: clean(dto.instructions),
    };
    const directPayment = hasDirectPayment(details) ? details : null;
    await this.db.repositories.storeModel.updateOne({ _id: storeId, sellerId }, { $set: { directPayment } });
    return { directPayment, enabled: !!directPayment };
  }

  async sellerListProofs(sellerId: string, storeId: string, query: any) {
    await this.ownStore(sellerId, storeId);
    const page = Math.max(1, clampInt(query.page, 1, 1, 100000));
    const limit = Math.min(50, clampInt(query.limit, 20, 1, 50));
    const filter: Record<string, any> = { storeId };
    if (query.status) filter.status = String(query.status);
    const [proofs, total] = await Promise.all([
      this.proofModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.proofModel.countDocuments(filter),
    ]);
    const users = await this.db.repositories.userModel.find({ _id: { $in: [...new Set((proofs as any[]).map((p) => p.userId))] } }).select('name email').lean();
    const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));
    return {
      proofs: (proofs as any[]).map((p) => ({ ...this.presentProof(p), buyerName: userMap.get(p.userId)?.name ?? 'Buyer', buyerEmail: userMap.get(p.userId)?.email ?? '' })),
      total, page, limit, pages: Math.ceil(total / limit),
    };
  }

  async sellerGetProofUrl(sellerId: string, storeId: string, proofId: string) {
    await this.ownStore(sellerId, storeId);
    const proof = await this.proofModel.findOne({ _id: proofId, storeId }).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return { url: this.proofViewUrl(proof), expiresInSeconds: proof.proofPublicId ? PROOF_URL_TTL_SECONDS : null };
  }

  async sellerApprove(sellerId: string, storeId: string, proofId: string, ip?: string, userAgent?: string) {
    await this.ownStore(sellerId, storeId);
    return this.adminApprove(proofId, sellerId, ip, userAgent, { storeId });
  }

  async sellerReject(sellerId: string, storeId: string, proofId: string, reason: string, ip?: string, userAgent?: string) {
    await this.ownStore(sellerId, storeId);
    return this.adminReject(proofId, sellerId, reason, ip, userAgent, { storeId });
  }
}