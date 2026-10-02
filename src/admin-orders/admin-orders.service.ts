/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { escapeRegex } from '../common/query-safety.util';
import { AdminOrdersQueryDto } from './dto/admin-orders-query.dto';

/**
 * Read-only order console for the Edudeen team: find any order by number,
 * buyer or store, and see everything about it in one place. Order changes
 * still go through the existing endpoints (mark paid, refunds, manual
 * payments) so their rules and audit trail stay in one place.
 */
@Injectable()
export class AdminOrdersService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get r() {
    return this.databaseService.repositories;
  }

  async list(query: AdminOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter: Record<string, any> = { isDelete: { $ne: true } };

    if (query.status) filter.orderStatus = query.status;
    if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
    if (query.paymentType) filter.paymentType = query.paymentType;
    if (query.storeId) filter['sellerOrders.storeId'] = query.storeId;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) { const end = new Date(query.to); end.setHours(23, 59, 59, 999); filter.createdAt.$lte = end; }
    }

    // One box: an order number, an order id, or a buyer's name / email / phone.
    const q = query.q?.trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const buyers = await this.r.userModel
        .find({ $or: [{ email: rx }, { name: rx }, { phone: rx }] })
        .select('_id').limit(200).lean();
      filter.$or = [
        { orderNumber: rx },
        ...(isValidObjectId(q) ? [{ _id: q }] : []),
        ...(buyers.length ? [{ userId: { $in: buyers.map((b: any) => String(b._id)) } }] : []),
      ];
    }

    const [orders, total, totals] = await Promise.all([
      this.r.orderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.orderModel.countDocuments(filter),
      this.r.orderModel.aggregate([
        { $match: filter },
        { $group: { _id: '$paymentStatus', count: { $sum: 1 } } },
      ]),
    ]);

    const userIds = [...new Set(orders.map((o: any) => o.userId).filter(Boolean))];
    const storeIds = [...new Set(orders.flatMap((o: any) => (o.sellerOrders ?? []).map((s: any) => s.storeId)).filter(Boolean))];
    const [users, stores] = await Promise.all([
      this.r.userModel.find({ _id: { $in: userIds } }).select('name email').lean(),
      this.r.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean(),
    ]);
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const storeById = new Map(stores.map((s: any) => [String(s._id), s]));

    const items = orders.map((o: any) => {
      const buyer: any = userById.get(String(o.userId));
      return {
        id: String(o._id),
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        buyer: buyer ? { id: String(buyer._id), name: buyer.name, email: buyer.email } : null,
        stores: (o.sellerOrders ?? []).map((s: any) => ({ id: s.storeId, name: (storeById.get(String(s.storeId)) as any)?.name ?? 'Unknown store', status: s.status })),
        itemCount: (o.sellerOrders ?? []).reduce((n: number, s: any) => n + (s.items ?? []).reduce((m: number, i: any) => m + (i.quantity ?? 0), 0), 0),
        totalAmount: o.totalAmount,
        currency: o.currency,
        paymentType: o.paymentType,
        paymentStatus: o.paymentStatus,
        orderStatus: o.orderStatus,
        fulfillment: [...new Set((o.sellerOrders ?? []).map((s: any) => s.fulfillmentType))],
      };
    });

    const byPayment = Object.fromEntries(totals.map((t: any) => [t._id ?? 'unknown', t.count]));
    return { success: true, data: { items, total, page, limit, byPaymentStatus: byPayment } };
  }

  async detail(id: string) {
    const order: any = await this.r.orderModel.findOne({ _id: id }).lean();
    if (!order) throw new NotFoundException('Order not found');
    const storeIds = (order.sellerOrders ?? []).map((s: any) => s.storeId).filter(Boolean);
    const [buyer, stores] = await Promise.all([
      order.userId ? this.r.userModel.findById(order.userId).select('name email phone').lean() : null,
      this.r.storeModel.find({ _id: { $in: storeIds } }).select('name slug sellerId').lean(),
    ]);
    const storeById = new Map(stores.map((s: any) => [String(s._id), s]));
    return {
      success: true,
      data: {
        ...order,
        id: String(order._id),
        buyer: buyer ? { id: String((buyer as any)._id), name: (buyer as any).name, email: (buyer as any).email, phone: (buyer as any).phone ?? null } : null,
        sellerOrders: (order.sellerOrders ?? []).map((s: any) => ({
          ...s,
          id: String(s._id),
          storeName: (storeById.get(String(s.storeId)) as any)?.name ?? 'Unknown store',
          storeSlug: (storeById.get(String(s.storeId)) as any)?.slug ?? null,
        })),
      },
    };
  }
}
