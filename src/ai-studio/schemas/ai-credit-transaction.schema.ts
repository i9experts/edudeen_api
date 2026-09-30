/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { AI_TOOL_TYPES, AiToolType } from './ai-generation.schema';

export type AiCreditTransactionDocument = AiCreditTransaction & Document;

/**
 * Per-generation credit audit trail implementing charge-on-success semantics
 * on top of the existing AiCreditsWallet (which stays the single source of
 * truth for the balance — see platform-plans/ai-credits.service.ts):
 *
 *   held     → credits deducted from the wallet when the generation starts
 *   captured → the AI call succeeded; the hold is final
 *   refunded → the AI call failed/timed out; credits were granted back
 *
 * Never charge for a failed generation: any 'held' row must end as either
 * 'captured' or 'refunded'.
 */
@Schema({ timestamps: true })
export class AiCreditTransaction {
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;

  @Prop({ type: String, enum: AI_TOOL_TYPES, required: true })
  toolUsed: AiToolType;

  @Prop({ type: Number, required: true }) creditsCharged: number;

  @Prop({ type: String, enum: ['held', 'captured', 'refunded'], default: 'held' })
  status: string;

  // false between creating the hold row and the wallet deduction succeeding, so
  // a crash in that window can never cause credits to be refunded that were
  // never taken. Legacy rows (no field) were deducted first, hence default true.
  @Prop({ type: Boolean, default: true }) deducted: boolean;

  @Prop({ type: String, required: true }) generationId: string;
  @Prop({ type: String, default: null }) note: string | null;
}

export const AiCreditTransactionSchema = SchemaFactory.createForClass(AiCreditTransaction);
AiCreditTransactionSchema.index({ storeId: 1, createdAt: -1 });
AiCreditTransactionSchema.index({ generationId: 1 });
AiCreditTransactionSchema.index({ status: 1, createdAt: 1 });
