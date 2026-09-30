/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { UpdateProgramDto } from './dto/update-program.dto';
import { UpdateEarningRulesDto } from './dto/update-earning-rules.dto';
import { UpdateTiersDto } from './dto/update-tiers.dto';
import { CreateRewardDto } from './dto/create-reward.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import { AwardPointsDto } from './dto/award-points.dto';
import type { LoyaltyTransactionType } from './schemas/loyalty-transaction.schema';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { randomBytes } from 'crypto';

const EARN_TYPES: LoyaltyTransactionType[] = ['purchase', 'review', 'referral', 'birthday'];
// How long a redeemed reward's voucher code stays claimable at checkout —
// generous enough that "redeem now, check out later" is never punished, but
// bounded so an abandoned redemption doesn't sit as a forever-valid code.
const REWARD_VOUCHER_VALIDITY_DAYS = 60;

function generateVoucherCode(): string {
  return `RWD${randomBytes(4).toString('hex').toUpperCase()}`;
}

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private round(n: number) {
    return Math.round(n);
  }

  // ── PROGRAM SETTINGS ──────────────────────────────────────────────────────

  async getOrCreateProgram(storeId: string) {
    let program = await this.r.loyaltyProgramModel.findOne({ storeId });
    if (!program) {
      program = await this.r.loyaltyProgramModel.create({ storeId });
    }
    return program;
  }

  async getProgram(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    return { success: true, data: await this.getOrCreateProgram(storeId) };
  }

  async updateProgram(sellerId: string, storeId: string, dto: UpdateProgramDto) {
    await this.verifyStoreOwnership(storeId, sellerId);

    // Platform-plan feature gate — Loyalty & Rewards is a Business+ tier feature.
    if (dto.isEnabled === true) {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'loyaltyProgramAllowed', 'The Loyalty & Rewards program');
    }

    const program = await this.getOrCreateProgram(storeId);

    if (dto.isEnabled !== undefined) program.isEnabled = dto.isEnabled;
    if (dto.pointsExpiryMonths !== undefined) program.pointsExpiryMonths = dto.pointsExpiryMonths;
    await program.save();

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'program_settings_updated',
      description: dto.isEnabled !== undefined ? `Loyalty program ${dto.isEnabled ? 'enabled' : 'disabled'}` : 'Program settings updated',
      actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Program updated', data: program };
  }

  async updateEarningRules(sellerId: string, storeId: string, dto: UpdateEarningRulesDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const program = await this.getOrCreateProgram(storeId);

    if (dto.pointsPerDollar !== undefined) program.pointsPerDollar = dto.pointsPerDollar;
    if (dto.pointsPerReview !== undefined) program.pointsPerReview = dto.pointsPerReview;
    if (dto.pointsPerReferral !== undefined) program.pointsPerReferral = dto.pointsPerReferral;
    if (dto.birthdayBonusPoints !== undefined) program.birthdayBonusPoints = dto.birthdayBonusPoints;
    await program.save();

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'earning_rules_updated',
      description: 'Points earning rules updated', actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Earning rules updated', data: program };
  }

  async updateTiers(sellerId: string, storeId: string, dto: UpdateTiersDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const program = await this.getOrCreateProgram(storeId);

    const sorted = [...dto.tiers].sort((a, b) => a.minPoints - b.minPoints);
    program.tiers = sorted as any;
    await program.save();

    // tier thresholds changed — every member's tier may now be wrong, recompute them all
    const members = await this.r.loyaltyMemberModel.find({ storeId });
    await Promise.all(members.map(m => {
      m.currentTier = this.computeTier(m.lifetimePoints, sorted);
      return m.save();
    }));

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'tiers_updated',
      description: `${sorted.length} tier(s) configured`, actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Tiers updated', data: program };
  }

  private computeTier(lifetimePoints: number, tiers: { name: string; minPoints: number }[]): string | null {
    const eligible = tiers.filter(t => lifetimePoints >= t.minPoints).sort((a, b) => b.minPoints - a.minPoints);
    return eligible[0]?.name ?? null;
  }

  // ── MEMBERS & LEDGER ──────────────────────────────────────────────────────

  private async getOrCreateMember(storeId: string, userId: string) {
    let member = await this.r.loyaltyMemberModel.findOne({ storeId, userId });
    if (!member) {
      member = await this.r.loyaltyMemberModel.create({ storeId, userId });
    }
    return member;
  }

  /**
   * Single entry point for every point-earning or point-losing event.
   * Earn types (purchase/review/referral/birthday) grow lifetimePoints (and can raise tier).
   * redeem/expire/adjustment only move the spendable balance — they never affect tier.
   */
  async awardPoints(storeId: string, userId: string, type: LoyaltyTransactionType, points: number, opts: { orderId?: string; description?: string } = {}) {
    const program = await this.getOrCreateProgram(storeId);
    if (!program.isEnabled) return null;
    if (points === 0) return null;

    const member = await this.getOrCreateMember(storeId, userId);
    const isEarn = EARN_TYPES.includes(type);
    const previousTier = member.currentTier;

    member.pointsBalance = Math.max(0, member.pointsBalance + points);
    if (isEarn) {
      member.lifetimePoints += points;
      member.currentTier = this.computeTier(member.lifetimePoints, program.tiers as any);
    }
    member.lastActivityAt = new Date();
    await member.save();

    const tx = await this.r.loyaltyTransactionModel.create({
      storeId, memberId: String(member._id), userId, type, points,
      orderId: opts.orderId ?? null,
      balanceAfter: member.pointsBalance,
      description: opts.description ?? null,
    });

    this.activityLogService.log({
      storeId, category: 'loyalty', action: `points_${type}`,
      description: opts.description ?? `${points > 0 ? '+' : ''}${points} points (${type})`,
      actorId: userId, actorRole: 'user', targetId: String(member._id), targetType: 'loyalty_member',
    });

    if (isEarn && points > 0) {
      if (member.currentTier && member.currentTier !== previousTier) {
        this.notificationsService.notify({
          recipientId: userId,
          recipientRole: 'user',
          type: NOTIFICATION_TYPES.LOYALTY_TIER_UPGRADE,
          title: `You've reached ${member.currentTier} tier!`,
          body: `Congrats — your loyalty tier was upgraded to ${member.currentTier}.`,
          data: { storeId, tier: member.currentTier },
        }).catch(() => {});
      } else {
        this.notificationsService.notify({
          recipientId: userId,
          recipientRole: 'user',
          type: NOTIFICATION_TYPES.LOYALTY_POINTS_EARNED,
          title: 'Points earned',
          body: `You earned ${points} loyalty point${points === 1 ? '' : 's'}.`,
          data: { storeId, points },
        }).catch(() => {});
      }
    }

    return tx;
  }

  /** Called by RatingService after a verified-purchase review with a star rating is created. */
  async awardReviewPoints(storeId: string, userId: string) {
    const program = await this.getOrCreateProgram(storeId);
    if (!program.isEnabled || program.pointsPerReview <= 0) return null;
    return this.awardPoints(storeId, userId, 'review', program.pointsPerReview, { description: 'Verified purchase review' });
  }

  /** Called by OrdersService when a sub-order is marked completed — computes the points from the store's own rate. */
  /** `multiplier` (default 1x) — subscribers with a loyalty_multiplier benefit earn more per dollar. */
  async awardPurchasePoints(storeId: string, userId: string, orderId: string, subtotal: number, multiplier = 1) {
    const program = await this.getOrCreateProgram(storeId);
    if (!program.isEnabled) return null;
    const points = Math.round(subtotal * program.pointsPerDollar * multiplier);
    if (points <= 0) return null;
    const description = multiplier > 1
      ? `Order #${orderId} completed (${multiplier}x member bonus)`
      : `Order #${orderId} completed`;
    return this.awardPoints(storeId, userId, 'purchase', points, { orderId, description });
  }

  /**
   * Called from the refund flow — deducts points for a refunded order without touching tier/lifetime
   * status (a tier already earned isn't revoked by a later partial refund). Uses the store's current
   * pointsPerDollar rate as an approximation of what was originally earned on refundAmount.
   */
  async clawbackPurchasePoints(storeId: string, userId: string, orderId: string, refundAmount: number) {
    const program = await this.getOrCreateProgram(storeId);
    const points = Math.round(refundAmount * program.pointsPerDollar);
    if (points <= 0) return null;
    return this.awardPoints(storeId, userId, 'adjustment', -points, { orderId, description: `Refund adjustment — Order #${orderId}` });
  }

  /** Seller manually credits/debits a member — covers birthday/referral bonuses until those flows are automated. */
  async manualAward(sellerId: string, storeId: string, memberId: string, dto: AwardPointsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const member = await this.r.loyaltyMemberModel.findOne({ _id: memberId, storeId });
    if (!member) throw new NotFoundException('Member not found');

    const tx = await this.awardPoints(storeId, member.userId, dto.type, dto.points, { description: dto.description });
    return { success: true, message: 'Points awarded', data: tx };
  }

  async getMembers(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const total = await this.r.loyaltyMemberModel.countDocuments({ storeId });
    const members = await this.r.loyaltyMemberModel.find({ storeId }).sort({ lifetimePoints: -1 }).skip(skip).limit(limit).lean();

    const users = await this.r.userModel.find({ _id: { $in: members.map(m => m.userId) } }).select('name email').lean();
    const userMap = new Map(users.map(u => [String(u._id), u]));

    const enriched = members.map(m => ({ ...m, user: userMap.get(m.userId) ?? null }));

    return { success: true, data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, members: enriched } };
  }

  async getMemberTransactions(sellerId: string, storeId: string, memberId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = { storeId, memberId };
    const total = await this.r.loyaltyTransactionModel.countDocuments(filter);
    const transactions = await this.r.loyaltyTransactionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    return { success: true, data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, transactions } };
  }

  /** Buyer-facing — their own balance/tier for this store. */
  async getMyBalance(storeId: string, userId: string) {
    const program = await this.getOrCreateProgram(storeId);
    const member = await this.getOrCreateMember(storeId, userId);
    const nextTier = (program.tiers as any[])
      .filter(t => t.minPoints > member.lifetimePoints)
      .sort((a, b) => a.minPoints - b.minPoints)[0] ?? null;

    return {
      success: true,
      data: {
        pointsBalance: member.pointsBalance,
        lifetimePoints: member.lifetimePoints,
        currentTier: member.currentTier,
        nextTier: nextTier ? { name: nextTier.name, pointsNeeded: nextTier.minPoints - member.lifetimePoints } : null,
      },
    };
  }

  // ── REWARDS CATALOG ───────────────────────────────────────────────────────

  async createReward(sellerId: string, storeId: string, dto: CreateRewardDto) {
    await this.verifyStoreOwnership(storeId, sellerId);

    if (dto.type === 'fixed_discount' && dto.discountValue === undefined) {
      throw new BadRequestException('discountValue is required for fixed_discount rewards');
    }
    if (dto.type === 'free_product' && !dto.productId) {
      throw new BadRequestException('productId is required for free_product rewards');
    }

    const reward = await this.r.rewardModel.create({
      storeId, name: dto.name, description: dto.description ?? null,
      pointsCost: dto.pointsCost, type: dto.type,
      discountValue: dto.discountValue ?? null, productId: dto.productId ?? null,
      stockLimit: dto.stockLimit ?? null,
    });

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'reward_created',
      description: `${dto.name} — ${dto.pointsCost} points`, actorId: sellerId, actorRole: 'seller',
      targetId: String(reward._id), targetType: 'reward',
    });

    return { success: true, message: 'Reward created', data: reward };
  }

  async getRewards(storeId: string, activeOnly = false) {
    const filter: any = { storeId, isDelete: false };
    if (activeOnly) filter.isActive = true;
    const rewards = await this.r.rewardModel.find(filter).sort({ pointsCost: 1 }).lean();
    return { success: true, data: rewards };
  }

  /** Seller's own management view — includes inactive rewards so they can be re-enabled. */
  async getRewardsForSeller(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    return this.getRewards(storeId, false);
  }

  async updateReward(sellerId: string, storeId: string, rewardId: string, dto: UpdateRewardDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const reward = await this.r.rewardModel.findOne({ _id: rewardId, storeId, isDelete: false });
    if (!reward) throw new NotFoundException('Reward not found');

    Object.assign(reward, dto);
    await reward.save();

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'reward_updated',
      description: `${reward.name} updated`, actorId: sellerId, actorRole: 'seller',
      targetId: rewardId, targetType: 'reward',
    });

    return { success: true, message: 'Reward updated', data: reward };
  }

  async deleteReward(sellerId: string, storeId: string, rewardId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const reward = await this.r.rewardModel.findOne({ _id: rewardId, storeId, isDelete: false });
    if (!reward) throw new NotFoundException('Reward not found');

    reward.isDelete = true;
    reward.isActive = false;
    await reward.save();

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'reward_deleted',
      description: `${reward.name} deleted`, actorId: sellerId, actorRole: 'seller',
      targetId: rewardId, targetType: 'reward',
    });

    return { success: true, message: 'Reward deleted' };
  }

  /**
   * Buyer redeems points for a reward. Balance deduction and stock decrement are each
   * done as single atomic conditional updates (no ACID transaction across the two —
   * matching this codebase's existing convention of compensating actions over Mongo
   * sessions). If stock runs out after points were deducted, the points are refunded.
   */
  async redeemReward(storeId: string, userId: string, rewardId: string) {
    const reward = await this.r.rewardModel.findOne({ _id: rewardId, storeId, isActive: true, isDelete: false });
    if (!reward) throw new NotFoundException('Reward not found or inactive');

    const member = await this.r.loyaltyMemberModel.findOneAndUpdate(
      { storeId, userId, pointsBalance: { $gte: reward.pointsCost } },
      { $inc: { pointsBalance: -reward.pointsCost }, $set: { lastActivityAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!member) throw new BadRequestException('Insufficient points balance');

    if (reward.stockLimit !== null) {
      const stockOk = await this.r.rewardModel.findOneAndUpdate(
        { _id: rewardId, $expr: { $lt: ['$redeemedCount', '$stockLimit'] } },
        { $inc: { redeemedCount: 1 } },
      );
      if (!stockOk) {
        // compensating action — refund the points we just deducted
        await this.r.loyaltyMemberModel.updateOne({ _id: member._id }, { $inc: { pointsBalance: reward.pointsCost } });
        throw new BadRequestException('Reward is out of stock');
      }
    } else {
      await this.r.rewardModel.updateOne({ _id: rewardId }, { $inc: { redeemedCount: 1 } });
    }

    const tx = await this.r.loyaltyTransactionModel.create({
      storeId, memberId: String(member._id), userId, type: 'redeem', points: -reward.pointsCost,
      balanceAfter: member.pointsBalance, description: `Redeemed: ${reward.name}`,
    });

    // Points were spent and the catalog decremented above, but neither of
    // those actually lets the buyer claim the reward's real-world benefit —
    // that's this voucher. Redeemable exactly once, at this store's
    // checkout, by this same buyer (see CheckoutService.applyCoupon's
    // reward-voucher fallback).
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REWARD_VOUCHER_VALIDITY_DAYS);
    let voucher: any = null;
    for (let attempt = 0; attempt < 3 && !voucher; attempt++) {
      try {
        voucher = await this.r.rewardVoucherModel.create({
          storeId, userId, rewardId, code: generateVoucherCode(), type: reward.type,
          discountValue: reward.discountValue, productId: reward.productId, expiresAt,
        });
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // duplicate code — regenerate and retry
      }
    }
    if (!voucher) throw new BadRequestException('Could not generate a redemption code, please try again');

    this.activityLogService.log({
      storeId, category: 'loyalty', action: 'reward_redeemed',
      description: `${reward.name} — ${reward.pointsCost} points`, actorId: userId, actorRole: 'user',
      targetId: rewardId, targetType: 'reward',
    });

    return {
      success: true,
      message: 'Reward redeemed',
      data: { transaction: tx, remainingBalance: member.pointsBalance, voucherCode: voucher.code, voucherExpiresAt: voucher.expiresAt },
    };
  }

  // ── EXPIRY (scheduled) ────────────────────────────────────────────────────

  /** Expires balances for members inactive longer than the program's pointsExpiryMonths. Run monthly. */
  async expireInactivePoints() {
    const programs = await this.r.loyaltyProgramModel.find({ isEnabled: true, pointsExpiryMonths: { $ne: null } });

    for (const program of programs) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - (program.pointsExpiryMonths as number));

      const stale = await this.r.loyaltyMemberModel.find({
        storeId: program.storeId, lastActivityAt: { $lt: cutoff }, pointsBalance: { $gt: 0 },
      });

      for (const member of stale) {
        const expiring = member.pointsBalance;
        member.pointsBalance = 0;
        await member.save();

        await this.r.loyaltyTransactionModel.create({
          storeId: program.storeId, memberId: String(member._id), userId: member.userId,
          type: 'expire', points: -expiring, balanceAfter: 0,
          description: `${expiring} points expired after ${program.pointsExpiryMonths} months of inactivity`,
        });
      }
    }
  }

  // ── OVERVIEW (dashboard) ──────────────────────────────────────────────────

  async getOverview(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { loyaltyMemberModel, loyaltyTransactionModel, loyaltyProgramModel, orderModel } = this.r;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const program = await loyaltyProgramModel.findOne({ storeId });
    const programMembers = await loyaltyMemberModel.countDocuments({ storeId });

    const [pointsIssued30d, pointsRedeemedTotal, activityByType] = await Promise.all([
      loyaltyTransactionModel.aggregate([
        { $match: { storeId, points: { $gt: 0 }, createdAt: { $gte: thirtyDaysAgo } } },
        { $group: { _id: null, total: { $sum: '$points' } } },
      ]),
      loyaltyTransactionModel.aggregate([
        { $match: { storeId, type: 'redeem' } },
        { $group: { _id: null, total: { $sum: '$points' } } },
      ]),
      loyaltyTransactionModel.aggregate([
        { $match: { storeId, createdAt: { $gte: thirtyDaysAgo } } },
        { $group: { _id: '$type', total: { $sum: '$points' } } },
      ]),
    ]);

    const memberUserIds = await loyaltyMemberModel.distinct('userId', { storeId });
    const revenueFromMembers = memberUserIds.length
      ? await orderModel.aggregate([
          { $match: { userId: { $in: memberUserIds }, isDelete: false, createdAt: { $gte: thirtyDaysAgo } } },
          { $unwind: '$sellerOrders' },
          { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.status': 'completed' } },
          { $group: { _id: null, total: { $sum: '$sellerOrders.subtotal' } } },
        ])
      : [];

    const tierCounts = await loyaltyMemberModel.aggregate([
      { $match: { storeId } },
      { $group: { _id: '$currentTier', count: { $sum: 1 } } },
    ]);
    const memberDistribution = (program?.tiers as any[] ?? []).map(t => {
      const found = tierCounts.find(c => c._id === t.name);
      const count = found?.count ?? 0;
      return { tier: t.name, members: count, percent: programMembers > 0 ? this.round((count / programMembers) * 100) : 0 };
    });

    const pointsActivity: Record<string, number> = {};
    for (const row of activityByType) pointsActivity[row._id] = row.total;

    return {
      success: true,
      data: {
        programEnabled: program?.isEnabled ?? false,
        programMembers,
        pointsIssuedLast30Days: pointsIssued30d[0]?.total ?? 0,
        pointsRedeemedTotal: Math.abs(pointsRedeemedTotal[0]?.total ?? 0),
        revenueFromMembersLast30Days: revenueFromMembers[0]?.total ?? 0,
        memberDistribution,
        pointsActivityLast30Days: pointsActivity,
      },
    };
  }
}
