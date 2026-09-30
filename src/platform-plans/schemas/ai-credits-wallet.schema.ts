/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AiCreditsWalletDocument = AiCreditsWallet & Document;

/**
 * Store-scoped AI-feature credit balance. NOTE: this is infrastructure only —
 * there is no actual "AI Studio" feature implemented anywhere in this
 * codebase yet to consume these credits. This wallet + AiCreditsService exist
 * so that whenever a real AI feature is built, it has a ready-made
 * grant/deduct/reset mechanism (and the pricing page's advertised
 * "AI credits/mo" figure has a real backing store) rather than being purely
 * cosmetic marketing copy.
 */
@Schema({ timestamps: true })
export class AiCreditsWallet {
  @Prop({ type: String, required: true, unique: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: Number, default: 0 }) balance: number;
  @Prop({ type: Number, default: 0 }) monthlyAllowance: number; // from the store's current PlatformPlan
  @Prop({ type: Date, default: null }) lastResetAt: Date | null;

  @Prop({ type: [Object], default: [] }) ledger: Array<{
    type: 'grant' | 'spend' | 'reset' | 'purchase';
    amount: number; balanceAfter: number; reason: string; createdAt: Date;
  }>;
}

export const AiCreditsWalletSchema = SchemaFactory.createForClass(AiCreditsWallet);
