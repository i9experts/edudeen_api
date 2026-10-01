import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FinanceService } from 'src/finance/finance.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { round } from 'src/common/number.util';
import { PaymentService } from 'src/payment/payment.service';
import { orderStatusEmail } from 'src/notifications/templates/notification-email.template';

import { clampInt } from 'src/common/query-safety.util';
/** A sellerOrder's true payout basis for FinanceService.recordSale, in the
 *  SELLER'S OWN currency (so.settlementCurrency) — independent of what
 *  currency the buyer actually paid in (order.currency). Computed once at
 *  order-creation time (PaymentService.createOrder) already restoring the
 *  platform-sponsored portion of any campaign discount on top of the
 *  (already net-of-discount) native subtotal, so a platform-sponsored sale
 *  never reduces what the seller is credited. Falls back to the old
 *  order-currency-denominated calculation only for orders placed before
 *  settlementAmount/settlementCurrency existed. */
function sellerPayoutBasis(so: any): number {
  if (so.settlementAmount != null) return so.settlementAmount;
  return round(so.subtotal + (so.platformSponsoredDiscountUSD ?? 0));
}

function sellerPayoutCurrency(so: any, order: any): string {
  return so.settlementCurrency ?? order.currency ?? 'USD';
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly financeService: FinanceService,
    private readonly activityLogService: ActivityLogService,
    private readonly loyaltyService: LoyaltyService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly notificationsService: NotificationsService,
    private readonly paymentService: PaymentService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  /** Subscribers earn points at their plan's configured multiplier (default 1x). */
  private async awardLoyaltyPointsWithMultiplier(
    storeId: string,
    userId: string,
    orderId: string,
    subtotal: number,
  ) {
    const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(
      userId,
      storeId,
    );
    const multiplier = benefitsEntry
      ? this.subscriptionBenefits.getLoyaltyMultiplier(benefitsEntry.benefits)
      : 1;
    return this.loyaltyService.awardPurchasePoints(
      storeId,
      userId,
      orderId,
      subtotal,
      multiplier,
    );
  }

  async getOrdersByUserId(userId: string, query: any) {
    const { orderModel, sellerModel } = this.databaseService.repositories;

    const page = clampInt(query.page, 1, 1, 100000);
    const limit = clampInt(query.limit, 10, 1, 100);
    const skip = (page - 1) * limit;

    const filter: any = { userId, isDelete: false };

    if (query.status && query.status !== 'all') {
      filter.orderStatus = query.status;
    }

    const total = await orderModel.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const orders = await orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Batch-resolve seller name + verification badge across every distinct
    // seller in this page — same one-query-instead-of-N pattern used on the
    // product listing endpoints.
    const sellerIds = [
      ...new Set(
        orders.flatMap((order: any) =>
          (order.sellerOrders ?? []).map((so: any) => so.sellerId),
        ),
      ),
    ].filter(Boolean);
    const sellers = sellerIds.length
      ? await sellerModel
          .find({ _id: { $in: sellerIds } })
          .select('name isVerified')
          .lean()
      : [];
    const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));

    const list = orders.map((order: any) => ({
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderStatus: order.orderStatus,
      paymentType: order.paymentType,
      paymentStatus: order.paymentStatus,
      isPaid: order.isPaid,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      taxAmount: order.taxAmount,
      subscriberDiscountTotal: order.subscriberDiscountTotal ?? 0,
      totalAmount: order.totalAmount,
      currency: order.currency,
      shippingAddress: order.shippingAddress,
      stores: (order.sellerOrders ?? []).map((so: any) => {
        const seller = sellerMap.get(so.sellerId?.toString());
        return {
          storeId: so.storeId,
          sellerOrderId: so._id,
          sellerId: so.sellerId,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          fulfillmentType: so.fulfillmentType,
          status: so.status,
          subtotal: so.subtotal,
          itemCount: (so.items ?? []).length,
          items: (so.items ?? []).map((item: any) => ({
            itemId: item._id,
            productId: item.productId,
            name: item.name,
            image: item.image,
            sku: item.sku,
            type: item.type,
            productType: item.productType ?? null,
            quantity: item.quantity,
            price: item.price,
            totalPrice: item.totalPrice,
            originalPrice: item.originalPrice ?? null,
            subscriberDiscountUSD: item.subscriberDiscountUSD ?? 0,
            status: item.status,
          })),
          tracking: so.tracking,
          shippedAt: so.shippedAt,
          deliveredAt: so.deliveredAt,
        };
      }),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    }));

    return {
      success: true,
      data: {
        pagination: { page, limit, totalPages, total },
        orders: list,
      },
    };
  }

  async getOrderById(userId: string, orderId: string) {
    const { orderModel, sellerModel } = this.databaseService.repositories;

    const order = await orderModel
      .findOne({ _id: orderId, isDelete: false })
      .lean();
    if (!order) throw new NotFoundException('Order not found');
    if ((order as any).userId !== userId)
      throw new ForbiddenException('Unauthorized');

    const orderSellerOrders = ((order as any).sellerOrders ?? []) as any[];
    const sellerIds: string[] = [
      ...new Set(orderSellerOrders.map((so: any) => so.sellerId)),
    ].filter(Boolean);
    const sellers = sellerIds.length
      ? await sellerModel
          .find({ _id: { $in: sellerIds } })
          .select('name isVerified')
          .lean()
      : [];
    const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));

    const enrichedOrder = {
      ...order,
      sellerOrders: orderSellerOrders.map((so: any) => {
        const seller = sellerMap.get(so.sellerId?.toString());
        return {
          ...so,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
        };
      }),
    };

    return {
      success: true,
      data: enrichedOrder,
    };
  }

  /** `storeId` omitted (null) means "every store this seller owns" — used by the
   *  seller-wide dashboard, as opposed to a single store's own orders page. */
  async getSellerOrders(sellerId: string, storeId: string | null, query: any) {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;

    let storeIds: string[];
    if (storeId) {
      const store = await storeModel.findOne({
        _id: storeId,
        sellerId,
        isDelete: false,
      });
      if (!store)
        throw new ForbiddenException('Store not found or unauthorized');
      storeIds = [storeId];
    } else {
      const stores = await storeModel
        .find({ sellerId, isDelete: false })
        .select('_id')
        .lean();
      storeIds = stores.map((s: any) => s._id.toString());
    }

    const page = clampInt(query.page, 1, 1, 100000);
    const limit = Math.min(50, clampInt(query.limit, 10, 1, 100));
    const skip = (page - 1) * limit;

    // base filter — orders touching any of the scoped store(s)
    const matchFilter: any = {
      'sellerOrders.storeId': { $in: storeIds },
      isDelete: false,
    };

    if (query.type && query.type !== 'all') {
      matchFilter['sellerOrders.fulfillmentType'] = query.type;
    }
    if (query.status && query.status !== 'all') {
      matchFilter['sellerOrders.status'] = query.status;
    }
    if (query.time && query.time !== 'all') {
      const now = new Date();
      if (query.time === 'today') {
        matchFilter.createdAt = { $gte: new Date(now.setHours(0, 0, 0, 0)) };
      } else if (query.time === 'week') {
        const week = new Date();
        week.setDate(week.getDate() - 7);
        matchFilter.createdAt = { $gte: week };
      } else if (query.time === 'month') {
        const month = new Date();
        month.setMonth(month.getMonth() - 1);
        matchFilter.createdAt = { $gte: month };
      }
    }

    const totalOrders = await orderModel.countDocuments(matchFilter);
    const totalPages = Math.ceil(totalOrders / limit);

    const orders = await orderModel
      .find(matchFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // stats — all orders across the scoped store(s) (no pagination)
    const allOrders = await orderModel
      .find({ 'sellerOrders.storeId': { $in: storeIds }, isDelete: false })
      .lean();

    let totalRevenue = 0;
    let pendingCount = 0;

    for (const order of allOrders) {
      const so = (order.sellerOrders as any[]).find((s: any) =>
        storeIds.includes(s.storeId),
      );
      if (!so) continue;
      if (['completed', 'delivered'].includes(so.status)) {
        totalRevenue += so.subtotal || 0;
      }
      if (['pending', 'processing'].includes(so.status)) {
        pendingCount++;
      }
    }

    const avgOrder = allOrders.length > 0 ? totalRevenue / allOrders.length : 0;

    // order rows format
    const rows = await Promise.all(
      orders.map(async (order: any) => {
        const so = order.sellerOrders.find((s: any) =>
          storeIds.includes(s.storeId),
        );
        if (!so) return null;

        const user = await userModel
          .findOne({ _id: order.userId })
          .select('name email')
          .lean();
        const firstItem = so.items?.[0];

        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: (user as any)?.email || '',
          },
          product: firstItem?.name || '',
          type: so.fulfillmentType,
          productType: firstItem?.productType ?? null,
          date: order.createdAt,
          amount: so.subtotal,
          // `amount` above is so.subtotal, which is denominated in the order's
          // own currency (fixed per store) — carried per-row so a cross-store
          // "my orders" list can label each row correctly even when the
          // seller's stores don't all share one currency.
          currency: order.currency ?? 'USD',
          status: so.status,
          isPaid: order.isPaid,
          paymentType: order.paymentType,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          totalOrders,
          revenue: totalRevenue,
          pending: pendingCount,
          avgOrder: parseFloat(avgOrder.toFixed(2)),
        },
        pagination: {
          page,
          limit,
          totalPages,
          totalOrders,
        },
        orders: rows.filter(Boolean),
      },
    };
  }

  async updateSellerOrderStatus(
    sellerId: string,
    body: any,
    ip?: string,
    userAgent?: string,
  ) {
    const { orderId, storeId, status, tracking } = body;

    if (!orderId) throw new BadRequestException('orderId is required');
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!status) throw new BadRequestException('status is required');

    const validStatuses = ['processing', 'shipped', 'delivered', 'completed'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        `Invalid status. Allowed: ${validStatuses.join(', ')}`,
      );
    }

    const { orderModel, storeModel } = this.databaseService.repositories;

    // store ownership check
    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrderIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (sellerOrderIndex === -1) throw new ForbiddenException('Unauthorized');

    // Guards against double-crediting the finance ledger if this sellerOrder was already
    // completed before this call (duplicate/retried request, double-click, etc.) — mirrors
    // the `order.isPaid` guard already used in `markPaid` below for the same reason.
    const wasAlreadyCompleted =
      order.sellerOrders[sellerOrderIndex].status === 'completed';

    // Forward-only lifecycle. Skipping ahead is fine (a digital order has
    // nothing to ship), but going backwards or touching a cancelled order
    // is not.
    const RANK: Record<string, number> = { pending: 0, processing: 1, shipped: 2, delivered: 3, completed: 4 };
    const currentStatus = order.sellerOrders[sellerOrderIndex].status;
    if (currentStatus === 'cancelled') {
      throw new BadRequestException('This order was cancelled');
    }
    if (RANK[currentStatus] !== undefined && RANK[status] < RANK[currentStatus]) {
      throw new BadRequestException(`Order is already ${currentStatus} — it can't go back to ${status}`);
    }
    // Completing credits the seller's ledger, so the buyer must have paid.
    // A COD order is completed via "Mark Paid" once the cash is collected.
    if (status === 'completed' && !order.isPaid) {
      throw new BadRequestException('Mark this order as paid before completing it');
    }

    if (status === 'shipped' && !tracking) {
      throw new BadRequestException(
        'tracking info required when status is shipped',
      );
    }

    const updateData: any = {};

    // sellerOrder status
    updateData[`sellerOrders.${sellerOrderIndex}.status`] = status;

    // saare items same status
    const soItems = order.sellerOrders[sellerOrderIndex].items;
    soItems.forEach((_: any, itemIndex: number) => {
      updateData[`sellerOrders.${sellerOrderIndex}.items.${itemIndex}.status`] =
        status;
    });

    // status-specific fields
    if (status === 'shipped') {
      updateData[`sellerOrders.${sellerOrderIndex}.shippedAt`] = new Date();
      updateData[`sellerOrders.${sellerOrderIndex}.tracking`] = tracking;
    }
    if (status === 'delivered') {
      updateData[`sellerOrders.${sellerOrderIndex}.deliveredAt`] = new Date();
    }

    // overall orderStatus derive
    const allStatuses = order.sellerOrders.map((so: any, idx: number) =>
      idx === sellerOrderIndex ? status : so.status,
    );

    if (allStatuses.every((s: string) => s === 'completed')) {
      updateData.orderStatus = 'completed';
    } else if (
      allStatuses.some((s: string) => ['shipped', 'delivered'].includes(s))
    ) {
      updateData.orderStatus = 'partially_shipped';
    } else if (allStatuses.every((s: string) => s === 'processing')) {
      updateData.orderStatus = 'processing';
    }

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    // Record sale in finance ledger when seller marks their order completed — only on the
    // transition into `completed`, never again if it was already completed (see guard above).
    if (status === 'completed' && !wasAlreadyCompleted) {
      const so = order.sellerOrders[sellerOrderIndex];
      // A Connect-settled sellerOrder's money already went straight to the
      // seller's own Stripe-connected account at payment time — crediting
      // the internal ledger here too would let them draw a second, duplicate
      // payout through the platform's own payout-request flow. See
      // PaymentService.initiatePayment/SellerOrder.settledViaConnect.
      if (!so.settledViaConnect) {
        const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
        const sponsoredCampaignId =
          so.items.find((i: any) => i.campaignSponsorType === 'platform')
            ?.campaignId ?? null;
        try {
          await this.financeService.recordSale(
            so.storeId,
            so.sellerId,
            orderId,
            sellerPayoutBasis(so),
            `Sale — Order #${orderId}`,
            platformSponsoredUSD,
            sponsoredCampaignId,
            sellerPayoutCurrency(so, order),
            order.paymentType,
            so.fulfillmentMode,
          );
        } catch (e) {
          console.error('Finance recordSale failed:', e?.message);
        }
      }

      this.awardLoyaltyPointsWithMultiplier(
        so.storeId,
        order.userId,
        orderId,
        so.subtotal,
      ).catch(() => {});
    }

    const so = order.sellerOrders[sellerOrderIndex];
    this.activityLogService.log({
      storeId: so.storeId,
      category: 'orders',
      action: status === 'shipped' ? 'order_fulfilled' : `order_${status}`,
      description: tracking
        ? `Order #${orderId} — shipped via ${tracking.carrier ?? tracking}`
        : `Order #${orderId} — status changed to ${status}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
      ip,
      userAgent,
    });

    if (status === 'shipped' || status === 'delivered') {
      this.notificationsService
        .notify({
          recipientId: order.userId,
          recipientRole: 'user',
          type:
            status === 'shipped'
              ? NOTIFICATION_TYPES.ORDER_SHIPPED
              : NOTIFICATION_TYPES.ORDER_DELIVERED,
          title:
            status === 'shipped'
              ? 'Your order has shipped'
              : 'Your order was delivered',
          body:
            status === 'shipped'
              ? `Order #${orderId} is on its way${tracking?.carrier ? ` via ${tracking.carrier}` : ''}.`
              : `Order #${orderId} has been delivered.`,
          data: { orderId, status },
          email: orderStatusEmail(order.orderNumber ?? orderId, status, tracking),
        })
        .catch(() => {});
    }

    return { success: true, message: `Order status updated to ${status}` };
  }

  async markPaid(orderId: string, actor: { userId: string; role: string }) {
    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.isPaid) throw new BadRequestException('Order is already paid');

    // A seller may only confirm payment on an order made up entirely of their
    // own sub-orders — marking paid credits every seller in the order's
    // ledger, so one seller must never be able to do it for another's sale.
    // A multi-store order has to be confirmed by an admin.
    if (actor.role !== 'admin') {
      const ownsAll =
        order.sellerOrders.length > 0 &&
        order.sellerOrders.every((so: any) => so.sellerId === actor.userId);
      if (!ownsAll) {
        throw new ForbiddenException('You can only mark your own orders as paid');
      }
    }

    // Only money collected offline is confirmed by hand — a Stripe charge is
    // confirmed by Stripe itself, and a bank transfer goes through the admin
    // proof-review flow (manual-payments), so a seller only confirms COD.
    if (order.paymentType === 'stripe') {
      throw new BadRequestException('Card payments are confirmed automatically');
    }
    if (actor.role !== 'admin' && order.paymentType !== 'cash_on_delivery') {
      throw new ForbiddenException('Bank transfers are confirmed by the Edudeen team after reviewing the payment proof');
    }

    const now = new Date();
    const updateData: any = {
      isPaid: true,
      paymentStatus: 'paid',
      paidAt: now,
      orderStatus: 'completed',
    };

    order.sellerOrders.forEach((so: any, soIndex: number) => {
      updateData[`sellerOrders.${soIndex}.status`] = 'completed';
      updateData[`sellerOrders.${soIndex}.deliveredAt`] = now;
      so.items.forEach((_: any, itemIndex: number) => {
        updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] =
          'completed';
      });
    });

    // Atomic isPaid:false guard — two concurrent calls (double-click, retry)
    // must not both get past the check above and double-credit the ledger.
    const claimed = await orderModel.findOneAndUpdate(
      { _id: orderId, isPaid: { $ne: true }, isDelete: false },
      { $set: updateData },
    );
    if (!claimed) throw new BadRequestException('Order is already paid');

    // Record sale in finance ledger for each store's sub-order — skipping
    // any that settled directly via Stripe Connect (see the same guard/
    // comment in the status-transition branch above).
    for (const so of order.sellerOrders) {
      if (so.settledViaConnect) continue;
      const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
      const sponsoredCampaignId =
        so.items.find((i: any) => i.campaignSponsorType === 'platform')
          ?.campaignId ?? null;
      try {
        await this.financeService.recordSale(
          so.storeId,
          so.sellerId,
          orderId,
          sellerPayoutBasis(so),
          `Sale — Order #${orderId}`,
          platformSponsoredUSD,
          sponsoredCampaignId,
          sellerPayoutCurrency(so, order),
          order.paymentType,
          so.fulfillmentMode,
        );
      } catch (e) {
        console.error('Finance recordSale failed:', e?.message);
      }

      this.awardLoyaltyPointsWithMultiplier(
        so.storeId,
        order.userId,
        orderId,
        so.subtotal,
      ).catch(() => {});
    }

    this.notificationsService
      .notify({
        recipientId: order.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.PAYMENT_SUCCESS,
        title: 'Payment received',
        body: `We've received your payment for order #${orderId}.`,
        data: { orderId },
      })
      .catch(() => {});

    return { success: true, message: 'Order marked as paid' };
  }

  async cancelOrder(userId: string, orderId: string, body: any) {
    const { reason, itemIds } = body;
    if (!reason) throw new BadRequestException('reason is required');

    const { orderModel, productVariantModel } =
      this.databaseService.repositories;

    const order = await orderModel.findOne({
      _id: orderId,
      userId,
      isDelete: false,
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.orderStatus === 'completed')
      throw new BadRequestException('Completed orders cannot be cancelled');
    if (order.orderStatus === 'cancelled')
      throw new BadRequestException('Order is already cancelled');

    const now = new Date();
    const BLOCKED = ['shipped', 'delivered', 'completed', 'cancelled'];

    // flatten all items with their indices
    const allItems: { soIndex: number; itemIndex: number; item: any }[] = [];
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      so.items.forEach((item: any, itemIndex: number) => {
        allItems.push({ soIndex, itemIndex, item });
      });
    });

    let targetItems: { soIndex: number; itemIndex: number; item: any }[];

    if (itemIds && Array.isArray(itemIds) && itemIds.length > 0) {
      // item-level cancel
      targetItems = [];
      for (const itemId of itemIds) {
        const found = allItems.find(
          ({ item }) => item._id.toString() === itemId,
        );
        if (!found) throw new BadRequestException(`Item not found: ${itemId}`);
        if (found.item.status === 'cancelled')
          throw new BadRequestException(
            `Item "${found.item.name}" is already cancelled`,
          );
        if (BLOCKED.includes(found.item.status))
          throw new BadRequestException(
            `Item "${found.item.name}" cannot be cancelled — status: ${found.item.status}`,
          );
        targetItems.push(found);
      }
    } else {
      // full order cancel — koi bhi item shipped nahi honi chahiye
      const blockedItem = allItems.find(({ item }) =>
        BLOCKED.slice(0, 3).includes(item.status),
      );
      if (blockedItem)
        throw new BadRequestException(
          `Cannot cancel order — "${blockedItem.item.name}" is already ${blockedItem.item.status}`,
        );
      targetItems = allItems.filter(({ item }) => item.status !== 'cancelled');
    }

    if (targetItems.length === 0)
      throw new BadRequestException('No items to cancel');

    // A paid digital item was delivered the moment it was paid for (the
    // download link is live), so it goes through a refund request instead.
    if (order.isPaid) {
      const digital = targetItems.find(({ item }) => item.type === 'digital');
      if (digital) {
        throw new BadRequestException(
          `"${digital.item.name}" has already been delivered — please request a refund instead`,
        );
      }
    }

    // Money back BEFORE anything is written: if the Stripe refund fails the
    // order stays exactly as it was, instead of claiming "refunded" in the
    // DB while the buyer never gets their money.
    const cancelsWholeOrder = targetItems.length === allItems.filter(({ item }) => item.status !== 'cancelled').length;
    let refundedViaStripe = false;
    let manualRefundNeeded = false;
    if (order.isPaid) {
      const refundAmount = round(
        targetItems.reduce((s, { item }) => s + (item.totalPrice ?? 0), 0) +
          (cancelsWholeOrder ? (order.shippingFee ?? 0) : 0),
      );
      if (order.paymentType === 'stripe') {
        const { paymentTransactionModel } = this.databaseService.repositories;
        const tx = await paymentTransactionModel.findOne({
          orderIds: orderId,
          status: 'completed',
          stripePaymentIntentId: { $ne: null },
          isDelete: false,
        });
        if (!tx) throw new BadRequestException('Payment record not found — please contact support to cancel this order');
        const refundable = round((tx.amount ?? 0) - (tx.amountRefunded ?? 0));
        const amount = Math.min(refundAmount, refundable);
        if (amount > 0) {
          const itemKey = targetItems.map(({ item }) => item._id.toString()).sort().join(',');
          const refund = await this.paymentService.refundStripePaymentIntent(
            tx.stripePaymentIntentId!,
            amount,
            `cancel-${orderId}-${itemKey}`,
          );
          if (!refund) throw new BadRequestException('Online refunds are not available right now — please contact support');
        }
        refundedViaStripe = true;
      } else {
        // Bank transfer: there's no API to send the money back — flag it.
        manualRefundNeeded = true;
      }
    }

    const updateData: any = {};

    for (const { soIndex, itemIndex, item } of targetItems) {
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] =
        'cancelled';
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelledAt`] =
        now;
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelReason`] =
        reason;
      if (order.isPaid) {
        updateData[
          `sellerOrders.${soIndex}.items.${itemIndex}.refundedAmount`
        ] = item.totalPrice;
      }

      // physical item — stock wapas restore (skip unlimited-stock variants)
      if (item.type === 'physical' && item.variantId) {
        await productVariantModel.updateOne(
          { _id: item.variantId, unlimitedStock: { $ne: true } },
          { $inc: { stock: item.quantity } },
        );
      }
    }

    // sellerOrder status recalculate
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      const updatedStatuses = so.items.map((item: any, itemIndex: number) => {
        const wasUpdated = targetItems.find(
          (t) => t.soIndex === soIndex && t.itemIndex === itemIndex,
        );
        return wasUpdated ? 'cancelled' : item.status;
      });
      if (updatedStatuses.every((s: string) => s === 'cancelled')) {
        updateData[`sellerOrders.${soIndex}.status`] = 'cancelled';
        updateData[`sellerOrders.${soIndex}.cancelledAt`] = now;
        updateData[`sellerOrders.${soIndex}.cancelReason`] = reason;
      }
    });

    // overall orderStatus recalculate
    const updatedSOStatuses = order.sellerOrders.map(
      (so: any, soIndex: number) =>
        updateData[`sellerOrders.${soIndex}.status`] ?? so.status,
    );
    if (updatedSOStatuses.every((s: string) => s === 'cancelled')) {
      updateData.orderStatus = 'cancelled';
    }

    // Only claim 'refunded' once the money actually went back (whole order).
    if (refundedViaStripe && updateData.orderStatus === 'cancelled') {
      updateData.paymentStatus = 'refunded';
    }

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    if (manualRefundNeeded) {
      this.activityLogService.log({
        storeId: order.sellerOrders[targetItems[0].soIndex].storeId,
        category: 'finance',
        action: 'manual_refund_required',
        description: `Buyer cancelled paid bank-transfer order #${orderId} — refund must be sent manually`,
        actorId: userId,
        actorRole: 'user',
        isSecurityAlert: true,
        targetId: orderId,
        targetType: 'order',
      });
    }

    const affectedSellerIds = [
      ...new Set(
        targetItems.map(({ soIndex }) => order.sellerOrders[soIndex].sellerId),
      ),
    ];
    affectedSellerIds.forEach((sellerOrderSellerId) => {
      this.notificationsService
        .notify({
          recipientId: sellerOrderSellerId,
          recipientRole: 'seller',
          type: NOTIFICATION_TYPES.ORDER_CANCELLED,
          title: 'Order cancelled by buyer',
          body: `Order #${orderId} was cancelled by the buyer — ${reason}`,
          data: { orderId },
        })
        .catch(() => {});
    });

    return {
      success: true,
      message:
        targetItems.length === allItems.length
          ? 'Order cancelled successfully'
          : `${targetItems.length} item(s) cancelled successfully`,
      data: {
        orderId,
        cancelledItems: targetItems.length,
        refundProcessed: refundedViaStripe,
        refundPendingManual: manualRefundNeeded,
      },
    };
  }

  async getSellerReturns(sellerId: string, query: any) {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;
    const { storeId, status, page: pageStr } = query;

    const page = parseInt(pageStr) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    let storeIds: string[];

    if (storeId) {
      const store = await storeModel.findOne({
        _id: storeId,
        sellerId,
        isDelete: false,
      });
      if (!store)
        throw new ForbiddenException('Store not found or unauthorized');
      storeIds = [storeId];
    } else {
      const stores = await storeModel
        .find({ sellerId, isDelete: false })
        .select('_id')
        .lean();
      storeIds = (stores as any[]).map((s) => s._id.toString());
      if (storeIds.length === 0)
        throw new BadRequestException('No stores found for this seller');
    }

    const allOrders = await orderModel
      .find({ 'sellerOrders.storeId': { $in: storeIds }, isDelete: false })
      .lean();

    // flatten to individual return items
    const returnItems: { order: any; so: any; item: any }[] = [];
    let totalOrderItems = 0;

    for (const order of allOrders) {
      for (const so of order.sellerOrders) {
        if (!storeIds.includes(so.storeId)) continue;
        totalOrderItems += so.items.length;
        for (const item of so.items) {
          if (!item.returnStatus || item.returnStatus === 'none') continue;
          if (status && status !== 'all' && item.returnStatus !== status)
            continue;
          returnItems.push({ order, so, item });
        }
      }
    }

    // stats
    const openRequests = returnItems.filter(
      ({ item }) => item.returnStatus === 'requested',
    ).length;
    const returnRate =
      totalOrderItems > 0
        ? parseFloat(((returnItems.length / totalOrderItems) * 100).toFixed(1))
        : 0;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const totalRefunded = returnItems
      .filter(
        ({ item }) =>
          item.returnStatus === 'approved' &&
          item.returnRequestedAt &&
          new Date(item.returnRequestedAt) >= thirtyDaysAgo,
      )
      .reduce((sum, { item }) => sum + (item.refundedAmount || 0), 0);

    // paginate
    const total = returnItems.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = returnItems.slice(skip, skip + limit);

    const list = await Promise.all(
      paginated.map(async ({ order, so, item }) => {
        const user = await userModel
          .findById(order.userId)
          .select('name email')
          .lean();
        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemId: item._id,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: (user as any)?.email || null,
          },
          storeId: so.storeId,
          productName: item.name,
          productImage: item.image || null,
          returnReason: item.returnReason,
          amount: item.totalPrice,
          refundedAmount: item.refundedAmount || 0,
          returnStatus: item.returnStatus,
          returnRejectReason: item.returnRejectReason || null,
          returnRequestedAt: item.returnRequestedAt,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          openRequests,
          returnRate: `${returnRate}%`,
          totalRefunded,
        },
        pagination: { page, limit, totalPages, total },
        returns: list,
      },
    };
  }

  async returnRequest(userId: string, orderId: string, body: any) {
    const { reason, itemIds } = body;
    if (!reason) throw new BadRequestException('reason is required');

    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({
      _id: orderId,
      userId,
      isDelete: false,
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.orderStatus === 'cancelled')
      throw new BadRequestException('Cancelled orders cannot be returned');
    if (['pending', 'processing'].includes(order.orderStatus))
      throw new BadRequestException('Order not yet delivered');

    const now = new Date();

    const allItems: {
      soIndex: number;
      itemIndex: number;
      item: any;
      so: any;
    }[] = [];
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      so.items.forEach((item: any, itemIndex: number) => {
        allItems.push({ soIndex, itemIndex, item, so });
      });
    });

    let targetItems: typeof allItems;

    if (itemIds && Array.isArray(itemIds) && itemIds.length > 0) {
      targetItems = [];
      for (const itemId of itemIds) {
        const found = allItems.find(
          ({ item }) => item._id.toString() === itemId,
        );
        if (!found) throw new BadRequestException(`Item not found: ${itemId}`);
        targetItems.push(found);
      }
    } else {
      targetItems = [...allItems];
    }

    for (const { item, so } of targetItems) {
      if (item.type === 'digital')
        throw new BadRequestException(
          `"${item.name}" is a digital product — cannot be returned`,
        );
      if (!['delivered', 'completed'].includes(so.status))
        throw new BadRequestException(`"${item.name}" is not yet delivered`);
      if (item.status === 'cancelled')
        throw new BadRequestException(
          `Cancelled item "${item.name}" cannot be returned`,
        );
      if (item.returnStatus && item.returnStatus !== 'none')
        throw new BadRequestException(
          `Return already requested for "${item.name}"`,
        );
    }

    const updateData: any = {};

    for (const { soIndex, itemIndex } of targetItems) {
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnStatus`] =
        'requested';
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnReason`] =
        reason;
      updateData[
        `sellerOrders.${soIndex}.items.${itemIndex}.returnRequestedAt`
      ] = now;
    }

    // sellerOrder returnStatus recalculate
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      const physicalActive = so.items.filter(
        (i: any) => i.type === 'physical' && i.status !== 'cancelled',
      );
      if (physicalActive.length === 0) return;

      const effectiveStatuses = physicalActive.map((item: any) => {
        const globalIdx = so.items.indexOf(item);
        const wasUpdated = targetItems.find(
          (t) => t.soIndex === soIndex && t.itemIndex === globalIdx,
        );
        return wasUpdated ? 'requested' : item.returnStatus || 'none';
      });

      const allRequested = effectiveStatuses.every(
        (s: string) => s === 'requested',
      );
      const anyRequested = effectiveStatuses.some(
        (s: string) => s === 'requested',
      );

      if (allRequested)
        updateData[`sellerOrders.${soIndex}.returnStatus`] = 'requested';
      else if (anyRequested)
        updateData[`sellerOrders.${soIndex}.returnStatus`] =
          'partial_requested';
    });

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    return {
      success: true,
      message: `Return requested for ${targetItems.length} item(s)`,
      data: { orderId, requestedItems: targetItems.length },
    };
  }

  async returnAction(
    sellerId: string,
    orderId: string,
    body: any,
    ip?: string,
    userAgent?: string,
  ) {
    const { storeId, itemIds, action, rejectReason } = body;
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0)
      throw new BadRequestException('itemIds are required');
    if (!action || !['approve', 'reject'].includes(action))
      throw new BadRequestException('action must be approve or reject');

    const { orderModel, storeModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const soIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId,
    );
    if (soIndex === -1)
      throw new BadRequestException('No orders found for this store');

    const sellerOrder = order.sellerOrders[soIndex];
    const updateData: any = {};
    const targetItems: { itemIndex: number; item: any }[] = [];

    for (const itemId of itemIds) {
      const itemIndex = sellerOrder.items.findIndex(
        (i: any) => i._id.toString() === itemId,
      );
      if (itemIndex === -1)
        throw new BadRequestException(`Item not found: ${itemId}`);
      const item = sellerOrder.items[itemIndex];
      if (item.returnStatus !== 'requested')
        throw new BadRequestException(
          `"${item.name}" has no pending return request`,
        );
      if (['refunded', 'cancelled'].includes(item.status) || (item.refundedAmount ?? 0) > 0)
        throw new BadRequestException(`"${item.name}" has already been refunded or cancelled`);
      targetItems.push({ itemIndex, item });
    }

    for (const { itemIndex, item } of targetItems) {
      if (action === 'approve') {
        updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnStatus`] =
          'approved';
        updateData[
          `sellerOrders.${soIndex}.items.${itemIndex}.refundedAmount`
        ] = item.totalPrice;
      } else {
        updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnStatus`] =
          'rejected';
        if (rejectReason) {
          updateData[
            `sellerOrders.${soIndex}.items.${itemIndex}.returnRejectReason`
          ] = rejectReason;
        }
      }
    }

    // sellerOrder returnStatus recalculate
    const physicalActive = sellerOrder.items.filter(
      (item: any) => item.type === 'physical' && item.status !== 'cancelled',
    );

    const effectiveStatuses = physicalActive.map((item: any) => {
      const globalIdx = sellerOrder.items.indexOf(item);
      const wasUpdated = targetItems.find((t) => t.itemIndex === globalIdx);
      if (!wasUpdated) return item.returnStatus || 'none';
      return action === 'approve' ? 'approved' : 'rejected';
    });

    const allApproved = effectiveStatuses.every(
      (s: string) => s === 'approved',
    );
    const anyApproved = effectiveStatuses.some((s: string) => s === 'approved');
    const allRequested = effectiveStatuses.every(
      (s: string) => s === 'requested',
    );
    const anyRequested = effectiveStatuses.some(
      (s: string) => s === 'requested',
    );
    const allRejected = effectiveStatuses
      .filter((s: string) => s !== 'none')
      .every((s: string) => s === 'rejected');

    let newSellerReturnStatus: string;
    if (allApproved) newSellerReturnStatus = 'approved';
    else if (anyApproved)
      newSellerReturnStatus = 'partial_approved'; // approved wins even if kuch rejected
    else if (allRequested) newSellerReturnStatus = 'requested';
    else if (anyRequested) newSellerReturnStatus = 'partial_requested';
    else if (allRejected) newSellerReturnStatus = 'rejected';
    else newSellerReturnStatus = 'none';

    updateData[`sellerOrders.${soIndex}.returnStatus`] = newSellerReturnStatus;

    if (action === 'approve') {
      updateData.hasReturnApproved = true;
    }

    // Claim the return atomically FIRST: only the request that flips these
    // items requested→approved/rejected may move money, so a double-click or
    // retry can't refund (and restock) twice. If the buyer refund below fails,
    // the claim is rolled back so the return stays pending, as before.
    const claimFilter: Record<string, any> = { _id: orderId, isDelete: false };
    for (const t of targetItems) {
      claimFilter[`sellerOrders.${soIndex}.items.${t.itemIndex}.returnStatus`] = 'requested';
    }
    const claimed = await orderModel.findOneAndUpdate(claimFilter, { $set: updateData });
    if (!claimed) throw new BadRequestException('These return requests were already processed');

    const revertClaim = async () => {
      const revert: Record<string, any> = {
        [`sellerOrders.${soIndex}.returnStatus`]: sellerOrder.returnStatus ?? 'none',
        hasReturnApproved: order.hasReturnApproved ?? false,
      };
      for (const t of targetItems) {
        revert[`sellerOrders.${soIndex}.items.${t.itemIndex}.returnStatus`] = 'requested';
        revert[`sellerOrders.${soIndex}.items.${t.itemIndex}.refundedAmount`] = t.item.refundedAmount ?? 0;
      }
      await orderModel.updateOne({ _id: orderId }, { $set: revert });
    };

    // Send the buyer's money back, and only keep the approval if that worked.
    let manualRefundNeeded = false;
    try {
      if (action === 'approve' && order.isPaid) {
        const buyerRefund = round(
          targetItems.reduce((sum, t) => sum + (t.item.totalPrice || 0), 0),
        );
        if (order.paymentType === 'stripe' && buyerRefund > 0) {
          const { paymentTransactionModel } = this.databaseService.repositories;
          const tx = await paymentTransactionModel.findOne({
            orderIds: orderId,
            status: 'completed',
            stripePaymentIntentId: { $ne: null },
            isDelete: false,
          });
          if (!tx) throw new BadRequestException('Payment record not found — contact support to refund this return');
          const amount = Math.min(buyerRefund, round((tx.amount ?? 0) - (tx.amountRefunded ?? 0)));
          if (amount > 0) {
            const itemKey = targetItems.map((t) => t.item._id.toString()).sort().join(',');
            const refund = await this.paymentService.refundStripePaymentIntent(
              tx.stripePaymentIntentId!,
              amount,
              `return-${orderId}-${itemKey}`,
            );
            if (!refund) throw new BadRequestException('Online refunds are not available right now — try again later');
          }
        } else if (buyerRefund > 0) {
          // COD / bank transfer: the cash has to be returned by hand.
          manualRefundNeeded = true;
        }
      }
    } catch (err) {
      await revertClaim();
      throw err;
    }

    // Returned goods go back on the shelf.
    if (action === 'approve') {
      const { productVariantModel } = this.databaseService.repositories;
      for (const { item } of targetItems) {
        if (item.type === 'physical' && item.variantId) {
          await productVariantModel.updateOne(
            { _id: item.variantId, unlimitedStock: { $ne: true } },
            { $inc: { stock: item.quantity } },
          );
        }
      }
    }

    if (manualRefundNeeded) {
      this.activityLogService.log({
        storeId,
        category: 'finance',
        action: 'manual_refund_required',
        description: `Return approved on ${order.paymentType} order #${orderId} — refund the buyer manually`,
        actorId: sellerId,
        actorRole: 'seller',
        isSecurityAlert: true,
        targetId: orderId,
        targetType: 'order',
      });
    }

    let refundProcessed = false;
    if (action === 'approve' && order.isPaid) {
      const refundAmount = round(targetItems.reduce(
        (sum, t) => sum + (t.item.totalPrice || 0),
        0,
      ));
      if (refundAmount > 0) {
        try {
          // item.totalPrice is in the ORDER currency; the seller's wallet is in
          // their settlement currency — convert with the order's own frozen FX
          // snapshots (never a live rate) and debit the matching wallet. It used
          // to debit the raw number from the USD wallet (PKR 28000 → $28000).
          const buyerCurrency = order.currency || 'USD';
          const settlementCurrency = sellerOrder.settlementCurrency ?? buyerCurrency;
          const sellerDebit = this.exchangeRateService.convertWithSnapshots(
            refundAmount, buyerCurrency, settlementCurrency, (order.fxSnapshots as any) ?? [],
          );
          // Seller-collected COD settled by a commission debit: the seller hands
          // the cash back by hand and the commission is credited back instead of
          // debiting the refund (see FinanceService.recordRefundForSellerOrder).
          await this.financeService.recordRefundForSellerOrder({
            order, sellerOrder, storeId, sellerId, orderId,
            refundedBuyerAmount: refundAmount,
            sellerOrderTotal: round((sellerOrder.items as any[]).reduce((sum: number, i: any) => sum + (i.totalPrice || 0), 0)),
            sellerDebitAmount: sellerDebit,
            refKey: `return-${orderId}-${targetItems.map((t) => t.item._id.toString()).sort().join(',')}`,
            currency: settlementCurrency,
            description: `Approved return — Order #${order.orderNumber ?? orderId}`,
            actorId: sellerId, actorRole: 'seller',
          });
          refundProcessed = true;
        } catch (e) {
          // The buyer has already been (or must be) refunded — a failed ledger
          // debit must never be swallowed silently.
          await this.activityLogService.log({
            storeId,
            category: 'finance',
            action: 'return_ledger_debit_failed',
            description: `Return on order #${orderId} approved but the seller ledger debit failed: ${e?.message}`,
            actorId: sellerId,
            actorRole: 'seller',
            isSecurityAlert: true,
            targetId: orderId,
            targetType: 'order',
          });
        }

        this.loyaltyService
          .clawbackPurchasePoints(storeId, order.userId, orderId, refundAmount)
          .catch(() => {});
      }
    }

    this.activityLogService.log({
      storeId,
      category: 'orders',
      action: action === 'approve' ? 'return_approved' : 'return_rejected',
      description: `Order #${orderId} — ${targetItems.length} item(s) return ${action === 'approve' ? 'approved' : 'rejected'}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
      ip,
      userAgent,
    });

    return {
      success: true,
      message:
        action === 'approve'
          ? `Return approved for ${targetItems.length} item(s)`
          : `Return rejected for ${targetItems.length} item(s)`,
      data: {
        orderId,
        action,
        processedItems: targetItems.length,
        refundProcessed,
      },
    };
  }


  // ───────────────────────── Digital delivery ─────────────────────────
  //
  // Every download path (signed-URL list, single link, token redeem, stamped
  // PDF with or without token) goes through resolveDigitalAccess(), so the
  // rules can't drift apart again. Previously the stamped-PDF path skipped
  // the download limit and link expiry entirely, token redemption skipped
  // expiry, and nothing checked whether the item had been cancelled/refunded.

  private static readonly DOWNLOAD_TOKEN_TTL = '10m';

  private async resolveDigitalAccess(
    userId: string,
    orderId: string,
    productId: string,
    fileIndex?: number,
  ) {
    if (!orderId) throw new BadRequestException('orderId is required');
    if (!productId) throw new BadRequestException('productId is required');
    const { orderModel, productModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid yet');

    let soIndex = -1;
    let itemIndex = -1;
    order.sellerOrders.forEach((so: any, si: number) => {
      so.items.forEach((it: any, ii: number) => {
        if (soIndex === -1 && it.productId === productId && it.type === 'digital') {
          soIndex = si;
          itemIndex = ii;
        }
      });
    });
    if (soIndex === -1)
      throw new BadRequestException('Digital product not found in this order');
    const item: any = order.sellerOrders[soIndex].items[itemIndex];

    // Refund / cancel revokes access — otherwise "buy, download, refund" keeps the file.
    if (['cancelled', 'refunded'].includes(item.status)) {
      throw new ForbiddenException('This item was cancelled or refunded — access has been revoked');
    }

    // A purchase stays downloadable even if the seller later deletes the
    // listing (standard on TPT/Gumroad/Udemy) — but not after an admin
    // takedown (policy/copyright), which is recorded separately.
    const product = await productModel.findOne({ _id: productId });
    if (!product || (product as any).removedByAdmin)
      throw new NotFoundException('This product is no longer available');
    const files = product.digital?.files ?? [];
    if (!files.length)
      throw new BadRequestException('No digital files found for this product');

    if (product.digital?.linkExpiryDays && order.paidAt) {
      const expiry = new Date(order.paidAt);
      expiry.setDate(expiry.getDate() + product.digital.linkExpiryDays);
      if (new Date() > expiry) {
        throw new BadRequestException(`Download access expired on ${expiry.toDateString()}`);
      }
    }

    const limitRaw = product.digital?.downloadLimit;
    const limit = limitRaw && limitRaw !== 'unlimited' ? parseInt(limitRaw, 10) : null;
    const used = item.downloadCount ?? 0;
    if (limit !== null && used >= limit) {
      throw new BadRequestException(`Download limit reached (${limit}/${limit})`);
    }

    let file: any = null;
    if (fileIndex !== undefined) {
      if (!Number.isInteger(fileIndex) || fileIndex < 0) throw new BadRequestException('Invalid file index');
      file = files[fileIndex];
      if (!file) throw new NotFoundException('File not found');
    }

    return { order, product, item, soIndex, itemIndex, limit, used, file, files };
  }

  /** Atomically counts one download. Always counts (even when unlimited) so
   *  refund eligibility can tell whether the buyer ever opened the file; the
   *  `$lt` filter makes the limit race-free under concurrent requests. */
  private async consumeDownload(
    orderId: string,
    soIndex: number,
    itemIndex: number,
    limit: number | null,
  ) {
    const path = `sellerOrders.${soIndex}.items.${itemIndex}.downloadCount`;
    const filter: any = { _id: orderId };
    if (limit !== null) filter[path] = { $lt: limit };
    const res = await this.databaseService.repositories.orderModel.updateOne(filter, {
      $inc: { [path]: 1 },
    });
    if (limit !== null && res.modifiedCount === 0) {
      throw new BadRequestException(`Download limit reached (${limit}/${limit})`);
    }
  }

  private signDownloadToken(userId: string, orderId: string, productId: string, fileIndex: number) {
    return this.jwtService.sign(
      { typ: 'download', userId, orderId, productId, fileIndex },
      {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: OrdersService.DOWNLOAD_TOKEN_TTL,
      },
    );
  }

  private verifyDownloadToken(token: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new BadRequestException('Download link expired or invalid');
    }
    // Refuse access/refresh tokens being replayed as download tokens.
    if (payload?.typ !== 'download') {
      throw new BadRequestException('Download link expired or invalid');
    }
    return payload as { userId: string; orderId: string; productId: string; fileIndex: number };
  }

  private isStampedPdf(product: any, file: any): boolean {
    const mime = this.uploadService.resolveMimeType(file.name, file.mimeType ?? 'application/octet-stream');
    return mime === 'application/pdf' && !!product.digital?.pdfStampingEnabled;
  }

  // signed download tokens for every file of a purchased product (does not count a download)
  async getDownloadUrls(userId: string, orderId: string, productId: string) {
    const { product, limit, used, files } = await this.resolveDigitalAccess(userId, orderId, productId);

    const result = files.map((file: any, index: number) => {
      const mimeType = this.uploadService.resolveMimeType(file.name, file.mimeType ?? 'application/octet-stream');
      const stamped = this.isStampedPdf(product, file);
      return {
        index,
        fileName: file.name,
        mimeType,
        size: file.size,
        type: stamped ? 'stamped' : 'download',
        endpoint: stamped ? '/api/orders/stream-pdf-token' : '/api/orders/download-file',
        token: this.signDownloadToken(userId, orderId, productId, index),
        expiresIn: '10 minutes',
      };
    });

    return {
      success: true,
      message: 'Download links generated',
      data: {
        files: result,
        downloadCount: used,
        downloadLimit: product.digital?.downloadLimit ?? 'unlimited',
        remaining: limit === null ? 'unlimited' : `${Math.max(limit - used, 0)} remaining`,
      },
    };
  }

  async getDownloadLink(userId: string, orderId: string, productId: string, fileIndex: number) {
    const { product, file } = await this.resolveDigitalAccess(userId, orderId, productId, fileIndex);
    const stamped = this.isStampedPdf(product, file);
    return {
      success: true,
      data: {
        token: this.signDownloadToken(userId, orderId, productId, fileIndex),
        endpoint: stamped ? '/api/orders/stream-pdf-token' : '/api/orders/download-file',
        fileName: file.name,
        expiresIn: '10 minutes',
      },
    };
  }

  /** Redeems a download token for a non-stamped file. Returns a stream so
   *  large lesson videos / zip bundles are never buffered in server memory. */
  async downloadByToken(token: string) {
    const { userId, orderId, productId, fileIndex } = this.verifyDownloadToken(token);
    const access = await this.resolveDigitalAccess(userId, orderId, productId, Number(fileIndex));
    const { product, file } = access;
    if (this.isStampedPdf(product, file)) {
      // Stamped PDFs must go through the stamping endpoint, never raw.
      throw new BadRequestException('Use the stamped PDF download endpoint for this file');
    }

    const mimeType = this.uploadService.resolveMimeType(file.name, file.mimeType ?? 'application/octet-stream');
    const resourceType = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('image/') ? 'image' : 'raw';
    const signedUrl = this.uploadService.generateSignedUrl(file.url, resourceType, 300);

    const response = await fetch(signedUrl);
    if (!response.ok || !response.body)
      throw new BadRequestException('Failed to fetch file from storage');

    await this.consumeDownload(orderId, access.soIndex, access.itemIndex, access.limit);

    const lengthHeader = response.headers.get('content-length');
    return {
      stream: Readable.fromWeb(response.body as any),
      fileName: file.name as string,
      mimeType,
      contentLength: lengthHeader ? Number(lengthHeader) : null,
    };
  }

  async streamStampedPdfByToken(token: string) {
    const { userId, orderId, productId, fileIndex } = this.verifyDownloadToken(token);
    return this.streamStampedPdf(userId, orderId, productId, Number(fileIndex));
  }

  async streamStampedPdf(userId: string, orderId: string, productId: string, fileIndex: number) {
    const access = await this.resolveDigitalAccess(userId, orderId, productId, fileIndex);
    const { order, file } = access;
    const mime = this.uploadService.resolveMimeType(file.name, file.mimeType ?? 'application/octet-stream');
    if (mime !== 'application/pdf') throw new BadRequestException('This file is not a PDF');

    const user = await this.databaseService.repositories.userModel
      .findOne({ _id: userId })
      .select('email')
      .lean();
    const userEmail = (user as any)?.email || userId;

    const stampedBuffer = await this.uploadService.stampPdf(file.url, userEmail, order.orderNumber);
    await this.consumeDownload(orderId, access.soIndex, access.itemIndex, access.limit);

    return { buffer: stampedBuffer, fileName: file.name as string, mimeType: 'application/pdf' };
  }

}
