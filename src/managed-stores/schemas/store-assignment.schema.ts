import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreAssignmentDocument = HydratedDocument<StoreAssignment>;
export const STORE_ASSIGNMENT_ROLES = ['account_manager', 'assistant'] as const;
export type StoreAssignmentRole = (typeof STORE_ASSIGNMENT_ROLES)[number];

/** An Edudeen team member (admin-panel staff account) assigned to operate a store. Staff can open a
 *  manage-as-seller session only for stores with an active assignment; the owner admin can open any. */
@Schema({ timestamps: true, collection: 'store_assignments' })
export class StoreAssignment {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true, index: true }) adminId: string;
  @Prop({
    type: String,
    enum: STORE_ASSIGNMENT_ROLES,
    default: 'account_manager',
  })
  role: StoreAssignmentRole;
  @Prop({ type: String, default: null }) assignedBy: string | null;
  @Prop({ type: Date, default: () => new Date() }) assignedAt: Date;
  @Prop({ type: Boolean, default: true }) active: boolean;
  @Prop({ type: String, default: null }) removedBy: string | null;
  @Prop({ type: Date, default: null }) removedAt: Date | null;
}

export const StoreAssignmentSchema =
  SchemaFactory.createForClass(StoreAssignment);
// One active assignment per (store, person); removed rows stay as history.
StoreAssignmentSchema.index(
  { storeId: 1, adminId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
