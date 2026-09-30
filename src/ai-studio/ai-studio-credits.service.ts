/* eslint-disable prettier/prettier */
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import { AiCreditsService } from 'src/platform-plans/ai-credits.service';
import { AiToolType } from './schemas/ai-generation.schema';

/**
 * Frontend-mappable error code: on 402 + this code, show the "Buy Credits"
 * prompt (existing top-up flow: POST api/platform-plans/:storeId/addons with
 * addonType 'extra_ai_credits') instead of a generic error toast.
 */
export const INSUFFICIENT_AI_CREDITS = 'INSUFFICIENT_AI_CREDITS';

/** Per-generation cost defaults, overridable via AI_CREDIT_COST_* env vars. */
const DEFAULT_TOOL_COSTS: Record<AiToolType, number> = {
  listing_writer: 5,
  seo_booster: 5,
  email_campaigns: 5,
  worksheet_builder: 10,
  price_optimizer: 10,
  image_enhancer: 15,
};

/**
 * Charge-on-success credit handling for AI Studio, layered on the existing
 * AiCreditsWallet (platform-plans/ai-credits.service.ts) — the wallet stays
 * the single source of truth for balance, monthly allowance, and resets;
 * "Buy Credits" stays the existing extra_ai_credits add-on purchase.
 *
 * This service adds the hold → capture / auto-refund lifecycle plus a
 * per-generation AiCreditTransaction audit trail:
 *   hold()   — deducts from the wallet when a generation starts (txn 'held')
 *   capture()— finalizes after the provider call succeeds (txn 'captured')
 *   refund() — grants the credits back on provider failure/timeout (txn 'refunded')
 */
@Injectable()
export class AiStudioCreditsService {
  private readonly logger = new Logger(AiStudioCreditsService.name);
  readonly toolCosts: Record<AiToolType, number>;

  constructor(
    private readonly db: DatabaseService,
    private readonly aiCredits: AiCreditsService,
    config: ConfigService,
  ) {
    this.toolCosts = { ...DEFAULT_TOOL_COSTS };
    for (const tool of Object.keys(DEFAULT_TOOL_COSTS) as AiToolType[]) {
      const override = Number(config.get<string>(`AI_CREDIT_COST_${tool.toUpperCase()}`));
      if (Number.isFinite(override) && override >= 0) this.toolCosts[tool] = override;
    }
  }

  private get txnModel() { return this.db.repositories.aiCreditTransactionModel; }

  costOf(tool: AiToolType): number {
    return this.toolCosts[tool];
  }

  /**
   * Reserve credits for a generation. Throws 402 + INSUFFICIENT_AI_CREDITS
   * when the wallet can't cover it. Returns the transaction id to capture or
   * refund later.
   */
  async hold(storeId: string, sellerId: string, tool: AiToolType, generationId: string): Promise<string> {
    const amount = this.costOf(tool);
    if (amount === 0) return '';

    try {
      await this.aiCredits.deduct(storeId, sellerId, amount, `AI Studio hold: ${tool} (generation ${generationId})`);
    } catch (error) {
      if (error instanceof BadRequestException) {
        const balance = await this.aiCredits.getBalance(storeId);
        throw new HttpException({
          success: false,
          errorCode: INSUFFICIENT_AI_CREDITS,
          message: `Not enough AI credits — this generation costs ${amount}, you have ${balance}. Buy more credits or upgrade your plan.`,
          data: { required: amount, balance },
        }, HttpStatus.PAYMENT_REQUIRED);
      }
      throw error;
    }

    const txn = await this.txnModel.create({
      storeId, sellerId, toolUsed: tool, creditsCharged: amount, status: 'held', generationId,
    });
    return txn._id.toString();
  }

  /** Finalize a hold after the provider call succeeded. */
  async capture(txnId: string): Promise<void> {
    if (!txnId) return;
    await this.txnModel.updateOne({ _id: txnId, status: 'held' }, { $set: { status: 'captured' } });
  }

  /** Provider call failed/timed out — never charge for a failed generation. */
  async refund(txnId: string, reason: string): Promise<void> {
    if (!txnId) return;
    const txn = await this.txnModel.findOneAndUpdate(
      { _id: txnId, status: 'held' },
      { $set: { status: 'refunded', note: reason } },
      { returnDocument: 'after' },
    );
    if (!txn) return; // already captured/refunded — nothing to give back
    await this.aiCredits.grant(txn.storeId, txn.sellerId, txn.creditsCharged, `AI Studio auto-refund: ${reason}`);
    this.logger.log(`Refunded ${txn.creditsCharged} credits to store ${txn.storeId} (${reason})`);
  }

  /** Balance + monthly usage for the "750 credits remaining" UI. */
  async getCreditsOverview(storeId: string, sellerId: string) {
    const wallet = await this.aiCredits.getOrCreateWallet(storeId, sellerId);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [transactions, monthAgg] = await Promise.all([
      this.txnModel.find({ storeId }).sort({ createdAt: -1 }).limit(50).lean(),
      this.txnModel.aggregate([
        { $match: { storeId, status: 'captured', createdAt: { $gte: monthStart } } },
        { $group: { _id: '$toolUsed', credits: { $sum: '$creditsCharged' }, generations: { $sum: 1 } } },
      ]),
    ]);

    return {
      success: true,
      data: {
        balance: wallet.balance,
        monthlyAllowance: wallet.monthlyAllowance,
        lastResetAt: wallet.lastResetAt,
        toolCosts: this.toolCosts,
        usedThisMonth: monthAgg.reduce((sum, row) => sum + row.credits, 0),
        usageByTool: monthAgg.map((row) => ({ tool: row._id, credits: row.credits, generations: row.generations })),
        transactions,
        // Top-up goes through the existing add-on purchase flow — no new payment path.
        buyCredits: {
          endpoint: 'POST api/platform-plans/:storeId/addons',
          addonType: 'extra_ai_credits',
          creditsPerUnit: 500,
        },
      },
    };
  }
}
