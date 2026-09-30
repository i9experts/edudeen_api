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
import { SubmitManualPaymentDto } from './dto/submit-manual-payment.dto';
import { ReuploadManualPaymentDto } from './dto/reupload-manual-payment.dto';

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
  private proofViewUrl(proof: any): string | null {
    if (proof?.proofPublicId) {
      return this.uploadService.generateSignedUrl(
        proof.proofPublicId, proof.proofResourceType ?? 'image', PROOF_URL_TTL_SECONDS, undefined, true,
      );
    }
    return proof?.proofImageUrl ?? null;
  }

  /** Response shape: `proofImageUrl` stays populated (signed for private
   *  proofs) so existing clients keep working; the storage ids are hidden. */
  private presentProof(proof: any) {
    const plain = typeof proof?.toObject === 'function' ? proof.toObject() : proof;
    const { proofPublicId, proofResourceType, ...rest } = plain;
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

  async getBankDetails() {
    const config = await this.adminConfigService.getManualPaymentConfig();
    if (!config?.enabled) {
      throw new BadRequestException('Bank transfer payment is not available right now.');
    }
    // `usdToPkrRate` is included so the app can show "you'll transfer approximately
    // PKR X" before the buyer commits — the authoritative amount is computed
    // (and locked in) server-side at submission time in `submitPayment`.
    return {
      bankName: config.bankName,
      accountTitle: config.accountTitle,
      accountNumber: config.accountNumber,
      iban: config.iban,
      jazzcashNumber: config.jazzcashNumber,
      easypaisaNumber: config.easypaisaNumber,
      instructions: config.instructions,
      usdToPkrRate: config.usdToPkrRate,
    };
  }

  /** Places the order(s) (unpaid, `pending_verification`) and attaches the buyer's uploaded proof in one step. */
  async submitPayment(userId: string, dto: SubmitManualPaymentDto, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');

    const { orders, amountUSD, amountPKR, fxRate } = await this.paymentService.manualBankTransferPayment(userId, dto.checkoutId);
    const upload = await this.uploadService.uploadPrivateFile(file, PROOF_FOLDER);

    const proof = await this.proofModel.create({
      userId,
      checkoutId: dto.checkoutId,
      orderIds: orders.map((o: any) => o._id.toString()),
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
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
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

  async adminApprove(proofId: string, adminId: string, ip?: string, userAgent?: string) {
    const proof = await this.proofModel.findById(proofId);
    if (!proof) throw new NotFoundException('Payment proof not found');
    if (proof.status !== 'pending') {
      throw new BadRequestException(`Cannot approve a proof with status "${proof.status}"`);
    }

    const orders = await this.orderModel.find({ _id: { $in: proof.orderIds }, isDelete: false });
    if (orders.length === 0) throw new NotFoundException('No orders found for this payment proof');

    const now = new Date();
    for (const order of orders as any[]) {
      const updateData: Record<string, any> = {
        isPaid: true,
        paymentStatus: 'paid',
        paidAt: now,
        orderStatus: 'completed',
      };
      order.sellerOrders.forEach((so: any, soIndex: number) => {
        updateData[`sellerOrders.${soIndex}.status`] = 'completed';
        updateData[`sellerOrders.${soIndex}.deliveredAt`] = now;
        so.items.forEach((_: any, itemIndex: number) => {
          updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] = 'completed';
        });
      });
      await this.orderModel.findByIdAndUpdate(order._id, { $set: updateData });

      for (const so of order.sellerOrders) {
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

    proof.status = 'approved';
    proof.reviewedByAdminId = adminId;
    proof.reviewedAt = now;
    await proof.save();

    this.activityLogService.log({
      storeId: 'platform',
      category: 'finance',
      action: 'manual_payment_approved',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} approved for ${orders.length} order(s)`,
      actorId: adminId,
      actorRole: 'admin',
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

  async adminReject(proofId: string, adminId: string, reason: string, ip?: string, userAgent?: string) {
    const proof = await this.proofModel.findById(proofId);
    if (!proof) throw new NotFoundException('Payment proof not found');
    if (proof.status !== 'pending') {
      throw new BadRequestException(`Cannot reject a proof with status "${proof.status}"`);
    }

    proof.status = 'rejected';
    proof.rejectionReason = reason;
    proof.reviewedByAdminId = adminId;
    proof.reviewedAt = new Date();
    await proof.save();

    this.activityLogService.log({
      storeId: 'platform',
      category: 'finance',
      action: 'manual_payment_rejected',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} rejected — ${reason}`,
      actorId: adminId,
      actorRole: 'admin',
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
}
