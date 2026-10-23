/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { escapeRegex } from '../common/query-safety.util';
import { suspendSellerCascade } from '../common/seller-suspension.util';

/** Account fields an admin must never receive: credential hash, OTP state, push token, session counter. */
const SENSITIVE_FIELDS = '-password -otp -otpExpiresAt -otpAttempts -fcmToken -tokenVersion -providerId';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

// Buyers (User) and Sellers live in two separate collections — merged here via
// $unionWith so the admin table can page/sort/search across both as one list,
// same way the rest of the app keeps them as distinct schemas everywhere else.
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Awaited by callers: suspending / signing someone out is on record before the response goes out. */
  private log(action: string, description: string, meta: AuditMeta, targetId?: string, metadata?: object) {
    return this.activityLogService.log({
      storeId: 'platform',
      category: 'customers',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: metadata ?? null,
    });
  }

  async getStats() {
    const [totalBuyers, activeSellerAccounts, suspendedUsers, suspendedSellers] = await Promise.all([
      this.r.userModel.countDocuments({ isDelete: false }),
      this.r.sellerModel.countDocuments({ isDelete: false, status: 'active' }),
      this.r.userModel.countDocuments({ isDelete: false, status: 'suspended' }),
      this.r.sellerModel.countDocuments({ isDelete: false, status: 'suspended' }),
    ]);

    return {
      success: true,
      data: {
        totalBuyers,
        activeSellerAccounts,
        suspended: suspendedUsers + suspendedSellers,
      },
    };
  }

  private buildMatch(query: AdminUsersQueryDto) {
    const match: Record<string, unknown> = { isDelete: false };
    if (query.status) match.status = query.status;
    if (query.search) {
      const rx = { $regex: escapeRegex(query.search), $options: 'i' };
      match.$or = [{ name: rx }, { email: rx }];
    }
    return match;
  }

  async list(query: AdminUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const buyerMatch = this.buildMatch(query);
    const sellerMatch = this.buildMatch(query);

    let rows: any[];
    let total: number;

    if (query.role === 'buyer') {
      [rows, total] = await Promise.all([
        this.r.userModel.aggregate([
          { $match: buyerMatch },
          { $addFields: { roleLabel: 'buyer' } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        this.r.userModel.countDocuments(buyerMatch),
      ]);
    } else if (query.role === 'seller') {
      [rows, total] = await Promise.all([
        this.r.sellerModel.aggregate([
          { $match: sellerMatch },
          { $addFields: { roleLabel: 'seller' } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        this.r.sellerModel.countDocuments(sellerMatch),
      ]);
    } else {
      [rows, total] = await Promise.all([
        this.r.userModel.aggregate([
          { $match: buyerMatch },
          { $addFields: { roleLabel: 'buyer' } },
          { $unionWith: { coll: 'sellers', pipeline: [{ $match: sellerMatch }, { $addFields: { roleLabel: 'seller' } }] } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        Promise.all([this.r.userModel.countDocuments(buyerMatch), this.r.sellerModel.countDocuments(sellerMatch)]).then(
          ([a, b]) => a + b,
        ),
      ]);
    }

    const sellerRows = rows.filter((row) => row.roleLabel === 'seller');
    const storeIds = sellerRows.map((row) => row.storeId).filter(Boolean);
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }, { plan: 1 });
    const planByStoreId = new Map(stores.map((s) => [String(s._id), s.plan]));

    const items = rows.map((row) => ({
      id: row._id,
      name: row.name,
      email: row.email,
      role: row.roleLabel,
      plan: row.roleLabel === 'seller' ? planByStoreId.get(row.storeId) ?? 'starter' : 'free',
      status: row.status,
      createdAt: row.createdAt,
    }));

    return { success: true, data: { items, total, page, limit } };
  }

  private async findOrThrow(role: 'buyer' | 'seller', id: string): Promise<{ name?: string; email?: string }> {
    // dynamic model selection: userModel/sellerModel differ in document type,
    // so the union call is widened to `any` here rather than fighting Mongoose's
    // overload resolution for two structurally different models.
    const model: any = role === 'buyer' ? this.r.userModel : this.r.sellerModel;
    const doc = (await model.findOne({ _id: id, isDelete: false }).select(SENSITIVE_FIELDS)) as { name?: string; email?: string } | null;
    if (!doc) throw new NotFoundException(`${role} not found`);
    return doc;
  }

  async getById(role: 'buyer' | 'seller', id: string) {
    const doc = await this.findOrThrow(role, id);
    return { success: true, data: doc };
  }

  /** A suspension needs a written reason (kept in the audit log with who/when/where from). */
  private cleanReason(reason: unknown): string {
    const r = typeof reason === 'string' ? reason.trim() : '';
    if (r.length < 3) throw new BadRequestException('A reason is required to suspend an account');
    return r.slice(0, 500);
  }

  async suspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta, reason?: string) {
    const why = this.cleanReason(reason);
    const doc = await this.findOrThrow(role, id);

    if (role === 'buyer') {
      await this.r.userModel.findByIdAndUpdate(id, {
        $set: { status: 'suspended' },
        $inc: { tokenVersion: 1 }, // invalidates any already-issued session on its next request
      });
      await this.log('buyer_suspended', `Buyer "${doc.name ?? doc.email}" set to suspended: ${why}`, meta, id, { reason: why });
      return { success: true, message: 'Buyer set to suspended' };
    }

    // Seller suspension cascades to every store they own (see suspendSellerCascade for the merge-not-overwrite
    // rule that lets unsuspend restore exactly those stores).
    const { suspendedStores } = await suspendSellerCascade(this.databaseService, id);

    // What the suspension leaves hanging, so the admin sees it right away and it is on record:
    //  - pending / processing payouts are on HOLD (FinanceService refuses to approve them while suspended;
    //    the admin can still reject them, which returns the money to the seller's balance),
    //  - customer orders that are still open are flagged in the audit entry (admin decides: cancel, refund, reassign).
    const stores = await this.r.storeModel.find({ sellerId: id, isDelete: false }).select('_id').lean();
    const storeIds = stores.map((s: any) => String(s._id));
    const [heldPayouts, openOrderDocs] = await Promise.all([
      this.r.payoutModel.countDocuments({ sellerId: id, status: { $in: ['pending', 'processing'] } }),
      storeIds.length
        ? this.r.orderModel
            .find({ isDelete: false, sellerOrders: { $elemMatch: { storeId: { $in: storeIds }, status: { $in: ['pending', 'processing', 'shipped'] } } } })
            .select('orderNumber').limit(51).lean()
        : Promise.resolve([] as any[]),
    ]);
    const openOrders = openOrderDocs.length > 50 ? '50+' : openOrderDocs.length;

    await this.log(
      'seller_suspended',
      `Seller "${doc.name ?? doc.email}" suspended (${suspendedStores} store(s) suspended with it): ${why}. ${heldPayouts} payout(s) on hold, ${openOrders} open order(s) need attention`,
      meta,
      id,
      { reason: why, suspendedStores, heldPayouts, openOrders, openOrderNumbers: openOrderDocs.slice(0, 50).map((o: any) => o.orderNumber ?? String(o._id)) },
    );
    return { success: true, message: 'Seller set to suspended', data: { suspendedStores, heldPayouts, openOrders } };
  }

  /** Ends every session of the account right now (token version bump) without suspending it. */
  async forceLogout(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    const doc = await this.findOrThrow(role, id);
    const model: any = role === 'buyer' ? this.r.userModel : this.r.sellerModel;
    await model.updateOne({ _id: id, isDelete: false }, { $inc: { tokenVersion: 1 } });
    await this.log(`${role}_force_logout`, `All sessions of ${role} "${doc.name ?? doc.email}" ended by an admin`, meta, id);
    return { success: true, message: 'Signed out everywhere' };
  }
  async unsuspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    const doc = await this.findOrThrow(role, id);

    if (role === 'buyer') {
      const restored = await this.r.userModel.updateOne({ _id: id, isDelete: false, status: 'suspended' }, { $set: { status: 'active' } });
      if (!restored.modifiedCount) throw new ConflictException('Buyer is not suspended');
      await this.log('buyer_unsuspended', `Buyer "${doc.name ?? doc.email}" set to active`, meta, id);
      return { success: true, message: 'Buyer set to active' };
    }

    // Atomic claim: only a suspended seller can be unsuspended, so this can never be used to activate a seller
    // in another state, and two concurrent calls restore the stores once.
    const prev = await this.r.sellerModel.findOneAndUpdate(
      { _id: id, isDelete: false, status: 'suspended' },
      { $set: { status: 'active', cascadeSuspendedStoreIds: [] } },
      { returnDocument: 'before' },
    );
    if (!prev) throw new ConflictException('Seller is not suspended');
    const storeIdsToRestore: string[] = prev.cascadeSuspendedStoreIds ?? [];
    if (storeIdsToRestore.length) {
      // `status: 'suspended'` keeps an independently changed store (e.g. rejected) from being flipped to active.
      await this.r.storeModel.updateMany(
        { _id: { $in: storeIdsToRestore }, isDelete: false, status: 'suspended' },
        { $set: { status: 'active' } },
      );
    }

    await this.log(
      'seller_unsuspended',
      `Seller "${doc.name ?? doc.email}" unsuspended (${storeIdsToRestore.length} store(s) restored)`,
      meta,
      id,
    );
    return { success: true, message: 'Seller set to active' };
  }
}
