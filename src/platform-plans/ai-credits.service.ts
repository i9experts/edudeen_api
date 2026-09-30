/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import mongoose from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { EntitlementsService } from './entitlements.service';

/**
 * AI-feature credit ledger, gated by the store's PlatformPlan
 * (`aiCreditsPerMonth`). No real AI feature consumes this yet anywhere in
 * this codebase — this is the infrastructure so that whenever one is built,
 * it just calls `deduct()` and gets grant/balance/monthly-reset for free,
 * and the "AI Studio — N credits/mo" line on the pricing page has a real
 * backing store instead of being purely cosmetic.
 */
@Injectable()
export class AiCreditsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get walletModel() { return this.db.repositories.aiCreditsWalletModel; }

  /** Bounded so the wallet document can never grow toward the 16MB limit. */
  private static readonly LEDGER_CAP = 200;

  /** Pipeline fragment appending one ledger entry (capped). `reason` goes through
   *  $literal so a reason starting with "$" can't be evaluated as a field path. */
  private ledgerAppend(type: string, amount: number, balanceAfter: unknown, reason: string) {
    return {
      $slice: [
        {
          $concatArrays: [
            { $ifNull: ['$ledger', []] },
            [{ type: { $literal: type }, amount, balanceAfter, reason: { $literal: reason }, createdAt: '$$NOW' }],
          ],
        },
        -AiCreditsService.LEDGER_CAP,
      ],
    };
  }

  async getOrCreateWallet(storeId: string, sellerId: string) {
    const existing = await this.walletModel.findOne({ storeId });
    if (existing) return existing;
    const limits = await this.entitlements.getLimits(storeId);
    // Atomic upsert: two first-time callers can't both create (or hit E11000).
    try {
      return await this.walletModel.findOneAndUpdate(
        { storeId },
        { $setOnInsert: { storeId, sellerId, balance: limits.aiCreditsPerMonth, monthlyAllowance: limits.aiCreditsPerMonth, lastResetAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
      ) as NonNullable<Awaited<ReturnType<typeof this.walletModel.findOne>>>;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      return (await this.walletModel.findOne({ storeId }))!;
    }
  }

  async getBalance(storeId: string): Promise<number> {
    const wallet = await this.walletModel.findOne({ storeId }).lean<{ balance?: number }>();
    return wallet?.balance ?? 0;
  }

  private assertAmount(amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Credit amount must be a positive number');
  }

  /** Call before running an AI feature. Throws if the store doesn't have enough credits.
   *  ONE atomic update: the balance guard, the decrement and the ledger entry can't be
   *  split by a concurrent request (the old read-check-save let two requests spend the same credits). */
  async deduct(storeId: string, sellerId: string, amount: number, reason: string): Promise<void> {
    this.assertAmount(amount);
    await this.getOrCreateWallet(storeId, sellerId);
    const after = { $subtract: ['$balance', amount] };
    const updated = await this.walletModel.findOneAndUpdate(
      { storeId, balance: { $gte: amount } },
      [{
        $set: {
          balance: after,
          // monthly credits are spent before purchased ones
          purchasedBalance: { $min: [{ $ifNull: ['$purchasedBalance', 0] }, after] },
          ledger: this.ledgerAppend('spend', -amount, after, reason),
        },
      }],
      { returnDocument: 'after', updatePipeline: true },
    );
    if (!updated) {
      const balance = await this.getBalance(storeId);
      throw new BadRequestException(`Not enough AI credits (need ${amount}, have ${balance}) — upgrade your platform plan or buy more credits.`);
    }
  }

  /** `kind: 'purchase'` marks credits the seller paid for so the monthly reset keeps them. */
  async grant(storeId: string, sellerId: string, amount: number, reason: string, kind: 'grant' | 'purchase' = 'grant'): Promise<void> {
    this.assertAmount(amount);
    await this.getOrCreateWallet(storeId, sellerId);
    const after = { $add: ['$balance', amount] };
    await this.walletModel.updateOne(
      { storeId },
      [{
        $set: {
          balance: after,
          ...(kind === 'purchase' ? { purchasedBalance: { $add: [{ $ifNull: ['$purchasedBalance', 0] }, amount] } } : {}),
          ledger: this.ledgerAppend(kind, amount, after, reason),
        },
      }],
      { updatePipeline: true },
    );
  }

  /** Runs monthly (cron): tops every wallet up to its plan's monthly allowance PLUS any purchased credits still
   *  unspent. Idempotent per calendar month — a retry or a manual re-run resets nobody twice. */
  async resetAllMonthlyAllowances(now = new Date()): Promise<{ reset: number }> {
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const wallets = await this.walletModel.find({ lastResetPeriod: { $ne: period } }).select('_id storeId').lean<Array<{ _id: mongoose.Types.ObjectId; storeId: string }>>();
    let reset = 0;
    for (const wallet of wallets) {
      const limits = await this.entitlements.getLimits(wallet.storeId);
      const allowance = limits.aiCreditsPerMonth;
      const after = { $add: [allowance, { $ifNull: ['$purchasedBalance', 0] }] };
      const res = await this.walletModel.updateOne(
        { _id: wallet._id, lastResetPeriod: { $ne: period } },
        [{
          $set: {
            monthlyAllowance: allowance,
            balance: after,
            lastResetAt: '$$NOW',
            lastResetPeriod: period,
            ledger: this.ledgerAppend('reset', allowance, after, 'Monthly allowance reset'),
          },
        }],
        { updatePipeline: true },
      );
      if (res.modifiedCount === 1) reset++;
    }
    return { reset };
  }
}
