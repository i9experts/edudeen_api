import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { DatabaseService } from 'src/database/databaseservice';
import { FinanceService } from 'src/finance/finance.service';
import { PaymentService } from 'src/payment/payment.service';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { isPackagePaid } from 'src/orders/package-paid.util';
import { RedisService } from 'src/redis/redis.service';
import { isValidObjectId } from 'mongoose';
import { escapeRegex } from 'src/common/query-safety.util';
import { CreateRefundRequestDto, AdminRefundQueryDto } from './dto/refund-request.dto';
import { cleanRefundEvidence, REFUND_REASON_CODES } from './refund-evidence.util';
import { cleanFollowUpNote, cleanRejectReason, requiredPreviousFollowUp, trailEntry } from './return-trail.util';

@Injectable()
export class RefundRequestService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly financeService: FinanceService,
    private readonly paymentService: PaymentService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly activityLogService: ActivityLogService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /** Best-effort notice; a notification problem must never fail the refund flow. */
  private tell(recipientId: string | null | undefined, recipientRole: 'user' | 'seller', type: string, title: string, body: string, data: Record<string, any>) {
    if (!recipientId || !this.notificationsService) return;
    this.notificationsService
      .notify({ recipientId: String(recipientId), recipientRole, type, title, body, data })
      .catch(() => {});
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  private get model() {
    return this.databaseService.repositories.refundRequestModel;
  }

  private async loadOrderAndSellerOrder(orderId: string, sellerOrderId: string) {
    const order = await this.databaseService.repositories.orderModel.findOne({
      _id: orderId,
      isDelete: false,
    });
    if (!order) throw new NotFoundException('Order not found');
    const sellerOrder = (order.sellerOrders as any[]).find(
      (so) => so._id.toString() === sellerOrderId,
    );
    if (!sellerOrder) throw new NotFoundException('Seller order not found on this order');
    return { order, sellerOrder };
  }

  /** Buyer or seller requests a refund for specific item(s) within ONE
   *  sellerOrder of ONE order — never a proportional share of the whole
   *  order, so a multi-seller cart's refund can never spill onto a
   *  different seller's wallet. Ownership-checked against the caller. */
  async createRequest(userId: string, role: 'user' | 'seller' | 'admin', dto: CreateRefundRequestDto) {
    const { order, sellerOrder } = await this.loadOrderAndSellerOrder(dto.orderId, dto.sellerOrderId);

    if (role === 'user' && order.userId !== userId) {
      throw new ForbiddenException('This order does not belong to you');
    }
    if (role === 'seller' && sellerOrder.sellerId !== userId) {
      throw new ForbiddenException('This seller order does not belong to you');
    }

    const items = (sellerOrder.items as any[]).filter((i) => dto.itemIds.includes(i._id.toString()));
    if (items.length !== dto.itemIds.length) {
      throw new BadRequestException('One or more itemIds were not found on this seller order');
    }
    const alreadyRefunded = items.filter((i) => i.status === 'refunded');
    if (alreadyRefunded.length > 0) {
      throw new BadRequestException('One or more of these items have already been refunded');
    }

    // Parity with the older orders.service.ts#returnRequest guards — a
    // refund can't be requested for an undelivered order, a digital item
    // (non-returnable by nature), or an already-cancelled item.
    for (const item of items) {
      if (item.status === 'cancelled') {
        throw new BadRequestException(`Cancelled item "${item.name}" cannot be refunded`);
      }
      if (item.type === 'digital') {
        // Digital goods: delivered at payment, so there is no "delivered"
        // gate. A buyer may request a refund only if they never downloaded
        // the file (downloads are always counted — see
        // OrdersService.consumeDownload); a seller or admin can refund at
        // any time, e.g. for a broken or misdescribed resource. Approval
        // marks the item 'refunded', which revokes download access.
        if (!isPackagePaid(order, sellerOrder)) {
          throw new BadRequestException(`"${item.name}" has not been paid for`);
        }
        if (role === 'user' && (item.downloadCount ?? 0) > 0) {
          throw new BadRequestException(
            `"${item.name}" has already been downloaded — please contact the seller or support for help`,
          );
        }
        continue;
      }
      if (!['delivered', 'completed'].includes(sellerOrder.status)) {
        throw new BadRequestException(`"${item.name}" is not yet delivered`);
      }
    }

    const evidence = cleanRefundEvidence(dto, items.map((i) => String(i.type)));
    const reason = (dto.reason ?? (evidence.reasonCode ? REFUND_REASON_CODES[evidence.reasonCode] : '')).trim();
    if (reason.length < 3) throw new BadRequestException('Please choose a reason');

    // One open request per order item. Check + create run under a per-seller-order
    // lock so two parallel submits cannot both pass the check. (No Redis = the
    // plain check below, as before.)
    const createIfNoneOpen = async () => {
      const existingPending = await this.model.findOne({
        sellerOrderId: dto.sellerOrderId,
        itemIds: { $in: dto.itemIds },
        status: 'pending',
        isDelete: false,
      });
      if (existingPending) {
        throw new BadRequestException('A refund request for one of these items is already pending review');
      }
      return this.model.create({
        orderId: dto.orderId,
        sellerOrderId: dto.sellerOrderId,
        storeId: sellerOrder.storeId,
        itemIds: dto.itemIds,
        requestedBy: userId,
        requestedByRole: role,
        reason,
        ...(evidence.reasonCode ? { reasonCode: evidence.reasonCode, note: evidence.note, evidenceImages: evidence.evidenceImages } : {}),
        status: 'pending',
        history: [trailEntry('requested', userId, role)],
      });
    };
    let created: any;
    if (this.redis?.isConnected) {
      let failure: unknown = null;
      const outcome = await this.redis.withLock(`refund-claim:${dto.sellerOrderId}`, 15000, async () => {
        try { created = await createIfNoneOpen(); } catch (e) { failure = e; }
      });
      if (outcome === 'lock_not_acquired') {
        throw new BadRequestException('A refund request for one of these items is already being submitted');
      }
      if (failure) throw failure;
    } else {
      created = await createIfNoneOpen();
    }

    await this.activityLogService.log({
      storeId: sellerOrder.storeId,
      category: 'orders',
      action: 'refund_requested',
      description: `Refund requested for ${items.length} item(s) on order #${order.orderNumber} — ${reason}`,
      actorId: userId,
      actorRole: role,
      targetId: created._id.toString(),
      targetType: 'refund_request',
    });

    // A buyer's request goes to the seller who has to decide it.
    if (role === 'user') {
      const store: any = await this.databaseService.repositories.storeModel
        .findById(sellerOrder.storeId).select('sellerId').lean();
      this.tell(
        store?.sellerId ?? sellerOrder.sellerId, 'seller', NOTIFICATION_TYPES.REFUND_REQUESTED,
        'New refund request',
        `A buyer asked for a refund on ${items.length} item(s) of order #${order.orderNumber} - ${reason.slice(0, 200)}`,
        { orderId: dto.orderId, orderNumber: String(order.orderNumber ?? ''), storeId: sellerOrder.storeId, link: `/store/${sellerOrder.storeId}/returns` },
      );
    }

    return { success: true, message: 'Refund request submitted', data: created };
  }

  /** Buyer sees their own order's requests; a seller sees only the requests
   *  against their own sub-orders of it; an admin sees all. */
  async listForOrder(userId: string, role: 'user' | 'seller' | 'admin', orderId: string) {
    const order = await this.databaseService.repositories.orderModel
      .findOne({ _id: orderId, isDelete: false })
      .select('userId sellerOrders.sellerId sellerOrders.storeId')
      .lean();
    if (!order) throw new NotFoundException('Order not found');

    const filter: Record<string, unknown> = { orderId, isDelete: false };
    if (role === 'user') {
      if ((order as any).userId !== userId) throw new ForbiddenException('This order does not belong to you');
    } else if (role === 'seller') {
      const storeIds = ((order as any).sellerOrders as any[])
        .filter((so) => so.sellerId === userId)
        .map((so) => so.storeId);
      if (storeIds.length === 0) throw new ForbiddenException('This order does not belong to your store');
      filter.storeId = { $in: storeIds };
    }

    const items = await this.model.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: items };
  }

  /**
   * Full admin view: every status (not just pending), filterable by store,
   * date range, and a free-text search across order number/id or the
   * requester's name/email — enriched with the order number, store name and
   * requester's name/email so the admin UI isn't resolving each row itself.
   * A pending-only view keeps the existing oldest-first order (what needs
   * action soonest); any other view reads newest-first, like the Orders console.
   */
  async listForAdmin(filters: AdminRefundQueryDto) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const { orderModel, userModel, storeModel } = this.databaseService.repositories;

    const match: Record<string, unknown> = { isDelete: false };
    if (filters.status) match.status = filters.status;
    if (filters.storeId) match.storeId = filters.storeId;
    if (filters.from || filters.to) {
      const createdAt: Record<string, Date> = {};
      if (filters.from) createdAt.$gte = new Date(filters.from);
      if (filters.to) { const end = new Date(filters.to); end.setHours(23, 59, 59, 999); createdAt.$lte = end; }
      match.createdAt = createdAt;
    }

    const q = filters.q?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const [matchingOrders, matchingUsers] = await Promise.all([
        orderModel.find({ $or: [{ orderNumber: rx }, ...(isValidObjectId(q) ? [{ _id: q }] : [])] }).select('_id').limit(200).lean(),
        userModel.find({ $or: [{ email: rx }, { name: rx }] }).select('_id').limit(200).lean(),
      ]);
      const orderIds = matchingOrders.map((o: any) => String(o._id));
      const userIds = matchingUsers.map((u: any) => String(u._id));
      const or: Record<string, unknown>[] = [
        ...(orderIds.length ? [{ orderId: { $in: orderIds } }] : []),
        ...(userIds.length ? [{ requestedBy: { $in: userIds } }] : []),
        ...(isValidObjectId(q) ? [{ _id: q }] : []),
      ];
      if (or.length === 0) return { success: true, data: { items: [], total: 0, page, limit } };
      match.$or = or;
    }

    const sort: Record<string, 1 | -1> = filters.status === 'pending' ? { createdAt: 1 } : { createdAt: -1 };

    const [items, total] = await Promise.all([
      this.model.find(match).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(match),
    ]);

    const orderIds = [...new Set(items.map((i: any) => i.orderId))];
    const storeIds = [...new Set(items.map((i: any) => i.storeId))];
    const requesterIds = [...new Set(items.map((i: any) => i.requestedBy))];
    const [orders, stores, requesters] = await Promise.all([
      orderModel.find({ _id: { $in: orderIds } }).select('orderNumber').lean(),
      storeModel.find({ _id: { $in: storeIds } }).select('name').lean(),
      userModel.find({ _id: { $in: requesterIds } }).select('name email').lean(),
    ]);
    const orderById = new Map(orders.map((o: any) => [String(o._id), o]));
    const storeById = new Map(stores.map((s: any) => [String(s._id), s]));
    const requesterById = new Map(requesters.map((u: any) => [String(u._id), u]));

    const enriched = items.map((i: any) => ({
      ...i,
      orderNumber: orderById.get(i.orderId)?.orderNumber ?? null,
      storeName: storeById.get(i.storeId)?.name ?? null,
      requester: requesterById.has(i.requestedBy)
        ? { name: requesterById.get(i.requestedBy).name, email: requesterById.get(i.requestedBy).email }
        : null,
    }));

    return { success: true, data: { items: enriched, total, page, limit } };
  }

  /** Refund requests targeting one of the seller's own stores — ownership
   *  verified the same way as the rest of the seller-facing API surface. */
  async listForSeller(sellerId: string, storeId: string, page = 1, limit = 20) {
    await verifyStoreOwnershipOrForbidden(
      this.databaseService.repositories.storeModel, storeId, sellerId,
    );
    const [items, total] = await Promise.all([
      this.model.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments({ storeId, isDelete: false }),
    ]);
    return { success: true, data: { items, total, page, limit } };
  }

  /** Sellers may only approve/reject a refund request against their own
   *  store; admins may act on any. */
  private async assertCanReview(actorRole: 'seller' | 'admin', actorId: string, request: { storeId: string }) {
    if (actorRole === 'seller') {
      await verifyStoreOwnershipOrForbidden(
        this.databaseService.repositories.storeModel, request.storeId, actorId,
      );
    }
  }

  /**
   * Approves a pending refund request — computes the buyer-facing amount
   * from the order's own stored item totals (never today's live prices),
   * converts it into the seller's own settlement currency using the
   * order's own frozen fxSnapshots (never a fresh rate), debits ONLY that
   * one seller's wallet via FinanceService.recordRefund, and — for a
   * Stripe-paid order — issues a real, targeted Stripe refund for exactly
   * that buyer-facing amount. Atomic pending→approved transition guards
   * against a double-approval double-refunding everything.
   */
  async approve(actorId: string, actorRole: 'seller' | 'admin', requestId: string) {
    const existing = await this.model.findOne({ _id: requestId, isDelete: false }).lean();
    if (!existing) throw new NotFoundException('Refund request not found');
    await this.assertCanReview(actorRole, actorId, existing as any);

    const request = await this.model.findOneAndUpdate(
      { _id: requestId, status: 'pending', isDelete: false },
      { status: 'approved', reviewedBy: actorId, reviewedAt: new Date() },
      { returnDocument: 'after' },
    );
    if (!request) {
      throw new BadRequestException('Refund request not found or already reviewed');
    }

    // Everything up to and including the ledger debit is retryable: if any of
    // it fails, put the request back to 'pending' instead of stranding it
    // 'approved' with nothing refunded (it could then never be re-reviewed).
    const revertClaim = () =>
      this.model.updateOne(
        { _id: requestId, status: 'approved' },
        { $set: { status: 'pending', reviewedBy: null, reviewedAt: null } },
      );

    let order: any;
    let sellerOrder: any;
    let items: any[];
    let buyerRefundAmount: number;
    let settlementCurrency: string;
    let buyerRefundCurrency: string;
    let sellerDebitAmount: number;
    try {
      order = await this.databaseService.repositories.orderModel.findOne({
        _id: request.orderId, isDelete: false,
      });
      if (!order) throw new NotFoundException('Order not found');
      sellerOrder = (order.sellerOrders as any[]).find(
        (so: any) => so._id.toString() === request.sellerOrderId,
      );
      if (!sellerOrder) throw new NotFoundException('Seller order not found on this order');

      // Never refund (or debit a seller for) money that was never collected — e.g.
      // an unpaid COD order a seller marked delivered.
      if (!isPackagePaid(order, sellerOrder)) throw new BadRequestException('This order has not been paid — there is nothing to refund');

      items = (sellerOrder.items as any[]).filter((i: any) => request.itemIds.includes(i._id.toString()));
      // State may have changed since the request was filed.
      const unrefundable = items.filter((i: any) => ['refunded', 'cancelled'].includes(i.status) || i.returnStatus === 'approved');
      if (unrefundable.length > 0) {
        throw new BadRequestException('One or more items were already refunded or cancelled');
      }

      // Capped by what is still refundable per item (totalPrice minus anything already refunded).
      buyerRefundAmount = this.round(items.reduce((sum: number, i: any) => sum + Math.max(0, i.totalPrice - (i.refundedAmount ?? 0)), 0));
      // A free order has no money to return, but its items can still be refunded to revoke access.
      if (!(buyerRefundAmount > 0) && order.paymentType !== 'free') throw new BadRequestException('Nothing left to refund on these items');

      buyerRefundCurrency = order.currency || 'USD';
      settlementCurrency = sellerOrder.settlementCurrency ?? buyerRefundCurrency;
      sellerDebitAmount = this.exchangeRateService.convertWithSnapshots(
        buyerRefundAmount,
        buyerRefundCurrency,
        settlementCurrency,
        (order.fxSnapshots as any) ?? [],
      );

      // Debit ONLY this seller's wallet — never the other sellerOrders on
      // this same order, and never proportional across them. Seller-collected
      // COD settled by a commission debit is the exception: the seller returns
      // the cash by hand and the commission is credited back in proportion
      // (see FinanceService.recordRefundForSellerOrder).
      if (order.paymentType !== 'free') await this.financeService.recordRefundForSellerOrder({
        order, sellerOrder,
        storeId: sellerOrder.storeId, sellerId: sellerOrder.sellerId, orderId: order._id.toString(),
        refundedBuyerAmount: buyerRefundAmount,
        sellerOrderTotal: this.round((sellerOrder.items as any[]).reduce((sum: number, i: any) => sum + (i.totalPrice || 0), 0)),
        sellerDebitAmount,
        refKey: `refund-request-${request._id}`,
        currency: settlementCurrency,
        description: `Approved refund — Order #${order.orderNumber}, ${items.length} item(s)`,
        actorId, actorRole, targetType: 'order',
      });
      // The gift-card part of the refunded items goes back on the card (idempotent per request).
      await this.paymentService.restoreGiftCardForItems(order, sellerOrder, items, `refund-request-${request._id}`);
    } catch (err) {
      await revertClaim();
      throw err;
    }

    let stripeRefundId: string | null = null;
    if (order.paymentType === 'stripe') {
      const transaction = await this.databaseService.repositories.paymentTransactionModel.findOne({
        orderIds: order._id.toString(), status: 'completed', isDelete: false,
      });
      if (transaction?.stripePaymentIntentId) {
        try {
          const refund = await this.paymentService.refundStripePaymentIntent(
            transaction.stripePaymentIntentId,
            buyerRefundAmount,
            `refund_request_${request._id}`,
          );
          stripeRefundId = refund?.id ?? null;
        } catch (err: any) {
          // Ledger already reversed above — a failed Stripe call here means
          // the seller's wallet was correctly debited but the buyer's card
          // hasn't been refunded yet; surfaced as a security alert for
          // manual follow-up rather than silently swallowed.
          await this.activityLogService.log({
            storeId: sellerOrder.storeId,
            category: 'finance',
            action: 'stripe_refund_failed_after_ledger_reversal',
            description: `Stripe refund failed for order #${order.orderNumber} after seller ledger was already reversed: ${err?.message}`,
            actorId,
            actorRole,
            isSecurityAlert: true,
            targetId: order._id.toString(),
            targetType: 'order',
          });
        }
      }
    }

    // Mark only the specific refunded items on this one sellerOrder —
    // fetch-mutate-save on the live document (same pattern used elsewhere
    // in this codebase for nested subdocument-array updates, e.g.
    // CheckoutService's coupon methods) rather than a fragile multi-item
    // arrayFilters update.
    const liveOrder: any = await this.databaseService.repositories.orderModel.findById(order._id);
    if (liveOrder) {
      const liveSellerOrder = (liveOrder.sellerOrders as any[]).find(
        (so: any) => so._id.toString() === request.sellerOrderId,
      );
      if (liveSellerOrder) {
        for (const item of liveSellerOrder.items as any[]) {
          if (request.itemIds.includes(item._id.toString())) {
            item.status = 'refunded';
            item.refundedAmount = item.totalPrice;
          }
        }
        await liveOrder.save();
      }
    }

    // Returned physical goods go back into stock; digital items have no
    // stock (their access is revoked by the 'refunded' status above).
    for (const item of items) {
      if (item.type === 'physical' && item.variantId) {
        await this.databaseService.repositories.productVariantModel.updateOne(
          { _id: item.variantId, unlimitedStock: { $ne: true } },
          { $inc: { stock: item.quantity } },
        );
      }
    }

    await this.model.findByIdAndUpdate(request._id, {
      buyerRefundAmount,
      buyerRefundCurrency,
      sellerDebitAmount,
      sellerDebitCurrency: settlementCurrency,
      stripeRefundId,
    });
    // Trail entry only (kept out of the claim above on purpose: the refund path stays as it was).
    await this.pushHistory(request._id, trailEntry('approved', actorId, actorRole));

    await this.activityLogService.log({
      storeId: sellerOrder.storeId,
      category: 'finance',
      action: 'refund_approved',
      description: `Refund approved for order #${order.orderNumber} — buyer refunded ${buyerRefundAmount} ${buyerRefundCurrency}, seller debited ${sellerDebitAmount} ${settlementCurrency}`,
      actorId,
      actorRole,
      targetId: request._id.toString(),
      targetType: 'refund_request',
    });

    this.tell(
      order.userId, 'user', NOTIFICATION_TYPES.REFUND_APPROVED,
      'Refund approved',
      `Your refund of ${buyerRefundAmount} ${buyerRefundCurrency} for order #${order.orderNumber} was approved.`,
      { orderId: String(order._id), orderNumber: String(order.orderNumber ?? ''), link: `/account/orders/${order._id}` },
    );

    return {
      success: true,
      message: 'Refund approved',
      data: { buyerRefundAmount, buyerRefundCurrency, sellerDebitAmount, settlementCurrency, stripeRefundId },
    };
  }

  /** Best-effort trail write; a failure here must never undo or block a decision that already happened. */
  private async pushHistory(id: unknown, entry: ReturnType<typeof trailEntry>) {
    try {
      await this.model.updateOne({ _id: id as any }, { $push: { history: entry } } as any);
    } catch { /* tracking only */ }
  }

  /**
   * Tracking-only step after approval (item received back / replacement sent).
   * Conditional update from the exact previous step; any other jump is a 400.
   * No money moves here.
   */
  async followUp(actorId: string, actorRole: 'seller' | 'admin', requestId: string, step: string, noteRaw?: string) {
    const existing: any = await this.model.findOne({ _id: requestId, isDelete: false }).lean();
    if (!existing) throw new NotFoundException('Refund request not found');
    await this.assertCanReview(actorRole, actorId, existing);
    if (existing.status !== 'approved') throw new BadRequestException('Only an approved request can be followed up');

    const order: any = await this.databaseService.repositories.orderModel
      .findOne({ _id: existing.orderId, isDelete: false }).select('sellerOrders').lean();
    const so = (order?.sellerOrders ?? []).find((s: any) => String(s._id) === String(existing.sellerOrderId));
    const ids = new Set((existing.itemIds ?? []).map(String));
    const isPhysical = ((so?.items ?? []) as any[]).filter((i) => ids.has(String(i._id))).some((i) => i.type !== 'digital');

    const previous = requiredPreviousFollowUp(step, isPhysical);
    const note = cleanFollowUpNote(noteRaw);
    const updated = await this.model.findOneAndUpdate(
      { _id: requestId, isDelete: false, status: 'approved', followUp: previous },
      { $set: { followUp: step, followUpNote: note }, $push: { history: trailEntry(step, actorId, actorRole, note) } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new BadRequestException('This step is not available for the request in its current state');

    await this.activityLogService.log({
      storeId: existing.storeId,
      category: 'orders',
      action: `refund_${step}`,
      description: `Refund request marked "${step === 'item_received' ? 'item received back' : 'replacement sent'}"${note ? ` — ${note}` : ''}`,
      actorId,
      actorRole,
      targetId: String(requestId),
      targetType: 'refund_request',
    });
    return { success: true, message: 'Updated', data: { followUp: step } };
  }

  async reject(actorId: string, actorRole: 'seller' | 'admin', requestId: string, rawNotes: string) {
    const notes = cleanRejectReason(rawNotes);
    const existing = await this.model.findOne({ _id: requestId, isDelete: false }).lean();
    if (!existing) throw new NotFoundException('Refund request not found');
    await this.assertCanReview(actorRole, actorId, existing as any);

    const request = await this.model.findOneAndUpdate(
      { _id: requestId, status: 'pending', isDelete: false },
      { status: 'rejected', reviewedBy: actorId, reviewedAt: new Date(), resolutionNotes: notes },
      { returnDocument: 'after' },
    );
    if (!request) {
      throw new BadRequestException('Refund request not found or already reviewed');
    }
    await this.pushHistory(request._id, trailEntry('rejected', actorId, actorRole, notes));
    await this.activityLogService.log({
      storeId: request.storeId,
      category: 'orders',
      action: 'refund_rejected',
      description: `Refund request rejected — ${notes}`,
      actorId,
      actorRole,
      targetId: request._id.toString(),
      targetType: 'refund_request',
    });
    if (request.requestedByRole === 'user') {
      this.tell(
        request.requestedBy, 'user', NOTIFICATION_TYPES.REFUND_REJECTED,
        'Refund request not approved',
        `Your refund request was not approved.${notes ? ` Reason: ${String(notes).slice(0, 200)}` : ''}`,
        { orderId: String(request.orderId), link: `/account/orders/${request.orderId}` },
      );
    }
    return { success: true, message: 'Refund request rejected', data: request };
  }
}
