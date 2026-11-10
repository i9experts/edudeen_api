import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { clampInt } from 'src/products/product-public-view.util';
import { escapeRegex, searchTerm } from 'src/common/query-safety.util';
import { StoreCustomerNote, StoreCustomerNoteDocument } from './schemas/store-customer-note.schema';
import {
  cleanNoteInput,
  maskEmail,
  maskPhone,
  parseCustomerSort,
  parsePhoneQuery,
  phoneMatches,
  sortCustomerRows,
} from './store-customers.util';

/**
 * Seller-facing Customers page: list, detail panel, followers and private notes.
 * Buyer contact details are MASKED here on purpose (email s***5@gmail.com, phone +92 3** ***0161);
 * orders / print / courier endpoints are separate and still carry the real phone for delivery.
 */
@Injectable()
export class StoreCustomersService {
  constructor(
    private readonly databaseService: DatabaseService,
    @InjectModel(StoreCustomerNote.name) private readonly noteModel: Model<StoreCustomerNoteDocument>,
  ) {}

  private async ownStore(sellerId: string, storeId: string) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (String((store as any).sellerId) !== String(sellerId)) throw new UnauthorizedException("You are not authorized to view this store's customers");
    return store as any;
  }

  /** The seller's own buyer account (same e-mail as the seller login) is never a customer or follower of their own store. */
  private async ownerBuyerId(store: any): Promise<string | null> {
    const { sellerModel, userModel } = this.databaseService.repositories;
    const seller: any = await sellerModel.findById(store.sellerId).select('email').lean();
    const email = typeof seller?.email === 'string' ? seller.email.trim() : '';
    if (!email) return null;
    const buyer: any = await userModel.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') }).select('_id').lean();
    return buyer ? String(buyer._id) : null;
  }

  /** Per-buyer figures for the given buyers in this store. Orders = non-cancelled packages; free claims add no value. */
  private async statsFor(storeId: string, ids: string[]) {
    if (!ids.length) return [] as any[];
    return this.databaseService.repositories.orderModel.aggregate([
      { $match: { userId: { $in: ids }, isDelete: false, 'sellerOrders.storeId': storeId } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.status': { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$userId',
          orderCount: { $sum: 1 },
          totalSpent: { $sum: { $cond: [{ $eq: ['$isFreeClaim', true] }, 0, '$sellerOrders.subtotal'] } },
          freeOrderCount: { $sum: { $cond: [{ $eq: ['$isFreeClaim', true] }, 1, 0] } },
          firstOrderAt: { $min: '$createdAt' },
          lastOrderAt: { $max: '$createdAt' },
        },
      },
    ]);
  }

  async getCustomers(sellerId: string, storeId: string, query: any) {
    const store = await this.ownStore(sellerId, storeId);
    const { orderModel, userModel } = this.databaseService.repositories;

    const page = clampInt(query.page, 1, 1, 1000);
    const limit = clampInt(query.limit, 20, 1, 100);
    const { field, dir } = parseCustomerSort(query.sort, query.order);

    const owner = await this.ownerBuyerId(store);
    const allIds: string[] = (await orderModel.distinct('userId', { 'sellerOrders.storeId': storeId, isDelete: false }))
      .map(String)
      .filter((id: string) => id !== owner);

    // ?q= — name / e-mail (regex-escaped), or a phone number matched on its national digits.
    let listIds = allIds;
    const q = searchTerm(query.q);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const valid = allIds.filter((id) => isValidObjectId(id));
      const matched = new Set<string>(
        (await userModel.find({ _id: { $in: valid }, $or: [{ name: rx }, { email: rx }] }).select('_id').lean()).map((u: any) => String(u._id)),
      );
      const pq = parsePhoneQuery(q);
      if (pq) {
        const withPhone: any[] = await userModel.find({ _id: { $in: valid }, phone: { $exists: true, $ne: '' } }).select('_id phone').lean();
        for (const u of withPhone) if (phoneMatches(u.phone, pq)) matched.add(String(u._id));
      }
      listIds = allIds.filter((id) => matched.has(id));
    }

    const stats: any[] = await this.statsFor(storeId, listIds);
    // KPIs follow the active search (same definitions as before: cancelled out, free claims add no value).
    const summary = {
      totalOrders: stats.reduce((n, s) => n + s.orderCount, 0),
      totalRevenue: stats.reduce((n, s) => n + s.totalSpent, 0),
    };

    const rows = stats.map((s) => ({ ...s, _id: String(s._id) }));
    let createdMap = new Map<string, Date | null>();
    if (field === 'createdAt') {
      const us: any[] = await userModel.find({ _id: { $in: rows.map((r) => r._id).filter((id) => isValidObjectId(id)) } }).select('createdAt').lean();
      createdMap = new Map(us.map((u) => [String(u._id), u.createdAt ?? null]));
    }
    const ts = (d: unknown) => (d ? new Date(d as any).getTime() : null);
    const sorted = sortCustomerRows(rows, field, dir, (r, f) =>
      f === 'orderCount' ? r.orderCount
      : f === 'totalSpent' ? r.totalSpent
      : f === 'lastOrderAt' ? ts(r.lastOrderAt)
      : ts(createdMap.get(r._id)),
    );

    const total = sorted.length;
    const pageRows = sorted.slice((page - 1) * limit, page * limit);
    const users: any[] = await userModel
      .find({ _id: { $in: pageRows.map((r) => r._id).filter((id) => isValidObjectId(id)) } })
      .select('name email phone createdAt')
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const customers = pageRows.map((r) => {
      const u = userMap.get(r._id);
      return {
        _id: r._id,
        name: u?.name ?? 'Unknown',
        email: maskEmail(u?.email),
        phone: maskPhone(u?.phone),
        createdAt: u?.createdAt ?? null,
        orderCount: r.orderCount,
        totalSpent: r.totalSpent,
        freeOrderCount: r.freeOrderCount,
        lastOrderAt: r.lastOrderAt,
      };
    });

    return {
      success: true,
      data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, summary, customers },
    };
  }

  /** Detail panel: figures, latest 10 orders in THIS store, the existing chat thread and the seller's private note. */
  async getCustomerDetail(sellerId: string, storeId: string, customerId: string) {
    const store = await this.ownStore(sellerId, storeId);
    const { orderModel, userModel, conversationModel } = this.databaseService.repositories;
    if ((await this.ownerBuyerId(store)) === customerId) throw new NotFoundException('Customer not found');

    const [stats] = await this.statsFor(storeId, [customerId]);
    const hasOrdered = stats ? true : await orderModel.exists({ userId: customerId, 'sellerOrders.storeId': storeId, isDelete: false });
    if (!hasOrdered) throw new NotFoundException('Customer not found');

    const [user, recent, conv, note] = await Promise.all([
      userModel.findById(customerId).select('name email phone createdAt').lean() as Promise<any>,
      orderModel
        .find({ userId: customerId, 'sellerOrders.storeId': storeId, isDelete: false })
        .sort({ createdAt: -1, _id: -1 })
        .limit(10)
        .select('orderNumber isFreeClaim createdAt sellerOrders')
        .lean() as Promise<any[]>,
      conversationModel.findOne({ buyerId: customerId, storeId, deletedBySeller: { $ne: true } }).select('_id').lean() as Promise<any>,
      this.noteModel.findOne({ storeId, buyerId: customerId }).lean() as Promise<any>,
    ]);
    if (!user) throw new NotFoundException('Customer not found');

    const recentOrders = recent.map((o) => {
      const so = (o.sellerOrders ?? []).find((x: any) => String(x.storeId) === storeId) ?? {};
      const amount = o.isFreeClaim ? 0 : Number(so.subtotal ?? 0);
      return {
        orderId: String(o._id),
        orderNumber: o.orderNumber,
        itemCount: Array.isArray(so.items) ? so.items.length : 0,
        amount,
        isFree: !!o.isFreeClaim || amount === 0,
        isFreeClaim: !!o.isFreeClaim,
        status: so.status ?? 'pending',
        createdAt: o.createdAt,
      };
    });

    const orderCount = stats?.orderCount ?? 0;
    return {
      success: true,
      data: {
        _id: customerId,
        name: user.name ?? 'Unknown',
        email: maskEmail(user.email),
        phone: maskPhone(user.phone),
        createdAt: user.createdAt ?? null,
        orderCount,
        totalSpent: stats?.totalSpent ?? 0,
        freeOrderCount: stats?.freeOrderCount ?? 0,
        firstOrderAt: stats?.firstOrderAt ?? null,
        lastOrderAt: stats?.lastOrderAt ?? null,
        isRepeat: orderCount >= 2,
        conversationId: conv ? String(conv._id) : null,
        recentOrders,
        note: { note: note?.note ?? '', tags: note?.tags ?? [] },
      },
    };
  }

  async getFollowers(sellerId: string, storeId: string, query: any) {
    const store = await this.ownStore(sellerId, storeId);
    const { storeFollowerModel, userModel } = this.databaseService.repositories;
    const owner = await this.ownerBuyerId(store);

    const page = clampInt(query.page, 1, 1, 1000);
    const limit = clampInt(query.limit, 20, 1, 100);
    const filter: any = owner ? { storeId, userId: { $ne: owner } } : { storeId };

    const total = await storeFollowerModel.countDocuments(filter);
    const followers: any[] = await storeFollowerModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
    const users: any[] = await userModel
      .find({ _id: { $in: followers.map((f) => f.userId).filter((id: string) => isValidObjectId(id)) } })
      .select('name email profileImage')
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    return {
      success: true,
      data: {
        total,
        pagination: { page, limit, totalPages: Math.ceil(total / limit) },
        followers: followers.map((f) => {
          const u = userMap.get(String(f.userId));
          return {
            followedAt: f.createdAt,
            user: u ? { _id: String(u._id), name: u.name, email: maskEmail(u.email), profileImage: u.profileImage } : { _id: String(f.userId), name: 'Unknown' },
          };
        }),
      },
    };
  }

  /** Private note: only for a buyer who ordered from, or follows, THIS store. */
  async saveNote(sellerId: string, storeId: string, buyerId: string, body: { note?: string; tags?: string[] }) {
    const store = await this.ownStore(sellerId, storeId);
    const { orderModel, storeFollowerModel } = this.databaseService.repositories;
    if ((await this.ownerBuyerId(store)) === buyerId) throw new NotFoundException('Customer not found');
    const [ordered, follows] = await Promise.all([
      orderModel.exists({ userId: buyerId, 'sellerOrders.storeId': storeId, isDelete: false }),
      storeFollowerModel.exists({ userId: buyerId, storeId }),
    ]);
    if (!ordered && !follows) throw new NotFoundException('Customer not found');

    const cleaned = cleanNoteInput(body.note, body.tags);
    if ('error' in cleaned) throw new BadRequestException(cleaned.error);

    if (!cleaned.note && cleaned.tags.length === 0) {
      await this.noteModel.deleteOne({ storeId, buyerId });
      return { success: true, data: { note: '', tags: [] as string[] } };
    }
    const doSave = () => this.noteModel.findOneAndUpdate(
      { storeId, buyerId },
      { $set: { note: cleaned.note, tags: cleaned.tags } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    let saved: any;
    try {
      saved = await doSave();
    } catch (err) {
      if ((err as { code?: number })?.code !== 11000) throw err;
      saved = await doSave(); // two parallel first saves: the second one now updates
    }
    return { success: true, data: { note: saved?.note ?? cleaned.note, tags: saved?.tags ?? cleaned.tags } };
  }
}
