import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { isValidObjectId } from 'mongoose';
import { isVerifiedPurchaseLine } from 'src/rating/verified-purchase.util';
import { DatabaseService } from 'src/database/databaseservice';
import { packageStatusesForTab, parseOrderAction, parseOrderTab, sellerOrdersActionFilter, sellerShipBy, shipByUrgencySort } from 'src/store-dashboard/action-items.util';
import { UploadService } from 'src/upload/upload.service';
import { ZIP_MAX_FILE_BYTES, ZIP_MAX_TOTAL_BYTES, buildZipStream, uniqueZipEntryNames, zipDownloadName } from './download-zip.util';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FinanceService, shippingCreditFor, feeItemsFor, cashMode } from 'src/finance/finance.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { isPackagePaid } from './package-paid.util';
import { cleanRefundEvidence, REFUND_REASON_CODES, reasonDisplayLabel } from 'src/refund-request/refund-evidence.util';
import { cleanFollowUpNote, cleanRejectReason, requiredPreviousFollowUp, trailEntry } from 'src/refund-request/return-trail.util';
import { buildReturnDetail } from './return-detail.util';
import { addressWarnings, findPossibleDuplicates, itemReturnFlags } from './order-warnings.util';
import { round } from 'src/common/number.util';
import { cleanTracking, isSelfDelivery } from './tracking.util';
import { PaymentService } from 'src/payment/payment.service';
import { orderStatusEmail, downloadLinkEmail } from 'src/notifications/templates/notification-email.template';

import {
  clampInt,
  escapeRegex,
  searchTerm,
} from 'src/common/query-safety.util';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import {
  buildReturnsStats, filterRows, isOverdue, normalizeStatus, respondBy, sortReturnsRows,
  type ReturnsListRow,
} from './seller-returns-all.util';
/** A sellerOrder's true payout basis for FinanceService.recordSale, in the
 *  SELLER'S OWN currency (so.settlementCurrency) â€” independent of what
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
    private readonly notificationsService: NotificationsService,
    private readonly paymentService: PaymentService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  private async awardLoyaltyPoints(
    storeId: string,
    userId: string,
    orderId: string,
    subtotal: number,
  ) {
    return this.loyaltyService.awardPurchasePoints(
      storeId,
      userId,
      orderId,
      subtotal,
      1,
    );
  }

  /** The buyer-facing shape of a page of Orders (my-orders, orders-by-checkout) â€” one batched seller lookup
   *  for the whole page. */
  private async toBuyerOrderViews(orders: any[]) {
    const { sellerModel } = this.databaseService.repositories;

    // Batch-resolve seller name + verification badge across every distinct
    // seller in this page â€” same one-query-instead-of-N pattern used on the
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
      isFreeClaim: !!order.isFreeClaim,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      taxAmount: order.taxAmount,
      subscriberDiscountTotal: order.subscriberDiscountTotal ?? 0,
      totalAmount: order.totalAmount,
      currency: order.currency,
      shippingAddress: order.shippingAddress,
      shippingEstimate: order.shippingEstimate ?? null,
      stores: (order.sellerOrders ?? []).map((so: any) => {
        const seller = sellerMap.get(so.sellerId?.toString());
        return {
          storeId: so.storeId,
          sellerOrderId: so._id,
          sellerId: so.sellerId,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          fulfillmentType: so.fulfillmentType,
          // Who ships this sub-order (snapshotted at order creation); orders placed before the
          // setting existed carry none and were seller-fulfilled.
          fulfillmentMode: so.fulfillmentMode ?? 'seller',
          codCollector: so.codCollector ?? null,
          // This store's own shipping line, in the order's currency (0 on digital sub-orders).
          shippingFee: so.shippingFee ?? 0,
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
            returnStatus: item.returnStatus ?? 'none',
            returnReason: item.returnReason ?? null,
            returnRejectReason: item.returnRejectReason ?? null,
            returnRequestedAt: item.returnRequestedAt ?? null,
            // Would a review of this line be accepted? Same rule as RatingService.addReview (paid +
            // delivered, or paid + not refunded for digital). Computed from the data already loaded here,
            // so it costs no extra query.
            canReview: isVerifiedPurchaseLine(order, item),
          })),
          tracking: so.tracking,
          trackingEvents: so.trackingEvents ?? [],
          shippedAt: so.shippedAt,
          deliveredAt: so.deliveredAt,
        };
      }),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    }));
    return list;
  }

  async getOrdersByUserId(userId: string, query: any) {
    const { orderModel } = this.databaseService.repositories;

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

    const list = await this.toBuyerOrderViews(orders);

    return {
      success: true,
      data: {
        pagination: { page, limit, totalPages, total },
        orders: list,
      },
    };
  }

  /**
   * "My Library": every digital resource the buyer owns, one row per product
   * (newest purchase wins), with the subject and grade so it can be searched
   * and grouped. Downloads still go through the per-order download flow.
   */
  async getMyLibrary(userId: string) {
    const { orderModel, productModel, categoryModel, storeModel } = this.databaseService.repositories;
    const orders: any[] = await orderModel
      .find({ userId, isDelete: false, 'sellerOrders.items.type': 'digital' })
      .sort({ createdAt: -1 })
      .limit(500)
      .select('orderNumber isPaid paymentStatus orderStatus createdAt paidAt sellerOrders')
      .lean();

    const seen = new Map<string, any>();
    for (const o of orders) {
      for (const so of o.sellerOrders ?? []) {
        for (const it of so.items ?? []) {
          if (it.type !== 'digital' || !it.productId) continue;
          if (['cancelled', 'refunded'].includes(it.status) || so.status === 'cancelled' || so.status === 'refunded') continue;
          if (seen.has(it.productId)) continue;
          seen.set(it.productId, {
            orderId: String(o._id), orderNumber: o.orderNumber, itemId: String(it._id), productId: it.productId,
            name: it.name, image: it.image ?? null, licenseType: it.licenseType ?? null, storeId: so.storeId,
            isPaid: !!o.isPaid, purchasedAt: o.createdAt, paidAt: o.paidAt ?? null, downloadCount: it.downloadCount ?? 0,
            reviewable: !!o.isPaid && (['delivered', 'completed'].includes(it.status) || ['delivered', 'completed'].includes(so.status) || o.orderStatus === 'completed'),
          });
        }
      }
    }
    const rows = [...seen.values()];
    const productIds = rows.map(r => r.productId).filter((id) => isValidObjectId(id));
    const products: any[] = productIds.length
      ? await productModel.find({ _id: { $in: productIds } }).select('slug categoryId subCategoryId educationLevel customLevel curricula ageMin ageMax digital.files digital.linkExpiryDays digital.downloadLimit removedByAdmin deliveryFormat').lean()
      : [];
    const productById = new Map(products.map(p => [String(p._id), p]));
    const catIds = [...new Set(products.flatMap(p => [p.categoryId, p.subCategoryId]).filter(Boolean))];
    const storeIds = [...new Set(rows.map(r => r.storeId).filter(Boolean))];
    const [cats, stores] = await Promise.all([
      catIds.length ? categoryModel.find({ _id: { $in: catIds } }).select('name').lean() : [],
      storeIds.length ? storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean() : [],
    ]);
    const catName = new Map((cats as any[]).map(c => [String(c._id), c.name]));
    const storeById = new Map((stores as any[]).map(s => [String(s._id), s]));

    const items = rows
      .map(r => {
        const p = productById.get(r.productId);
        // An admin takedown also ends access (see ProductsService / downloads) - kept in the list so the buyer sees why.
        const removed = !!p?.removedByAdmin || !p;
        let expiresAt: Date | null = null;
        if (p?.digital?.linkExpiryDays && r.paidAt) { expiresAt = new Date(r.paidAt); expiresAt.setDate(expiresAt.getDate() + p.digital.linkExpiryDays); }
        const expired = !!expiresAt && expiresAt.getTime() < Date.now();
        const store: any = storeById.get(String(r.storeId));
        return {
          ...r,
          slug: p?.slug ?? null,
          category: p?.categoryId ? catName.get(String(p.categoryId)) ?? null : null,
          subCategory: p?.subCategoryId ? catName.get(String(p.subCategoryId)) ?? null : null,
          educationLevel: p?.educationLevel ?? null,
          customLevel: p?.customLevel ?? null,
          curricula: p?.curricula ?? [],
          fileCount: p?.digital?.files?.length ?? 0,
          fileTypes: [...new Set(((p?.digital?.files ?? []) as any[]).map((f) => String(f?.name ?? '').split('.').pop()?.toLowerCase()).filter((e): e is string => !!e && e.length <= 5))],
          totalSize: ((p?.digital?.files ?? []) as any[]).reduce((s, f) => s + (Number(f?.size) || 0), 0),
          unavailable: removed ? 'removed' : expired ? 'expired' : null,
          expiresAt,
          deliveryFormat: p?.deliveryFormat ?? 'download',
          storeName: store?.name ?? null,
          storeSlug: store?.slug ?? null,
        };
      });
    return { success: true, data: { items } };
  }

  /** Every Order a checkout produced (a checkout yields up to two: digital + physical), in the same shape as
   *  my-orders. Buyer-owned only: another user's checkout is indistinguishable from a missing one (404). */
  async getOrdersByCheckout(userId: string, checkoutId: string) {
    if (typeof checkoutId !== 'string' || !isValidObjectId(checkoutId)) throw new NotFoundException('Checkout not found');
    const orders = await this.databaseService.repositories.orderModel
      .find({ checkoutId, userId, isDelete: false })
      .sort({ createdAt: 1 })
      .lean();
    if (orders.length === 0) throw new NotFoundException('Checkout not found');
    const list = await this.toBuyerOrderViews(orders);
    return {
      success: true,
      data: { pagination: { page: 1, limit: list.length, totalPages: 1, total: list.length }, orders: list },
    };
  }

  async getOrderById(userId: string, orderId: string) {
    if (typeof orderId !== 'string' || !isValidObjectId(orderId)) throw new NotFoundException('Order not found');
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
    // Store names and contact details for the order page and the invoice.
    const storeIds = [...new Set(orderSellerOrders.map((so: any) => so.storeId))].filter(Boolean);
    const stores = storeIds.length
      ? await this.databaseService.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name slug contactEmail contactPhone').lean()
      : [];
    const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

    const enrichedOrder = {
      ...order,
      shippingEstimate: (order as any).shippingEstimate ?? null,
      sellerOrders: orderSellerOrders.map((so: any) => {
        const seller = sellerMap.get(so.sellerId?.toString());
        const store: any = storeMap.get(String(so.storeId));
        return {
          ...so,
          items: (so.items ?? []).map((item: any) => ({ ...item, canReview: isVerifiedPurchaseLine(order as any, item) })),
          fulfillmentMode: so.fulfillmentMode ?? 'seller',
          // Per-package COD (multi-seller): paid state + the cash due for THIS package. Older orders: order-level only.
          packageIsPaid: so.isPaid === true,
          packagePaidAt: so.paidAt ?? null,
          codAmount: so.codAmount ?? 0,
          codCollector: so.codCollector ?? null,
          shippingFee: so.shippingFee ?? 0,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          storeName: store?.name ?? null,
          storeSlug: store?.slug ?? null,
          storeContactEmail: store?.contactEmail ?? null,
          storeContactPhone: store?.contactPhone ?? null,
        };
      }),
    };

    return {
      success: true,
      data: enrichedOrder,
    };
  }

  /** Who availed (claimed) this store's free products â€” one row per product per buyer, newest first.
   *  Free claims are not orders for the seller, so this is the only place they show up. */
  async getSellerFreeClaims(sellerId: string, storeId: string, query: any) {
    const { orderModel, storeModel, userModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const page = clampInt(query.page, 1, 1, 100000);
    const limit = Math.min(50, clampInt(query.limit, 20, 1, 100));
    const filter = { 'sellerOrders.storeId': storeId, isFreeClaim: true, isDelete: false };
    const [total, orders] = await Promise.all([
      orderModel.countDocuments(filter),
      orderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('userId createdAt sellerOrders').lean(),
    ]);
    const buyers = await userModel
      .find({ _id: { $in: [...new Set((orders as any[]).map((o: any) => String(o.userId)))].filter((id) => isValidObjectId(id)) } })
      .select('name email')
      .lean();
    const buyerById = new Map<string, any>((buyers as any[]).map((b: any) => [String(b._id), b]));

    const claims = (orders as any[]).flatMap((o: any) =>
      (o.sellerOrders ?? [])
        .filter((s: any) => String(s.storeId) === String(storeId))
        .flatMap((s: any) =>
          (s.items ?? []).map((i: any) => ({
            orderId: String(o._id),
            productId: i.productId ? String(i.productId) : null,
            productName: i.name,
            buyerName: buyerById.get(String(o.userId))?.name ?? 'Buyer',
            buyerEmail: buyerById.get(String(o.userId))?.email ?? null,
            claimedAt: o.createdAt,
          })),
        ),
    );
    return { success: true, data: { claims, total, page, totalPages: Math.ceil(total / limit) } };
  }

  /** `storeId` omitted (null) means "every store this seller owns" â€” used by the
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

    // base filter â€” orders touching any of the scoped store(s)
    const matchFilter: any = {
      'sellerOrders.storeId': { $in: storeIds },
      isDelete: false,
      isFreeClaim: { $ne: true },
    };

    // ?tab= (seller Orders page): status is matched on THIS store's package, in one $elemMatch with the type filter.
    const tab = parseOrderTab(query.tab);
    if (tab === 'invalid') throw new BadRequestException('Invalid tab');
    const typeFilter = query.type && query.type !== 'all' ? String(query.type) : null;
    const tabElem: any = { storeId: { $in: storeIds } };
    if (typeFilter) tabElem.fulfillmentType = typeFilter;
    if (tab) {
      const st = packageStatusesForTab(tab);
      matchFilter.sellerOrders = { $elemMatch: st ? { ...tabElem, status: { $in: st } } : tabElem };
    } else {
      if (typeFilter) {
        matchFilter['sellerOrders.fulfillmentType'] = typeFilter;
      }
      if (query.status && query.status !== 'all') {
        matchFilter['sellerOrders.status'] = query.status;
      }
    }
    // ?buyer=<userId> (seller Customers panel "View all"): store-scoped by the base filter above, read-only.
    const buyerFilter = typeof query.buyer === 'string' ? query.buyer.trim() : '';
    if (buyerFilter) {
      if (!isValidObjectId(buyerFilter)) throw new BadRequestException('Invalid buyer');
      matchFilter.userId = buyerFilter;
    }
    // ?action=toship|overdue — the dashboard "Action required" lists (same predicate as its counts).
    const actionKind = parseOrderAction(query.action);
    if (actionKind) {
      const { $and } = sellerOrdersActionFilter(storeIds, actionKind);
      matchFilter.$and = $and;
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

    // ?q= â€” order number, buyer name/email, or one of THIS store's item names
    // (case-insensitive, regex-escaped). Buyer lookup is limited to people
    // who actually ordered from the scoped store(s).
    const q = searchTerm(query.q);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const buyerIds = await orderModel.distinct('userId', {
        'sellerOrders.storeId': { $in: storeIds },
        isDelete: false,
      });
      const matchedBuyers = buyerIds.length
        ? await userModel
            .find({
              _id: { $in: buyerIds.filter((id: any) => isValidObjectId(id)) },
              $or: [{ name: rx }, { email: rx }],
            })
            .select('_id')
            .lean()
        : [];
      matchFilter.$or = [
        { orderNumber: rx },
        {
          sellerOrders: {
            $elemMatch: { storeId: { $in: storeIds }, 'items.name': rx },
          },
        },
        { userId: { $in: matchedBuyers.map((u: any) => u._id.toString()) } },
      ];
    }

    const totalOrders = await orderModel.countDocuments(matchFilter);
    const totalPages = Math.ceil(totalOrders / limit);

    // Needs action: most urgent ship-by first, decided in Mongo so paging stays correct.
    const orders =
      tab === 'needs_action'
        ? await orderModel.aggregate([
            { $match: matchFilter },
            ...shipByUrgencySort(storeIds),
            { $skip: skip },
            { $limit: limit },
          ])
        : await orderModel
            .find(matchFilter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

    // Per-tab counts (same type/search/time scope as the list) + the dashboard's to-ship / overdue numbers.
    let counts: Record<string, number> | undefined;
    if (tab) {
      const { $and: _action, sellerOrders: _tabPart, ...scope } = matchFilter;
      const countMatch = { ...scope, sellerOrders: { $elemMatch: tabElem } };
      const [byStatus, toShip, overdue] = await Promise.all([
        orderModel.aggregate([
          { $match: countMatch },
          { $project: { _st: { $arrayElemAt: [{ $map: { input: { $filter: { input: '$sellerOrders', cond: { $in: ['$$this.storeId', storeIds] } } }, in: '$$this.status' } }, 0] } } },
          { $group: { _id: '$_st', n: { $sum: 1 } } },
        ]),
        orderModel.countDocuments({ 'sellerOrders.storeId': { $in: storeIds }, ...sellerOrdersActionFilter(storeIds, 'toship') }),
        orderModel.countDocuments({ 'sellerOrders.storeId': { $in: storeIds }, ...sellerOrdersActionFilter(storeIds, 'overdue') }),
      ]);
      const n = (s: string) => byStatus.find((r: any) => r._id === s)?.n ?? 0;
      counts = {
        needs_action: n('pending') + n('processing'),
        shipped: n('shipped'),
        delivered: n('delivered'),
        completed: n('completed'),
        cancelled: n('cancelled'),
        all: byStatus.reduce((sum: number, r: any) => sum + (r.n ?? 0), 0),
        toShip,
        overdue,
      };
    }

    // stats â€” all orders across the scoped store(s) (no pagination)
    const allOrders = await orderModel
      .find({ 'sellerOrders.storeId': { $in: storeIds }, isDelete: false, isFreeClaim: { $ne: true } })
      .lean();

    // Definitions (shared with Customers/Analytics): ORDER VALUE = every non-cancelled order;
    // PAID REVENUE = the part of it that is actually paid (and not refunded).
    let totalRevenue = 0;
    let paidRevenue = 0;
    let countedOrders = 0;
    let pendingCount = 0;

    for (const order of allOrders) {
      const so = (order.sellerOrders as any[]).find((s: any) =>
        storeIds.includes(s.storeId),
      );
      if (!so) continue;
      if (so.status !== 'cancelled') {
        totalRevenue += so.subtotal || 0;
        countedOrders++;
        if ((order.isPaid || so.isPaid === true) && so.status !== 'refunded') paidRevenue += so.subtotal || 0;
      }
      if (['pending', 'processing'].includes(so.status)) {
        pendingCount++;
      }
    }

    const avgOrder = countedOrders > 0 ? totalRevenue / countedOrders : 0;

    // Possible-duplicate chips for this page: ONE bounded query, never per row.
    const dupMap = await findPossibleDuplicates(orderModel, orders, (o: any) =>
      (o.sellerOrders ?? []).find((s: any) => storeIds.includes(s.storeId))?.storeId ?? null,
    );

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
          // Number of lines in this store's package (web shows "×N" when > 1).
          itemCount: so.items?.length ?? 0,
          type: so.fulfillmentType,
          // Who ships this sub-order, so the seller app can hide status controls on Edudeen-fulfilled
          // rows instead of discovering it from a 403 (missing = seller-fulfilled).
          fulfillmentMode: so.fulfillmentMode ?? 'seller',
          productType: firstItem?.productType ?? null,
          date: order.createdAt,
          amount: so.subtotal,
          // `amount` above is so.subtotal, which is denominated in the order's
          // own currency (fixed per store) â€” carried per-row so a cross-store
          // "my orders" list can label each row correctly even when the
          // seller's stores don't all share one currency.
          currency: order.currency ?? 'USD',
          status: so.status,
          cancelReason: so.cancelReason ?? null,
          // This seller's own package paid state wins on a multi-seller COD order.
          isPaid: order.isPaid || so.isPaid === true,
          codAmount: so.codAmount ?? 0,
          codCollector: so.codCollector ?? null,
          paymentType: order.paymentType,
          // Ship-by = payment time (COD: order creation) + DISPATCH_HOURS; null when nothing is waiting to ship.
          shipBy: sellerShipBy(order, so)?.toISOString() ?? null,
          possibleDuplicate: dupMap.get(String(order._id)) ?? null,
        };
      }),
    );

    return {
      success: true,
      data: {
        ...(counts ? { counts } : {}),
        stats: {
          totalOrders,
          revenue: totalRevenue,
          orderValue: totalRevenue,
          paidRevenue,
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

  /** One order as the selling store sees it: only that store's sellerOrder
   *  (items, tracking, totals), plus the buyer's contact and shipping address.
   *  403 when the store isn't the seller's, 404 when the order has no part for it. */
  async getSellerOrderDetail(sellerId: string, storeId: string, orderId: string) {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;

    if (!isValidObjectId(storeId) || !isValidObjectId(orderId))
      throw new NotFoundException('Order not found');

    const store = await storeModel
      .findOne({ _id: storeId, sellerId, isDelete: false })
      .select('_id')
      .lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order: any = await orderModel
      .findOne({ _id: orderId, isDelete: false, 'sellerOrders.storeId': storeId })
      .lean();
    const so = order?.sellerOrders?.find((s: any) => s.storeId === storeId);
    if (!order || !so) throw new NotFoundException('Order not found');

    const user: any = await userModel
      .findOne({ _id: order.userId })
      .select('name email phone')
      .lean();

    // Show the SKU snapshotted on the order at checkout (same value the buyer's invoice shows); the variant's live SKU is only a fallback for old orders without one.
    const variantIds = (so.items ?? []).map((it: any) => it.variantId).filter((id: any) => id && isValidObjectId(id));
    const liveSkus = new Map<string, string>();
    if (variantIds.length) {
      const vs: any[] = await this.databaseService.repositories.productVariantModel.find({ _id: { $in: variantIds } }).select('sku').lean();
      for (const v of vs) if (v.sku) liveSkus.set(v._id.toString(), v.sku);
    }

    // Warnings are computed here, never stored; they only inform the seller.
    const dupMap = await findPossibleDuplicates(orderModel, [order], () => storeId);
    const needsAddress = so.fulfillmentType === 'physical' || so.fulfillmentType === 'mixed';

    // Money breakdown: stored values only, nothing recalculated. Gift orders and free claims show no prices.
    // Gift wrap is folded into this package's shipping line at checkout (not stored apart), so it is not listed separately.
    const pricesHidden = !!(order.giftWrap || order.giftMessage) || order.isFreeClaim === true;
    let earnings: { amount: number; currency: string } | null = null;
    if (!pricesHidden) {
      try {
        const saleTx: any = await this.databaseService.repositories.transactionModel
          .findOne({ storeId, referenceId: String(order._id), referenceType: 'order', type: 'sale' })
          .select('metadata.netAmount currency')
          .lean();
        const net = saleTx?.metadata?.netAmount;
        if (typeof net === 'number' && Number.isFinite(net)) earnings = { amount: net, currency: saleTx.currency ?? 'USD' };
      } catch { earnings = null; }
    }
    const amounts = pricesHidden
      ? { pricesHidden: true, currency: order.currency ?? 'USD' }
      : {
          pricesHidden: false,
          currency: order.currency ?? 'USD',
          itemsSubtotal: so.subtotal ?? 0,
          deliveryCharge: so.shippingFee ?? 0,
          buyerPays: (so.subtotal ?? 0) + (so.shippingFee ?? 0),
          earnings,
        };

    return {
      success: true,
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        date: order.createdAt,
        currency: order.currency ?? 'USD',
        amounts,
        warnings: {
          possibleDuplicate: dupMap.get(String(order._id)) ?? null,
          address: needsAddress ? addressWarnings(order.shippingAddress, user?.phone) : [],
        },
        returnStatus: so.returnStatus ?? 'none',
        isPaid: order.isPaid || so.isPaid === true,
        codAmount: so.codAmount ?? 0,
        codCollector: so.codCollector ?? null,
        paymentType: order.paymentType,
        customer: {
          name: user?.name || 'Unknown',
          email: user?.email || '',
          phone: user?.phone || null,
        },
        shippingAddress: order.shippingAddress ?? null,
        status: so.status,
        cancelReason: so.cancelReason ?? null,
        cancelledAt: so.cancelledAt ?? null,
        type: so.fulfillmentType,
        subtotal: so.subtotal,
        tracking: so.tracking ?? null,
        shipment: so.shipment ?? null,
        shippingCourier: so.shippingCourier ?? null,
        giftMessage: order.giftMessage ?? null,
        giftWrap: !!order.giftWrap,
        trackingEvents: so.trackingEvents ?? [],
        shippedAt: so.shippedAt ?? null,
        deliveredAt: so.deliveredAt ?? null,
        items: (so.items ?? []).map((it: any) => ({
          productId: it.productId,
          variantId: it.variantId ?? null,
          name: it.name,
          image: it.image ?? null,
          sku: it.sku || (it.variantId && liveSkus.get(String(it.variantId))) || null,
          type: it.type,
          productType: it.productType ?? null,
          options: it.options ?? [],
          licenseType: it.licenseType ?? null,
          quantity: it.quantity,
          price: it.price,
          totalPrice: it.totalPrice,
          status: it.status ?? null,
          cancelReason: it.cancelReason ?? null,
          ...itemReturnFlags(it),
        })),
      },
    };
  }

  /** Print data for up to 50 of this store's orders (packing slips / invoices). READ-ONLY.
   *  Same fields the seller already sees in the order detail, minus the advisory warnings.
   *  Any id that is not an order of this store makes the whole request 404 (no hint which).
   *  Gift orders (gift wrap or message) carry NO prices: the parcel may go to someone else. */
  async getSellerOrdersForPrint(sellerId: string, storeId: string, idsRaw: unknown) {
    const { orderModel, storeModel, userModel, productVariantModel } = this.databaseService.repositories;

    const ids = Array.from(new Set(String(idsRaw ?? '').split(',').map(s => s.trim()).filter(Boolean)));
    if (ids.length === 0) throw new BadRequestException('ids is required');
    if (ids.length > 50) throw new BadRequestException('You can print at most 50 orders at a time');
    if (ids.some(id => !isValidObjectId(id))) throw new BadRequestException('ids must be valid order ids');

    const store: any = await storeModel
      .findOne({ _id: storeId, sellerId, isDelete: false })
      .select('name logo')
      .lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const orders: any[] = await orderModel
      .find({ _id: { $in: ids }, isDelete: false, 'sellerOrders.storeId': storeId })
      .lean();
    if (orders.length !== ids.length) throw new NotFoundException('Order not found');

    const userIds = Array.from(new Set(orders.map(o => String(o.userId)).filter(isValidObjectId)));
    const users: any[] = userIds.length ? await userModel.find({ _id: { $in: userIds } }).select('name phone').lean() : [];
    const userById = new Map(users.map(u => [String(u._id), u]));

    const variantIds = orders.flatMap(o => (o.sellerOrders.find((s: any) => s.storeId === storeId)?.items ?? []))
      .map((it: any) => it.variantId).filter((v: any) => v && isValidObjectId(v));
    const liveSkus = new Map<string, string>();
    if (variantIds.length) {
      const vs: any[] = await productVariantModel.find({ _id: { $in: variantIds } }).select('sku').lean();
      for (const v of vs) if (v.sku) liveSkus.set(String(v._id), v.sku);
    }

    const byId = new Map(orders.map(o => [String(o._id), o]));
    const rows = ids.map(id => {
      const order = byId.get(id);
      const so = order.sellerOrders.find((s: any) => s.storeId === storeId);
      const user = userById.get(String(order.userId));
      const isGift = !!(order.giftWrap || order.giftMessage);
      const needsAddress = so.fulfillmentType === 'physical' || so.fulfillmentType === 'mixed';
      return {
        orderId: order._id,
        orderNumber: order.orderNumber,
        date: order.createdAt,
        currency: order.currency ?? 'USD',
        type: so.fulfillmentType,
        status: so.status,
        isGift,
        pricesHidden: isGift,
        giftMessage: order.giftMessage ?? null,
        giftWrap: !!order.giftWrap,
        paymentType: order.paymentType,
        isPaid: order.isPaid || so.isPaid === true,
        codAmount: isGift ? null : (so.codAmount ?? 0),
        subtotal: isGift ? null : so.subtotal,
        shippingFee: isGift ? null : (so.shippingFee ?? 0),
        customer: { name: user?.name || 'Unknown', phone: user?.phone || null },
        shippingAddress: needsAddress ? (order.shippingAddress ?? null) : null,
        items: (so.items ?? []).map((it: any) => ({
          name: it.name,
          sku: it.sku || (it.variantId && liveSkus.get(String(it.variantId))) || null,
          type: it.type,
          options: it.options ?? [],
          licenseType: it.licenseType ?? null,
          quantity: it.quantity,
          price: isGift ? null : it.price,
          totalPrice: isGift ? null : it.totalPrice,
          status: it.status ?? null,
        })),
      };
    });

    return { success: true, data: { store: { name: store.name, logo: store.logo ?? null }, orders: rows } };
  }

  async updateSellerOrderStatus(
    sellerId: string,
    body: any,
    ip?: string,
    userAgent?: string,
    actorRole: string = 'seller',
  ) {
    const { orderId, storeId, status } = body;
    const isAdmin = actorRole === 'admin';

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

    // store ownership check (an admin acts on any store, but only where the platform fulfills â€” see below)
    const store = await storeModel.findOne({
      _id: storeId,
      ...(isAdmin ? {} : { sellerId }),
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrderIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId && (isAdmin || so.sellerId === sellerId),
    );
    if (sellerOrderIndex === -1) throw new ForbiddenException('Unauthorized');

    // Who may move a sub-order through shipped/delivered is fixed by the mode
    // snapshotted on it at order creation: the seller where the seller ships
    // (every pre-existing order), an admin only where the platform ships.
    // Digital sub-orders ship nothing and stay seller-managed.
    const target = order.sellerOrders[sellerOrderIndex] as any;
    const platformFulfilled = target.fulfillmentType === 'physical' && target.fulfillmentMode === 'platform';
    if (isAdmin && !platformFulfilled) {
      throw new ForbiddenException('This sub-order is fulfilled by the seller â€” only the seller can update its status');
    }
    if (!isAdmin && platformFulfilled) {
      throw new ForbiddenException('This sub-order is fulfilled by Edudeen â€” its shipping status and tracking are handled by the Edudeen team');
    }

    // Guards against double-crediting the finance ledger if this sellerOrder was already
    // completed before this call (duplicate/retried request, double-click, etc.) â€” mirrors
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
      throw new BadRequestException(`Order is already ${currentStatus} â€” it can't go back to ${status}`);
    }
    // Completing credits the seller's ledger, so the buyer must have paid.
    // A COD order is completed via "Mark Paid" once the cash is collected.
    if (status === 'completed' && !order.isPaid && (order.sellerOrders[sellerOrderIndex] as any).isPaid !== true) {
      throw new BadRequestException('Mark this order as paid before completing it');
    }

    // Courier carriers need a tracking number; "I deliver myself" does not (see tracking.util.ts).
    const tracking = status === 'shipped' ? cleanTracking(body.tracking) : null;
    const viaSelf = !!tracking && isSelfDelivery(tracking.carrier);

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

    // Record sale in finance ledger when seller marks their order completed â€” only on the
    // transition into `completed`, never again if it was already completed (see guard above).
    if (status === 'completed' && !wasAlreadyCompleted) {
      const so = order.sellerOrders[sellerOrderIndex];
      // A Connect-settled sellerOrder's money already went straight to the
      // seller's own Stripe-connected account at payment time â€” crediting
      // the internal ledger here too would let them draw a second, duplicate
      // payout through the platform's own payout-request flow. See
      // PaymentService.initiatePayment/SellerOrder.settledViaConnect.
      if (!so.settledViaConnect) {
        const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
        const sponsoredCampaignId =
          so.items.find((i: any) => i.campaignSponsorType === 'platform')
            ?.campaignId ?? null;
        // Durable: a failure leaves a pending sale_credit_jobs row (retried by cron, alerts admins).
        await this.financeService.recordSaleDurable({
          storeId: so.storeId,
          sellerId: so.sellerId,
          orderId,
          saleAmount: sellerPayoutBasis(so),
          description: `Sale â€” Order #${orderId}`,
          platformSponsoredUSD,
          campaignId: sponsoredCampaignId,
          currency: sellerPayoutCurrency(so, order),
          paymentMethodType: order.paymentType,
          fulfillmentMode: cashMode(so),
          shippingCredit: shippingCreditFor(order, so),
          feeItems: feeItemsFor(so),
          fxSnapshots: (order.fxSnapshots as any) ?? [],
        });
      }

      this.awardLoyaltyPoints(
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
        ? `Order #${orderId} â€” shipped via ${tracking.carrier ?? tracking}`
        : `Order #${orderId} â€” status changed to ${status}`,
      actorId: sellerId,
      actorRole: isAdmin ? 'admin' : 'seller',
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
              ? `Order #${order.orderNumber ?? orderId} is on its way${viaSelf ? ' - the seller is delivering it themselves' : tracking?.carrier ? ` via ${tracking.carrier}` : ''}${viaSelf && tracking?.expectedDeliveryDate ? `. Expected by ${tracking.expectedDeliveryDate.toISOString().slice(0, 10)}` : ''}.`
              : `Order #${order.orderNumber ?? orderId} has been delivered.`,
          data: { orderId, orderNumber: order.orderNumber, status, link: `/account/orders/${orderId}` },
          email: orderStatusEmail(order.orderNumber ?? orderId, status, tracking ? { ...tracking, trackingNumber: tracking.trackingNumber ?? undefined, trackingUrl: tracking.trackingUrl ?? undefined, expectedDeliveryDate: tracking.expectedDeliveryDate?.toISOString().slice(0, 10), note: tracking.note ?? undefined } : null),
          channelEvent: {
            event: status === 'shipped' ? 'order_shipped' : 'order_delivered',
            vars: {
              orderNumber: String(order.orderNumber ?? orderId),
              carrier: viaSelf ? 'the seller (own delivery)' : String(tracking?.carrier ?? 'Courier'),
              trackingNumber: tracking?.trackingNumber || 'not applicable',
            },
            fallbackPhone: order.shippingAddress?.phoneNumber ?? null,
          },
        })
        .catch(() => {});
    }

    return { success: true, message: `Order status updated to ${status}` };
  }

  async markPaid(orderId: string, actor: { userId: string; role: string }, storeId?: string) {
    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.isPaid) throw new BadRequestException('Order is already paid');

    // Several sellers on one COD order: every package is collected and confirmed on its own.
    if (order.paymentType === 'cash_on_delivery' && order.sellerOrders.length > 1) {
      return this.markPackagePaid(order, actor, storeId);
    }

    // A seller may only confirm payment on an order made up entirely of their
    // own sub-orders â€” marking paid credits every seller in the order's
    // ledger, so one seller must never be able to do it for another's sale.
    // A multi-store order has to be confirmed by an admin.
    // Cash collected by Edudeen's own couriers (fulfillmentMode 'platform') is
    // confirmed by the Edudeen team only â€” a seller must never be able to book
    // a credit for money the platform has not yet received.
    if (actor.role !== 'admin' && order.sellerOrders.some((so: any) => cashMode(so) === 'platform')) {
      throw new ForbiddenException('Payment on Edudeen-collected orders is confirmed by the Edudeen team');
    }
    if (actor.role !== 'admin') {
      const ownsAll =
        order.sellerOrders.length > 0 &&
        order.sellerOrders.every((so: any) => so.sellerId === actor.userId);
      if (!ownsAll) {
        throw new ForbiddenException('You can only mark your own orders as paid');
      }
    }

    // Only money collected offline is confirmed by hand â€” a Stripe charge is
    // confirmed by Stripe itself, and a bank transfer goes through the admin
    // proof-review flow (manual-payments), so a seller only confirms COD.
    if (order.paymentType === 'stripe') {
      throw new BadRequestException('Card payments are confirmed automatically');
    }
    if (actor.role !== 'admin' && order.paymentType !== 'cash_on_delivery') {
      throw new ForbiddenException('Bank transfers are confirmed by the Edudeen team after reviewing the payment proof');
    }

    // Even an admin cannot book a bank-transfer sale without an approved payment proof for this order (money must be seen).
    if (actor.role === 'admin' && /bank/i.test(String(order.paymentType ?? ''))) {
      const approved = await this.databaseService.repositories.manualPaymentProofModel.exists({ orderIds: orderId, status: 'approved' });
      if (!approved) throw new BadRequestException('A bank-transfer order can only be marked paid after its payment proof is approved (Admin -> Payment proofs)');
    }

    // Cash can only have been collected once the parcel is on its way / handed over.
    if (actor.role !== 'admin') {
      const live = order.sellerOrders.filter((so: any) => so.status !== 'cancelled' && so.status !== 'refunded');
      if (live.length === 0 || !live.every((so: any) => so.status === 'shipped' || so.status === 'delivered')) {
        throw new BadRequestException('Cash can only be marked as collected after the order is shipped or delivered');
      }
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

    // Atomic isPaid:false guard â€” two concurrent calls (double-click, retry)
    // must not both get past the check above and double-credit the ledger.
    const claimed = await orderModel.findOneAndUpdate(
      { _id: orderId, isPaid: { $ne: true }, isDelete: false },
      { $set: updateData },
    );
    if (!claimed) throw new BadRequestException('Order is already paid');

    // Record sale in finance ledger for each store's sub-order â€” skipping
    // any that settled directly via Stripe Connect (see the same guard/
    // comment in the status-transition branch above).
    let creditStatus: 'credited' | 'pending' = 'credited';
    for (const so of order.sellerOrders) {
      if (so.settledViaConnect) continue;
      const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
      const sponsoredCampaignId =
        so.items.find((i: any) => i.campaignSponsorType === 'platform')
          ?.campaignId ?? null;
      const credit = await this.financeService.recordSaleDurable({
        storeId: so.storeId,
        sellerId: so.sellerId,
        orderId,
        saleAmount: sellerPayoutBasis(so),
        description: `Sale â€” Order #${orderId}`,
        platformSponsoredUSD,
        campaignId: sponsoredCampaignId,
        currency: sellerPayoutCurrency(so, order),
        paymentMethodType: order.paymentType,
        fulfillmentMode: cashMode(so),
        shippingCredit: shippingCreditFor(order, so),
        feeItems: feeItemsFor(so),
        fxSnapshots: (order.fxSnapshots as any) ?? [],
      });
      if (credit?.creditStatus === 'pending') creditStatus = 'pending';

      this.awardLoyaltyPoints(
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
        body: `We've received your payment for order #${order.orderNumber ?? orderId}.`,
        data: { orderId, orderNumber: order.orderNumber, link: `/account/orders/${orderId}` },
      })
      .catch(() => {});

    return { success: true, message: 'Order marked as paid', creditStatus };
  }

  /**
   * COD on a multi-seller order: marks ONE package (sellerOrder) as cash-collected and credits only that store.
   * The order itself becomes 'partially_paid' until every live package is paid, then 'paid'.
   * A seller may confirm only their own package (and only once it is shipped/delivered); a package fulfilled by
   * Edudeen ('platform') is confirmed by an admin only.
   */
  private async markPackagePaid(order: any, actor: { userId: string; role: string }, storeId?: string) {
    const { orderModel } = this.databaseService.repositories;
    const orderId = String(order._id);
    if (!storeId) throw new BadRequestException('storeId is required: say which seller package the cash was collected for');
    const idx = order.sellerOrders.findIndex((so: any) => so.storeId === storeId);
    if (idx === -1) throw new NotFoundException('That seller is not part of this order');
    const so = order.sellerOrders[idx];
    const isAdmin = actor.role === 'admin';
    if (!isAdmin && so.sellerId !== actor.userId) throw new ForbiddenException('You can only mark your own packages as paid');
    if (!isAdmin && cashMode(so) === 'platform') {
      throw new ForbiddenException('Payment on Edudeen-collected orders is confirmed by the Edudeen team');
    }
    if (so.isPaid) throw new BadRequestException('This package is already marked as paid');
    if (so.status === 'cancelled' || so.status === 'refunded') throw new BadRequestException('This package was cancelled');
    if (!isAdmin && so.status !== 'shipped' && so.status !== 'delivered') {
      throw new BadRequestException('Cash can only be marked as collected after the package is shipped or delivered');
    }

    const now = new Date();
    const set: any = {
      [`sellerOrders.${idx}.isPaid`]: true,
      [`sellerOrders.${idx}.paidAt`]: now,
      [`sellerOrders.${idx}.status`]: 'completed',
      [`sellerOrders.${idx}.deliveredAt`]: now,
    };
    so.items.forEach((_: any, itemIndex: number) => {
      set[`sellerOrders.${idx}.items.${itemIndex}.status`] = 'completed';
    });
    // Atomic: two concurrent calls for the same package must not both credit the ledger.
    const claimed = await orderModel.findOneAndUpdate(
      {
        _id: orderId,
        isDelete: false,
        sellerOrders: { $elemMatch: { storeId, isPaid: { $ne: true }, status: { $nin: ['cancelled', 'refunded'] } } },
      },
      { $set: set },
    );
    if (!claimed) throw new BadRequestException('This package is already marked as paid');

    // The package's own COD payment row (written per package at checkout when the order has 2+ packages).
    try {
      await this.databaseService.repositories.paymentTransactionModel.updateOne(
        { orderIds: orderId, paymentType: 'cash_on_delivery', storeId, status: 'pending', isDelete: false },
        { $set: { status: 'completed', paidAt: now } },
      );
    } catch { /* bookkeeping only - the sale itself is already claimed and credited below */ }

    let creditStatus: 'credited' | 'pending' = 'credited';
    if (!so.settledViaConnect) {
      const sponsoredCampaignId = so.items.find((i: any) => i.campaignSponsorType === 'platform')?.campaignId ?? null;
      const credit = await this.financeService.recordSaleDurable({
        storeId: so.storeId,
        sellerId: so.sellerId,
        orderId,
        saleAmount: sellerPayoutBasis(so),
        description: `Sale â€” Order #${orderId}`,
        platformSponsoredUSD: so.platformSponsoredDiscountUSD ?? 0,
        campaignId: sponsoredCampaignId,
        currency: sellerPayoutCurrency(so, order),
        paymentMethodType: order.paymentType,
        fulfillmentMode: cashMode(so),
        shippingCredit: shippingCreditFor(order, so),
        feeItems: feeItemsFor(so),
        fxSnapshots: (order.fxSnapshots as any) ?? [],
      });
      if (credit?.creditStatus === 'pending') creditStatus = 'pending';
    }
    this.awardLoyaltyPoints(so.storeId, order.userId, orderId, so.subtotal).catch(() => {});

    // Roll the packages up into the order: paid once every live package is paid, otherwise partially paid.
    const fresh: any = await orderModel.findById(orderId).lean();
    const live = (fresh?.sellerOrders ?? []).filter((p: any) => p.status !== 'cancelled' && p.status !== 'refunded');
    const allPaid = live.length > 0 && live.every((p: any) => p.isPaid === true);
    await orderModel.updateOne(
      { _id: orderId },
      allPaid
        ? { $set: { isPaid: true, paymentStatus: 'paid', paidAt: now, orderStatus: live.every((p: any) => p.status === 'completed') ? 'completed' : fresh.orderStatus } }
        : { $set: { paymentStatus: 'partially_paid' } },
    );

    this.notificationsService
      .notify({
        recipientId: order.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.PAYMENT_SUCCESS,
        title: 'Payment received',
        body: `We've received your cash payment for a package of order #${order.orderNumber ?? orderId}.`,
        data: { orderId, orderNumber: order.orderNumber, link: `/account/orders/${orderId}` },
      })
      .catch(() => {});

    return { success: true, message: allPaid ? 'Order marked as paid' : 'Package marked as paid', creditStatus, orderPaid: allPaid };
  }

  /**
   * Cancels items of an order that has not shipped yet. Default actor = the buyer (own order, any items).
   * `actor` seller = only THEIR store's items (body.storeId, ownership checked); `actor` admin = any items.
   * Refund / stock / gift-card handling is the same single code path for all three.
   */
  async cancelOrder(userId: string, orderId: string, body: any, actor?: { role: 'seller' | 'admin' }) {
    const { reason, itemIds } = body ?? {};
    if (!reason || typeof reason !== 'string' || !reason.trim()) throw new BadRequestException('reason is required');
    const cancelledBy: 'buyer' | 'seller' | 'admin' = actor?.role ?? 'buyer';

    const { orderModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    let ownStoreId: string | null = null;
    if (actor?.role === 'seller') {
      ownStoreId = typeof body?.storeId === 'string' ? body.storeId : null;
      if (!ownStoreId) throw new BadRequestException('storeId is required');
      const store = await storeModel.findOne({ _id: ownStoreId, sellerId: userId, isDelete: false }).select('_id').lean();
      if (!store) throw new ForbiddenException('Store not found or unauthorized');
    }

    const order = await orderModel.findOne(
      actor ? { _id: orderId, isDelete: false } : { _id: orderId, userId, isDelete: false },
    );
    if (!order) throw new NotFoundException('Order not found');
    if (ownStoreId && !order.sellerOrders.some((so: any) => String(so.storeId) === ownStoreId)) {
      throw new NotFoundException('Order not found');
    }

    if (order.orderStatus === 'completed')
      throw new BadRequestException('Completed orders cannot be cancelled');
    if (order.orderStatus === 'cancelled')
      throw new BadRequestException('Order is already cancelled');

    const now = new Date();
    const BLOCKED = ['shipped', 'delivered', 'completed', 'cancelled'];

    // flatten all items with their indices
    const allItems: { soIndex: number; itemIndex: number; item: any }[] = [];
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      if (ownStoreId && String(so.storeId) !== ownStoreId) return; // a seller only touches their own package
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
            `Item "${found.item.name}" cannot be cancelled â€” status: ${found.item.status}`,
          );
        targetItems.push(found);
      }
    } else {
      // full order cancel â€” koi bhi item shipped nahi honi chahiye
      const blockedItem = allItems.find(({ item }) =>
        BLOCKED.slice(0, 3).includes(item.status),
      );
      if (blockedItem)
        throw new BadRequestException(
          `Cannot cancel order â€” "${blockedItem.item.name}" is already ${blockedItem.item.status}`,
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
          `"${digital.item.name}" has already been delivered â€” please request a refund instead`,
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
      // Each store ships (and is charged for shipping) separately, so a store's shipping line is
      // refunded exactly when this cancel removes the LAST live item of that store's sub-order.
      // Orders placed before per-store shipping existed have no line on their sub-orders: the old
      // whole-order rule applies to them.
      const hasShippingLines = order.sellerOrders.some((so: any) => (so.shippingFee ?? 0) > 0);
      let shippingRefund = 0;
      if (hasShippingLines) {
        order.sellerOrders.forEach((so: any, soIndex: number) => {
          const live = so.items.filter((i: any) => i.status !== 'cancelled').length;
          const cancelling = targetItems.filter((t) => t.soIndex === soIndex).length;
          if (live > 0 && cancelling === live) shippingRefund += so.shippingFee ?? 0;
        });
      } else if (cancelsWholeOrder) {
        shippingRefund = order.shippingFee ?? 0;
      }
      const refundAmount = round(
        targetItems.reduce((s, { item }) => s + (item.totalPrice ?? 0), 0) + shippingRefund,
      );
      if (order.paymentType === 'stripe') {
        const { paymentTransactionModel } = this.databaseService.repositories;
        const tx = await paymentTransactionModel.findOne({
          orderIds: orderId,
          status: 'completed',
          stripePaymentIntentId: { $ne: null },
          isDelete: false,
        });
        if (!tx) throw new BadRequestException('Payment record not found â€” please contact support to cancel this order');
        const refundable = round((tx.amount ?? 0) - (tx.amountRefunded ?? 0));
        const amount = Math.min(refundAmount, refundable);
        if (amount > 0) {
          const itemKey = targetItems.map(({ item }) => item._id.toString()).sort().join(',');
          const refund = await this.paymentService.refundStripePaymentIntent(
            tx.stripePaymentIntentId!,
            amount,
            `cancel-${orderId}-${itemKey}`,
          );
          if (!refund) throw new BadRequestException('Online refunds are not available right now â€” please contact support');
        }
        refundedViaStripe = true;
      } else if (refundAmount > 0) {
        // Bank transfer / COD: there's no API to send the money back â€” flag it. (A free order
        // refunds 0: nothing to send, only the items are cancelled.)
        manualRefundNeeded = true;
      }
    }

    const updateData: any = {};

    for (const { soIndex, itemIndex, item } of targetItems) {
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] =
        'cancelled';
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelledAt`] =
        now;
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelledBy`] = cancelledBy;
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelReason`] =
        reason;
      if (order.isPaid) {
        updateData[
          `sellerOrders.${soIndex}.items.${itemIndex}.refundedAmount`
        ] = item.totalPrice;
      }

      // physical item â€” stock wapas restore (skip unlimited-stock variants)
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
        updateData[`sellerOrders.${soIndex}.cancelledBy`] = cancelledBy;
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

    // Multi-seller COD: cancelling the last UNPAID package leaves only collected ones, so the order is now fully paid.
    if (order.paymentType === 'cash_on_delivery' && !order.isPaid && order.sellerOrders.length > 1) {
      const live = order.sellerOrders.filter((so: any, soIndex: number) => {
        const st = updateData[`sellerOrders.${soIndex}.status`] ?? so.status;
        return st !== 'cancelled' && st !== 'refunded';
      });
      if (live.length > 0 && live.every((so: any) => so.isPaid === true)) {
        updateData.isPaid = true;
        updateData.paymentStatus = 'paid';
        updateData.paidAt = now;
      }
    }

    // Only claim 'refunded' once the money actually went back (whole order).
    if (refundedViaStripe && updateData.orderStatus === 'cancelled') {
      updateData.paymentStatus = 'refunded';
    }

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    // Items paid (partly) with a gift card: that part goes back on the card â€” the buyer's money refund
    // above only covers what they paid otherwise. Idempotent per cancel request.
    const cancelRefKey = `cancel-${orderId}-${targetItems.map(({ item }) => item._id.toString()).sort().join(',')}`;
    for (const soIndex of new Set(targetItems.map((t) => t.soIndex))) {
      await this.paymentService.restoreGiftCardForItems(
        order,
        order.sellerOrders[soIndex],
        targetItems.filter((t) => t.soIndex === soIndex).map((t) => t.item),
        cancelRefKey,
      );
    }

    if (manualRefundNeeded) {
      this.activityLogService.log({
        storeId: order.sellerOrders[targetItems[0].soIndex].storeId,
        category: 'finance',
        action: 'manual_refund_required',
        description: `${cancelledBy === 'buyer' ? 'Buyer' : cancelledBy === 'seller' ? 'Seller' : 'Admin'} cancelled paid bank-transfer order #${orderId} â€” refund must be sent manually`,
        actorId: userId,
        actorRole: cancelledBy === 'buyer' ? 'user' : cancelledBy,
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
    if (actor) {
      // Seller/admin cancelled: tell the buyer (and, for an admin cancel, the store owners) + audit it.
      this.notificationsService
        .notify({
          recipientId: String(order.userId),
          recipientRole: 'user',
          type: NOTIFICATION_TYPES.ORDER_CANCELLED,
          title: 'Your order was cancelled',
          body: `Order #${(order as any).orderNumber ?? orderId} was cancelled by ${cancelledBy === 'seller' ? 'the seller' : 'Edudeen'} — ${reason}`,
          data: { orderId, link: `/account/orders/${orderId}` },
        })
        .catch(() => {});
      if (cancelledBy === 'admin') {
        affectedSellerIds.forEach((sid) => {
          this.notificationsService
            .notify({
              recipientId: sid,
              recipientRole: 'seller',
              type: NOTIFICATION_TYPES.ORDER_CANCELLED,
              title: 'Order cancelled by Edudeen',
              body: `Order #${orderId} was cancelled by Edudeen — ${reason}`,
              data: { orderId },
            })
            .catch(() => {});
        });
      }
      await this.activityLogService.log({
        storeId: order.sellerOrders[targetItems[0].soIndex].storeId,
        category: 'orders',
        action: `order_cancelled_by_${cancelledBy}`,
        description: `${cancelledBy === 'admin' ? 'Admin' : 'Seller'} cancelled ${targetItems.length} item(s) of order #${orderId} — ${reason}`,
        actorId: userId,
        actorRole: cancelledBy,
        targetId: orderId,
        targetType: 'order',
      } as any);
    } else affectedSellerIds.forEach((sellerOrderSellerId) => {
      this.notificationsService
        .notify({
          recipientId: sellerOrderSellerId,
          recipientRole: 'seller',
          type: NOTIFICATION_TYPES.ORDER_CANCELLED,
          title: 'Order cancelled by buyer',
          body: `Order #${orderId} was cancelled by the buyer â€” ${reason}`,
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

    // ?q= â€” narrows the list (not the stats) by order number, item name, or
    // buyer name/email; case-insensitive, regex-escaped.
    let listItems = returnItems;
    const q = searchTerm(query.q);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const buyerIds = [
        ...new Set(returnItems.map(({ order }) => String(order.userId))),
      ].filter((id) => isValidObjectId(id));
      const matchedBuyers = buyerIds.length
        ? await userModel
            .find({ _id: { $in: buyerIds }, $or: [{ name: rx }, { email: rx }] })
            .select('_id')
            .lean()
        : [];
      const buyerSet = new Set(
        (matchedBuyers as any[]).map((u) => u._id.toString()),
      );
      listItems = returnItems.filter(
        ({ order, item }) =>
          rx.test(order.orderNumber ?? '') ||
          rx.test(item.name ?? '') ||
          buyerSet.has(String(order.userId)),
      );
    }

    // paginate
    const total = listItems.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = listItems.slice(skip, skip + limit);

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

  /**
   * ONE list for the seller: item returns (order items) + item refund requests,
   * open first by respond-by. Read-only; the 48 h deadline is display only.
   */
  async getSellerReturnsAll(sellerId: string, storeId: string, query: any, now: Date = new Date()) {
    const { orderModel, storeModel, userModel, refundRequestModel } = this.databaseService.repositories;
    await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

    const page = Math.max(1, parseInt(query?.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(query?.limit) || 10));
    const cutoff = new Date(now.getTime() - 30 * 86_400_000);

    const [returnOrders, refundDocs, shippedAgg] = await Promise.all([
      orderModel
        .find({
          isDelete: false,
          sellerOrders: { $elemMatch: { storeId, 'items.returnStatus': { $in: ['requested', 'partial_requested', 'approved', 'rejected'] } } },
        })
        .select('orderNumber userId sellerOrders')
        .lean(),
      refundRequestModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).limit(1000).lean(),
      orderModel.aggregate([
        { $match: { 'sellerOrders.storeId': storeId, isDelete: false, isFreeClaim: { $ne: true } } },
        { $unwind: '$sellerOrders' },
        {
          $match: {
            'sellerOrders.storeId': storeId,
            'sellerOrders.items.type': 'physical',
            'sellerOrders.status': { $in: ['shipped', 'delivered', 'completed'] },
            'sellerOrders.shippedAt': { $gte: cutoff },
          },
        },
        { $count: 'n' },
      ]),
    ]);

    // Orders behind refund requests that were not already loaded (one batched read).
    const orderMap = new Map<string, any>();
    for (const o of returnOrders as any[]) orderMap.set(String(o._id), o);
    const missing = [...new Set((refundDocs as any[]).map((r) => String(r.orderId)))].filter(
      (id) => !orderMap.has(id) && isValidObjectId(id),
    );
    if (missing.length) {
      const extra = await orderModel.find({ _id: { $in: missing } }).select('orderNumber userId sellerOrders').lean();
      for (const o of extra as any[]) orderMap.set(String(o._id), o);
    }

    const buyerIds = [...new Set([...orderMap.values()].map((o) => String(o.userId)))].filter((id) => isValidObjectId(id));
    const buyers = buyerIds.length ? await userModel.find({ _id: { $in: buyerIds } }).select('name').lean() : [];
    const buyerName = new Map((buyers as any[]).map((u) => [String(u._id), u.name || 'Unknown']));

    const rows: ReturnsListRow[] = [];
    const returnedPackages = new Set<string>();
    const countedItemIds = new Set<string>();
    let refunded30d = 0;

    for (const order of returnOrders as any[]) {
      for (const so of order.sellerOrders ?? []) {
        if (so.storeId !== storeId) continue;
        for (const item of so.items ?? []) {
          const rs = String(item.returnStatus ?? 'none');
          if (rs === 'none') continue;
          const status = normalizeStatus(rs);
          const requestedAt = item.returnRequestedAt ? new Date(item.returnRequestedAt) : null;
          const deadline = respondBy(requestedAt, status);
          if (requestedAt && requestedAt >= cutoff) {
            if (item.type === 'physical') returnedPackages.add(`${order._id}:${so._id}`);
            if (status === 'approved') {
              refunded30d += item.refundedAmount || 0;
              countedItemIds.add(String(item._id));
            }
          }
          rows.push({
            source: 'return',
            requestId: `${order._id}:${item._id}`,
            itemIds: [String(item._id)],
            orderId: String(order._id),
            orderNumber: order.orderNumber,
            storeId,
            item: item.name,
            buyer: buyerName.get(String(order.userId)) ?? 'Unknown',
            type: 'Return',
            reason: item.returnReason || '',
            status,
            requestedAt,
            respondBy: deadline,
            isOverdue: isOverdue(deadline, now),
            amount: item.totalPrice || 0,
            followUp: item.returnFollowUp ?? null,
            reasonLabel: reasonDisplayLabel(item.returnReasonCode, item.returnReason),
          });
        }
      }
    }

    for (const r of refundDocs as any[]) {
      const order = orderMap.get(String(r.orderId));
      const so = (order?.sellerOrders ?? []).find((s: any) => String(s._id) === String(r.sellerOrderId));
      const ids = new Set((r.itemIds ?? []).map(String));
      const items = (so?.items ?? []).filter((i: any) => ids.has(String(i._id)));
      const status = normalizeStatus(r.status === 'pending' ? 'requested' : r.status);
      const requestedAt = r.createdAt ? new Date(r.createdAt) : null;
      const deadline = respondBy(requestedAt, status);
      const amount = status === 'approved' && r.buyerRefundAmount != null
        ? r.buyerRefundAmount
        : items.reduce((s: number, i: any) => s + (i.totalPrice || 0), 0);
      if (status === 'approved' && r.reviewedAt && new Date(r.reviewedAt) >= cutoff && ![...ids].some((id) => countedItemIds.has(id as string))) {
        refunded30d += r.buyerRefundAmount || 0;
      }
      rows.push({
        source: 'refund',
        requestId: String(r._id),
        itemIds: [...ids] as string[],
        orderId: String(r.orderId),
        orderNumber: order?.orderNumber ?? '',
        storeId,
        item: items.map((i: any) => i.name).join(', ') || 'Item',
        buyer: buyerName.get(String(order?.userId)) ?? 'Unknown',
        type: 'Refund only',
        reason: r.reason,
        status,
        requestedAt,
        respondBy: deadline,
        isOverdue: isOverdue(deadline, now),
        amount,
        note: r.note ?? null,
        evidenceImages: r.evidenceImages ?? [],
        followUp: r.followUp ?? null,
        reasonLabel: reasonDisplayLabel(r.reasonCode, r.reason),
      });
    }

    const stats = buildReturnsStats(rows, { returns: returnedPackages.size, orders: shippedAgg?.[0]?.n ?? 0 }, refunded30d);
    const filtered = sortReturnsRows(filterRows(rows, query?.status, searchTerm(query?.q)));
    const total = filtered.length;
    return {
      success: true,
      data: {
        stats,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        items: filtered.slice((page - 1) * limit, page * limit),
      },
    };
  }

  /**
   * Detail of ONE return or refund request for the seller's drawer. Read-only,
   * own store only (ownership check first; a request of another store is a 404).
   * requestId: return = "<orderId>:<itemId>", refund = the refund request id.
   */
  async getSellerReturnDetail(sellerId: string, storeId: string, source: string, requestId: string, now: Date = new Date()) {
    const { orderModel, storeModel, userModel, refundRequestModel } = this.databaseService.repositories;
    await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);
    if (source !== 'return' && source !== 'refund') throw new BadRequestException('source must be return or refund');

    let order: any;
    let sellerOrder: any;
    let items: any[] = [];
    let refund: any;

    if (source === 'return') {
      const [orderId, itemId] = String(requestId).split(':');
      if (!isValidObjectId(orderId) || !isValidObjectId(itemId)) throw new BadRequestException('Invalid request id');
      order = await orderModel.findOne({ _id: orderId, isDelete: false }).lean();
      sellerOrder = (order?.sellerOrders ?? []).find((s: any) => s.storeId === storeId);
      const item = (sellerOrder?.items ?? []).find((i: any) => String(i._id) === itemId);
      if (!order || !sellerOrder || !item || !item.returnStatus || item.returnStatus === 'none') {
        throw new NotFoundException('Return request not found');
      }
      items = [item];
    } else {
      if (!isValidObjectId(requestId)) throw new BadRequestException('Invalid request id');
      refund = await refundRequestModel.findOne({ _id: requestId, isDelete: false }).lean();
      if (!refund || refund.storeId !== storeId) throw new NotFoundException('Refund request not found');
      order = await orderModel.findOne({ _id: refund.orderId, isDelete: false }).lean();
      sellerOrder = (order?.sellerOrders ?? []).find((s: any) => String(s._id) === String(refund.sellerOrderId));
      if (!order || !sellerOrder) throw new NotFoundException('Order not found');
      const ids = new Set((refund.itemIds ?? []).map(String));
      items = (sellerOrder.items ?? []).filter((i: any) => ids.has(String(i._id)));
    }

    const buyer: any = isValidObjectId(String(order.userId))
      ? await userModel.findById(order.userId).select('name').lean()
      : null;
    return {
      success: true,
      data: buildReturnDetail({
        source, requestId, order, sellerOrder, items, refund, buyer: buyer?.name || 'Unknown', now,
      }),
    };
  }

  /**
   * Tracking-only step on an APPROVED item return (item received back / replacement sent).
   * Conditional update from the exact previous step; any other jump is a 400. No money moves.
   */
  async returnFollowUp(sellerId: string, orderId: string, body: any) {
    const { storeId, itemId, step } = body ?? {};
    if (!storeId || !isValidObjectId(String(storeId))) throw new BadRequestException('storeId is required');
    if (!itemId || !isValidObjectId(String(itemId))) throw new BadRequestException('itemId is required');
    const note = cleanFollowUpNote(body?.note);
    const { orderModel, storeModel } = this.databaseService.repositories;
    await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false }).lean();
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = (order.sellerOrders ?? []).findIndex((s: any) => s.storeId === storeId);
    if (soIndex === -1) throw new NotFoundException('No orders found for this store');
    const itemIndex = order.sellerOrders[soIndex].items.findIndex((i: any) => String(i._id) === String(itemId));
    if (itemIndex === -1) throw new NotFoundException('Item not found');
    const item = order.sellerOrders[soIndex].items[itemIndex];
    if (item.returnStatus !== 'approved') throw new BadRequestException('Only an approved return can be followed up');

    const previous = requiredPreviousFollowUp(step, item.type !== 'digital');
    const base = `sellerOrders.${soIndex}.items.${itemIndex}`;
    const updated = await orderModel.findOneAndUpdate(
      { _id: orderId, isDelete: false, [`${base}.returnStatus`]: 'approved', [`${base}.returnFollowUp`]: previous },
      {
        $set: { [`${base}.returnFollowUp`]: step, [`${base}.returnFollowUpNote`]: note },
        $push: { [`${base}.returnHistory`]: trailEntry(step, sellerId, 'seller', note) },
      },
    );
    if (!updated) throw new BadRequestException('This step is not available for the return in its current state');

    await this.activityLogService.log({
      storeId,
      category: 'orders',
      action: `return_${step}`,
      description: `Order #${order.orderNumber ?? orderId} — return marked "${step === 'item_received' ? 'item received back' : 'replacement sent'}"${note ? ` — ${note}` : ''}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
    });
    return { success: true, message: 'Updated', data: { followUp: step } };
  }

  async returnRequest(userId: string, orderId: string, body: any) {
    const { itemIds } = body;
    // Optional structured reason + note + photos (same rules and reason list as refund requests).
    // Physical only: returns never apply to digital items.
    const evidence = cleanRefundEvidence(
      { reasonCode: body.reasonCode, note: body.note, evidenceImages: body.evidenceImages },
      ['physical'],
    );
    const reason: string = String(
      body.reason ?? (evidence.reasonCode ? REFUND_REASON_CODES[evidence.reasonCode] : ''),
    );
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
          `"${item.name}" is a digital product â€” cannot be returned`,
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
      const base = `sellerOrders.${soIndex}.items.${itemIndex}`;
      updateData[`${base}.returnHistory`] = [trailEntry('requested', userId, 'user', null, now)];
      if (evidence.reasonCode) {
        updateData[`${base}.returnReasonCode`] = evidence.reasonCode;
        updateData[`${base}.returnNote`] = evidence.note;
        updateData[`${base}.returnEvidence`] = evidence.evidenceImages;
      }
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

    // Tell each affected seller (one notification per seller order).
    const notified = new Set<number>();
    for (const { soIndex } of targetItems) {
      if (notified.has(soIndex)) continue;
      notified.add(soIndex);
      const so: any = order.sellerOrders[soIndex];
      if (!so?.sellerId) continue;
      const count = targetItems.filter((t) => t.soIndex === soIndex).length;
      this.notificationsService
        .notify({
          recipientId: String(so.sellerId),
          recipientRole: 'seller',
          type: NOTIFICATION_TYPES.RETURN_REQUESTED,
          title: 'New return request',
          body: `A buyer asked to return ${count} item(s) from order #${order.orderNumber ?? orderId} - ${reason}`,
          data: { orderId, orderNumber: order.orderNumber, storeId: so.storeId, link: `/store/${so.storeId}/returns` },
        })
        .catch(() => {});
    }

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
    // A rejection must say why: the buyer reads it in the notification.
    const cleanedRejectReason = action === 'reject' ? cleanRejectReason(rejectReason) : null;

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
        updateData[
          `sellerOrders.${soIndex}.items.${itemIndex}.returnRejectReason`
        ] = cleanedRejectReason;
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
    // items requestedâ†’approved/rejected may move money, so a double-click or
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
      if (action === 'approve' && isPackagePaid(order, sellerOrder)) {
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
          if (!tx) throw new BadRequestException('Payment record not found â€” contact support to refund this return');
          const amount = Math.min(buyerRefund, round((tx.amount ?? 0) - (tx.amountRefunded ?? 0)));
          if (amount > 0) {
            const itemKey = targetItems.map((t) => t.item._id.toString()).sort().join(',');
            const refund = await this.paymentService.refundStripePaymentIntent(
              tx.stripePaymentIntentId!,
              amount,
              `return-${orderId}-${itemKey}`,
            );
            if (!refund) throw new BadRequestException('Online refunds are not available right now â€” try again later');
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

    // Trail entry per item (tracking only; a failure here never undoes the decision).
    try {
      const entry = trailEntry(action === 'approve' ? 'approved' : 'rejected', sellerId, 'seller', cleanedRejectReason);
      const push: Record<string, any> = {};
      for (const t of targetItems) push[`sellerOrders.${soIndex}.items.${t.itemIndex}.returnHistory`] = entry;
      await orderModel.updateOne({ _id: orderId }, { $push: push });
    } catch { /* tracking only */ }

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

    // Gift-card value that paid for the returned items goes back on the card (idempotent per return).
    if (action === 'approve') {
      await this.paymentService.restoreGiftCardForItems(
        order,
        sellerOrder,
        targetItems.map((t) => t.item),
        `return-${orderId}-${targetItems.map((t) => t.item._id.toString()).sort().join(',')}`,
      );
    }

    if (manualRefundNeeded) {
      this.activityLogService.log({
        storeId,
        category: 'finance',
        action: 'manual_refund_required',
        description: `Return approved on ${order.paymentType} order #${orderId} â€” refund the buyer manually`,
        actorId: sellerId,
        actorRole: 'seller',
        isSecurityAlert: true,
        targetId: orderId,
        targetType: 'order',
      });
    }

    let refundProcessed = false;
    if (action === 'approve' && isPackagePaid(order, sellerOrder)) {
      const refundAmount = round(targetItems.reduce(
        (sum, t) => sum + (t.item.totalPrice || 0),
        0,
      ));
      if (refundAmount > 0) {
        try {
          // item.totalPrice is in the ORDER currency; the seller's wallet is in
          // their settlement currency â€” convert with the order's own frozen FX
          // snapshots (never a live rate) and debit the matching wallet. It used
          // to debit the raw number from the USD wallet (PKR 28000 â†’ $28000).
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
            description: `Approved return â€” Order #${order.orderNumber ?? orderId}`,
            actorId: sellerId, actorRole: 'seller',
          });
          refundProcessed = true;
        } catch (e) {
          // The buyer has already been (or must be) refunded â€” a failed ledger
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

    // Tell the buyer the decision (best effort).
    if (order.userId) {
      const num = order.orderNumber ?? orderId;
      const n = targetItems.length;
      this.notificationsService
        .notify({
          recipientId: String(order.userId),
          recipientRole: 'user',
          type: action === 'approve' ? NOTIFICATION_TYPES.RETURN_APPROVED : NOTIFICATION_TYPES.RETURN_REJECTED,
          title: action === 'approve' ? 'Return approved' : 'Return not approved',
          body: action === 'approve'
            ? `Your return for ${n} item(s) from order #${num} was approved.${isPackagePaid(order, sellerOrder) ? ' Your refund is on its way.' : ''}`
            : `Your return for ${n} item(s) from order #${num} was not approved.${cleanedRejectReason ? ` Reason: ${cleanedRejectReason.slice(0, 200)}` : ''}`,
          data: { orderId, orderNumber: String(num), link: `/account/orders/${orderId}` },
        })
        .catch(() => {});
    }

    this.activityLogService.log({
      storeId,
      category: 'orders',
      action: action === 'approve' ? 'return_approved' : 'return_rejected',
      description: `Order #${orderId} â€” ${targetItems.length} item(s) return ${action === 'approve' ? 'approved' : 'rejected'}`,
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


  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Digital delivery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    if (typeof orderId !== 'string' || !isValidObjectId(orderId) || typeof productId !== 'string') throw new BadRequestException('Invalid order or product');
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

    // Refund / cancel revokes access â€” otherwise "buy, download, refund" keeps the file.
    if (['cancelled', 'refunded'].includes(item.status)) {
      throw new ForbiddenException('This item was cancelled or refunded â€” access has been revoked');
    }

    // A purchase stays downloadable even if the seller later deletes the
    // listing (standard on TPT/Gumroad/Udemy) â€” but not after an admin
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

  /** "Re-send my download link": emails (and notifies) the account owner a link to My Library. No file token is
   *  sent - a fresh one is issued on click - so a forwarded email never leaks a file. Ownership, paid/refund/expiry
   *  and takedown rules are the same as every download (resolveDigitalAccess). */
  async resendDownloadLink(userId: string, orderId: string, productId: string) {
    const { order, product } = await this.resolveDigitalAccess(userId, orderId, productId);
    const mail = downloadLinkEmail(String(product.name ?? 'your resource'), String(order.orderNumber ?? orderId));
    await this.notificationsService.notify({
      recipientId: userId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.DOWNLOAD_LINK_RESENT,
      title: 'Your download link',
      body: `Open My Library to download "${product.name}".`,
      data: { link: '/account/downloads', orderId, productId },
      email: mail,
    });
    return { success: true, message: 'We sent the download link to your email.' };
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

  /** Short-lived token for the browser-direct zip download (an <a href> cannot send the JWT header). */
  getZipLink(userId: string, orderId: string, productId: string) {
    return this.resolveDigitalAccess(userId, orderId, productId).then(() => ({
      success: true,
      data: {
        token: this.jwtService.sign(
          { typ: 'download-zip', userId, orderId, productId },
          { secret: this.configService.get<string>('JWT_SECRET'), expiresIn: OrdersService.DOWNLOAD_TOKEN_TTL },
        ),
        endpoint: '/api/orders/download-zip-file',
        expiresIn: '10 minutes',
      },
    }));
  }

  async downloadZipByToken(token: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(token, { secret: this.configService.get<string>('JWT_SECRET') });
    } catch {
      throw new BadRequestException('Download link expired or invalid');
    }
    if (payload?.typ !== 'download-zip') throw new BadRequestException('Download link expired or invalid');
    return this.downloadZip(payload.userId, payload.orderId, payload.productId);
  }

  /** All files of a purchased digital product as ONE streamed zip. Same access rules as every other download
   *  (resolveDigitalAccess). Counts ONE download for the bundle (not one per file) so a download limit of N means
   *  N bundle downloads; PDFs with stamping enabled are stamped per buyer exactly like the single-file path. */
  async downloadZip(userId: string, orderId: string, productId: string) {
    const access = await this.resolveDigitalAccess(userId, orderId, productId);
    const { product, order, files } = access;

    let total = 0;
    for (const f of files as any[]) {
      const size = Number(f.size) || 0;
      if (size > ZIP_MAX_FILE_BYTES) {
        throw new BadRequestException(`"${f.name}" is too large to include in a zip. Please download the files one by one.`);
      }
      total += size;
    }
    if (total > ZIP_MAX_TOTAL_BYTES) {
      throw new BadRequestException('These files are too large to download as one zip. Please download them one by one.');
    }

    const needStamp = (files as any[]).some((f) => this.isStampedPdf(product, f));
    let userEmail = userId;
    if (needStamp) {
      const user = await this.databaseService.repositories.userModel.findOne({ _id: userId }).select('email').lean();
      userEmail = (user as any)?.email || userId;
    }

    await this.consumeDownload(orderId, access.soIndex, access.itemIndex, access.limit);

    const names = uniqueZipEntryNames((files as any[]).map((f) => f.name));
    const archive = buildZipStream(
      (files as any[]).map((file, i) => ({
        name: names[i],
        open: async () => {
          if (this.isStampedPdf(product, file)) {
            return this.uploadService.stampPdf(file.url, userEmail, order.orderNumber);
          }
          const mimeType = this.uploadService.resolveMimeType(file.name, file.mimeType ?? 'application/octet-stream');
          const resourceType = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('image/') ? 'image' : 'raw';
          const response = await fetch(this.uploadService.generateSignedUrl(file.url, resourceType, 300));
          if (!response.ok || !response.body) throw new BadRequestException('Failed to fetch file from storage');
          return Readable.fromWeb(response.body as any);
        },
      })),
    );
    return { archive, fileName: zipDownloadName(product.name) };
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
