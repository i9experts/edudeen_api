import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CommissionRuleDocument = CommissionRule & Document;

/**
 * Admin-managed commission override layer, sitting ABOVE the plan-tier
 * `PlatformPlan.limits.transactionFeeRate` mechanism (see EntitlementsService)
 * rather than replacing it — resolution order (see CommissionRulesService):
 *   1. Active 'seller' rule for the store (highest priority — always wins)
 *   2. The store's PlatformPlan.limits.transactionFeeRate, if it has a plan
 *   3. Active 'global' rule (used only for stores with no plan at all)
 *   4. Hardcoded EntitlementsService fallback (0.08) — last resort
 *
 * Never mutated in place: changing a rate creates a new row and marks the
 * previous one `isActive: false` with `supersededAt` set, so the full history
 * of every commission-rate decision is preserved for audit purposes.
 */
@Schema({ timestamps: true })
export class CommissionRule {
  @Prop({ type: String, enum: ['global', 'seller'], required: true })
  scope: 'global' | 'seller';

  // null for scope: 'global' — exactly one active global rule ever exists.
  @Prop({ type: String, default: null })
  storeId: string | null;

  // 0–1 fraction (e.g. 0.03 = 3%), same unit as PlatformPlan.limits.transactionFeeRate.
  @Prop({ type: Number, required: true, min: 0, max: 1 })
  rate: number;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: String, default: null })
  notes: string | null;

  @Prop({ type: String, required: true })
  createdByAdminId: string;

  @Prop({ type: Date, default: null })
  supersededAt: Date | null;
}

export const CommissionRuleSchema = SchemaFactory.createForClass(CommissionRule);
CommissionRuleSchema.index({ scope: 1, storeId: 1, isActive: 1 });
// At most ONE active rule per scope+store (global rules have storeId null). A concurrent set can no longer leave two.
CommissionRuleSchema.index({ scope: 1, storeId: 1 }, { unique: true, partialFilterExpression: { isActive: true }, name: 'one_active_rule_per_scope_store' });
CommissionRuleSchema.index({ storeId: 1 });
