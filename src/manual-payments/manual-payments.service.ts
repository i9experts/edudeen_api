/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';
import { PaymentService } from 'src/payment/payment.service';
import { FinanceService, shippingCreditFor, feeItemsFor } from 'src/finance/finance.service';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { round } from 'src/common/number.util';
import type { ManualPaymentProof } from './schemas/manual-payment-proof.schema';
import { SubmitManualPaymentDto } from './dto/submit-manual-payment.dto';
import { ReuploadManualPaymentDto } from './dto/reupload-manual-payment.dto';

import { clampInt } from 'src/common/query-safety.util';
import { assertProofFile } from 'src/common/proof-file.util';
import { ReceiptCheckService, buildReceiptExpectation } from './receipt-check.service';
import { DuplicateHit, findDuplicates, proofFileHash, referenceKey } from './duplicate-proof.util';
import { GoneException } from '@nestjs/common';
import type { DirectPaymentDetails } from 'src/common/direct-payment.util';
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
/** A rejected proof that is not fixed within this many days has its unpaid orders cancelled and the stock returned. */
export const REJECTED_PROOF_HOLD_DAYS = 7;

@Injectable()
export class ManualPaymentsService {
  private readonly logger = new Logger(ManualPaymentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly paymentService: PaymentService,
    private readonly financeService: FinanceService,
    private readonly adminConfigService: AdminConfigService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
    private readonly receiptCheckService?: ReceiptCheckService,
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

  /** The details a buyer pays into: the PLATFORM's own bank / wallet account (admin-managed). */
  async getBankDetails(userId: string, checkoutId: string) {
    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    const checkout = await this.db.repositories.checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false }).select('items.storeId').lean<{ items?: { storeId: string }[] }>();
    if (!checkout) throw new NotFoundException('Checkout not found');
    const dp = await this.adminConfigService.getPlatformTransferDetails();
    if (!dp) {
      throw new BadRequestException('Bank transfer is not available right now — please use another payment method.');
    }
    // The authoritative PKR amount is still locked in server-side at submission;
    // `usdToPkrRate` is only for the "approximately" hint shown before submitting.
    return {
      payeeName: dp.accountTitle ?? 'Edudeen',
      bankName: dp.bankName ?? null,
      accountTitle: dp.accountTitle ?? null,
      accountNumber: dp.accountNumber ?? null,
      iban: dp.iban ?? null,
      jazzcashNumber: dp.jazzcashNumber ?? null,
      easypaisaNumber: dp.easypaisaNumber ?? null,
      instructions: dp.instructions ?? null,
      usdToPkrRate: dp.usdToPkrRate ?? 0,
    };
  }
  /** Places the order(s) (unpaid, `pending_verification`) and attaches the buyer's uploaded proof in one step. */
  async submitPayment(userId: string, dto: SubmitManualPaymentDto, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');

    // Upload FIRST: if it fails, nothing has been placed. (Placing the orders
    // first left unpaid orders with no proof and no way for the buyer to retry.)
    assertProofFile(file);
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
      transactionReferenceKey: referenceKey(dto.transactionReference),
      proofHash: proofFileHash(file.buffer),
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

    // Advisory: read the screenshot in the background so the admin sees a match/mismatch hint.
    if (this.receiptCheckService) {
      const receiptSvc = this.receiptCheckService;
      this.adminConfigService.getPlatformTransferDetails()
        .then((d) => receiptSvc.check(file.buffer, file.mimetype, amountPKR, buildReceiptExpectation(d as DirectPaymentDetails | null, dto.transactionReference)))
        .then((rc) => this.proofModel.updateOne({ _id: proof._id }, { $set: { receiptCheck: rc } }))
        .catch(() => {});
    }

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
    if (proof.ordersReleasedAt) {
      throw new BadRequestException('These orders were cancelled because the payment was not confirmed in time. Please place a new order.');
    }
    // The buyer may have cancelled the orders meanwhile: nothing left to pay for.
    const openOrders = await this.orderModel.countDocuments({ _id: { $in: proof.orderIds }, isDelete: false, orderStatus: { $ne: 'cancelled' } });
    if (openOrders === 0) throw new BadRequestException('The orders for this payment were cancelled. Please place a new order.');

    assertProofFile(file);
    const upload = await this.uploadService.uploadPrivateFile(file, PROOF_FOLDER);

    // Atomic: two quick re-uploads (or a re-upload racing the stale sweep) cannot both win.
    const updated = await this.proofModel.findOneAndUpdate(
      { _id: proofId, userId, status: 'rejected', ordersReleasedAt: null },
      {
        $set: {
          proofPublicId: upload.publicId,
          proofResourceType: upload.resourceType,
          proofImageUrl: null, // supersedes any legacy public URL
          transactionReference: dto.transactionReference ?? proof.transactionReference,
          transactionReferenceKey: referenceKey(dto.transactionReference ?? proof.transactionReference),
          proofHash: proofFileHash(file.buffer),
          senderName: dto.senderName ?? proof.senderName,
          status: 'pending',
          rejectionReason: null,
          reviewedByAdminId: null,
          reviewedAt: null,
        },
        $inc: { reuploadCount: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw new BadRequestException('This payment proof is no longer open for re-upload. Please refresh.');

    return this.presentProof(updated);
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

    const dupes = await this.duplicateFlags(proofs as any[]);
    return {
      proofs: (proofs as any[]).map((p) => ({
        ...this.presentProof(p),
        buyerName: userMap.get(p.userId)?.name ?? 'Unknown buyer',
        buyerEmail: userMap.get(p.userId)?.email ?? '',
        possibleDuplicates: dupes.get(String(p._id)) ?? [],
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    };
  }

  /** Advisory duplicate signals for a page of proofs (same image bytes or same reference in ANOTHER checkout). One query. */
  private async duplicateFlags(page: any[]) {
    const hashes = [...new Set(page.map((p) => p.proofHash).filter(Boolean))];
    const keys = [...new Set(page.map((p) => p.transactionReferenceKey).filter(Boolean))];
    if (!hashes.length && !keys.length) return new Map<string, DuplicateHit[]>();
    const candidates = await this.proofModel
      .find({ $or: [...(hashes.length ? [{ proofHash: { $in: hashes } }] : []), ...(keys.length ? [{ transactionReferenceKey: { $in: keys } }] : [])] })
      .select('checkoutId status proofHash transactionReferenceKey').limit(500).lean();
    return findDuplicates(page, candidates as any[]);
  }

  async adminGetById(proofId: string) {
    const proof = await this.proofModel.findById(proofId).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    const dupes = await this.duplicateFlags([proof]);
    return { ...this.presentProof(proof), possibleDuplicates: dupes.get(String(proof._id)) ?? [] };
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
    let creditStatus: 'credited' | 'pending' = 'credited';
    try {
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

      // The transfer landed in the PLATFORM account, so each seller's wallet is credited the
      // sale minus the platform fee (pending until clearing, like card). Idempotent per order+store.
      for (const so of order.sellerOrders) {
        if (!isLive(so)) continue;
        const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
        const sponsoredCampaignId = so.items.find((i: any) => i.campaignSponsorType === 'platform')?.campaignId ?? null;
        // Durable outbox: approval still succeeds if the credit fails; a pending job is retried + admins alerted.
        const credit = await this.financeService.recordSaleDurable({
          storeId: so.storeId, sellerId: so.sellerId, orderId: order._id.toString(), saleAmount: sellerPayoutBasis(so),
          description: `Sale — Order #${order._id} (manual bank transfer, verified)`,
          platformSponsoredUSD, campaignId: sponsoredCampaignId, currency: sellerPayoutCurrency(so, order),
          paymentMethodType: order.paymentType || 'manual_bank_transfer',
          fulfillmentMode: so.fulfillmentMode, shippingCredit: shippingCreditFor(order, so), feeItems: feeItemsFor(so),
          fxSnapshots: (order.fxSnapshots as any) ?? [],
        });
        if (credit?.creditStatus === 'pending') creditStatus = 'pending';
      }
    }
    } catch (err: any) {
      // Every step above is guarded/idempotent (paid-order update, per order+store credit), so
      // putting the proof back in the queue lets the admin simply retry without double-crediting.
      await releaseClaim().catch(() => {});
      this.logger.error(`Manual payment approval ${proofId} failed midway: ${err?.message}`);
      throw new BadRequestException('Could not finish approving this payment. It is back in the queue - please retry.');
    }

    this.activityLogService.log({
      storeId: proof.storeId ?? 'platform',
      category: 'finance',
      action: 'manual_payment_approved',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} approved for ${payable.length} order(s)`,
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
        data: { proofId, orderIds: proof.orderIds, link: proof.orderIds?.length === 1 ? `/account/orders/${proof.orderIds[0]}` : '/account/orders' },
      })
      .catch(() => {});

    return { ...(await this.presentProof(proof)), creditStatus };
  }

  /**
   * Stock for a bank-transfer order is taken when it is placed. A proof that was
   * rejected and never fixed would hold that stock forever, so after
   * REJECTED_PROOF_HOLD_DAYS the still-unpaid orders are cancelled and restocked.
   * Every write is guarded, so a second instance or a retry changes nothing twice.
   */
  @Cron('25 * * * *')
  async releaseStaleRejectedProofs(now = new Date()): Promise<{ proofs: number; orders: number }> {
    const cutoff = new Date(now.getTime() - REJECTED_PROOF_HOLD_DAYS * 24 * 60 * 60 * 1000);
    let proofsDone = 0;
    let ordersDone = 0;
    try {
      const stale: any[] = await this.proofModel
        .find({ status: 'rejected', reviewedAt: { $lte: cutoff }, ordersReleasedAt: null })
        .sort({ reviewedAt: 1 }).limit(100).lean();
      for (const proof of stale) {
        // Claim the proof first so a buyer re-upload (which needs ordersReleasedAt null) and this sweep exclude each other.
        const claimed = await this.proofModel.findOneAndUpdate(
          { _id: proof._id, status: 'rejected', ordersReleasedAt: null },
          { $set: { ordersReleasedAt: now } },
        );
        if (!claimed) continue;
        proofsDone++;
        for (const orderId of proof.orderIds ?? []) {
          try {
            if (await this.cancelUnpaidOrder(orderId, 'Payment proof was not confirmed in time', now)) ordersDone++;
          } catch (err: any) {
            this.logger.error(`Could not release order ${orderId} of proof ${proof._id}: ${err?.message}`);
          }
        }
        this.activityLogService.log({
          storeId: proof.storeId ?? 'platform', category: 'finance', action: 'manual_payment_orders_released',
          description: `Rejected bank-transfer proof not fixed in ${REJECTED_PROOF_HOLD_DAYS} days - unpaid order(s) cancelled and stock returned`,
          actorRole: 'system', targetId: String(proof._id), targetType: 'manual_payment_proof',
        });
        this.notificationsService.notify({
          recipientId: proof.userId, recipientRole: 'user', type: NOTIFICATION_TYPES.MANUAL_PAYMENT_REJECTED,
          title: 'Order cancelled', body: 'We could not confirm your bank transfer in time, so the unpaid order was cancelled. You can place a new order any time.',
          data: { proofId: String(proof._id), orderIds: proof.orderIds, link: '/account/orders' },
        }).catch(() => {});
      }
    } catch (err: any) {
      this.logger.error(`Stale rejected proof sweep failed: ${err?.message}`);
    }
    return { proofs: proofsDone, orders: ordersDone };
  }

  /** Cancels one still-unpaid order and puts physical stock back. Returns false when it was not eligible (paid / already cancelled). */
  private async cancelUnpaidOrder(orderId: string, reason: string, now: Date): Promise<boolean> {
    const order: any = await this.orderModel.findOne({ _id: orderId, isDelete: false, isPaid: { $ne: true }, orderStatus: { $ne: 'cancelled' } });
    if (!order) return false;
    const set: Record<string, any> = { orderStatus: 'cancelled' };
    const toRestock: { variantId: string; quantity: number }[] = [];
    order.sellerOrders.forEach((so: any, si: number) => {
      if (so.status !== 'cancelled') { set[`sellerOrders.${si}.status`] = 'cancelled'; set[`sellerOrders.${si}.cancelledAt`] = now; set[`sellerOrders.${si}.cancelReason`] = reason; }
      so.items.forEach((item: any, ii: number) => {
        if (item.status === 'cancelled') return;
        set[`sellerOrders.${si}.items.${ii}.status`] = 'cancelled';
        set[`sellerOrders.${si}.items.${ii}.cancelledAt`] = now;
        set[`sellerOrders.${si}.items.${ii}.cancelReason`] = reason;
        if (item.type === 'physical' && item.variantId) toRestock.push({ variantId: item.variantId, quantity: item.quantity });
      });
    });
    // The claim: only the caller that flips the still-unpaid order restocks it.
    const won = await this.orderModel.findOneAndUpdate(
      { _id: orderId, isPaid: { $ne: true }, orderStatus: { $ne: 'cancelled' } },
      { $set: set },
    );
    if (!won) return false;
    for (const r of toRestock) {
      await this.db.repositories.productVariantModel.updateOne({ _id: r.variantId, unlimitedStock: { $ne: true } }, { $inc: { stock: r.quantity } });
    }
    for (const so of order.sellerOrders) {
      const live = so.items.filter((i: any) => i.status !== 'cancelled');
      if (live.length) await this.paymentService.restoreGiftCardForItems(order, so, live, `unpaid-release-${orderId}`);
    }
    return true;
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
        body: `We couldn't verify your transfer: ${reason}. You can re-upload your proof or cancel the order. If it is not fixed within ${REJECTED_PROOF_HOLD_DAYS} days the unpaid order is cancelled automatically.`,
        data: { proofId, orderIds: proof.orderIds, reason, link: proof.orderIds?.length === 1 ? `/account/orders/${proof.orderIds[0]}` : '/account/orders' },
      })
      .catch(() => {});

    return this.presentProof(proof);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SELLER — retired. Bank transfers are paid into the PLATFORM account and
  // confirmed by an admin (who credits the seller's wallet), so the seller-side
  // direct-bank setup and confirmation endpoints now answer 410 Gone.
  // Stored Store.directPayment data is left untouched in the DB.
  // ═══════════════════════════════════════════════════════════════════════

  private gone(): never {
    throw new GoneException('Bank transfers are now paid to Edudeen and confirmed by the Edudeen team — sellers no longer set up or confirm direct payments.');
  }

  async getStorePaymentSettings(_sellerId: string, _storeId: string) { return this.gone(); }
  async updateStorePaymentSettings(_sellerId: string, _storeId: string, _dto: DirectPaymentDetails) { return this.gone(); }
  async sellerListProofs(_sellerId: string, _storeId: string, _query: any) { return this.gone(); }
  async sellerGetProofUrl(_sellerId: string, _storeId: string, _proofId: string) { return this.gone(); }
  async sellerApprove(_sellerId: string, _storeId: string, _proofId: string, _ip?: string, _userAgent?: string) { return this.gone(); }
  async sellerReject(_sellerId: string, _storeId: string, _proofId: string, _reason: string, _ip?: string, _userAgent?: string) { return this.gone(); }
}
