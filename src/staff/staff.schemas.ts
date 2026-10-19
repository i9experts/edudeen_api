/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'staff_roles' })
export class StaffRole {
  @Prop({ required: true, trim: true, maxlength: 60 }) name: string;
  @Prop({ default: '', maxlength: 240 }) description: string;
  @Prop({ type: [String], default: [] }) permissions: string[];
  /** Built-in templates can be edited but not deleted. */
  @Prop({ default: false }) isSystem: boolean;
  @Prop({ type: String, default: null, index: true }) slug: string | null;
}
export type StaffRoleDocument = StaffRole & Document;
export const StaffRoleSchema = SchemaFactory.createForClass(StaffRole);

@Schema({ timestamps: true, collection: 'staff_invites' })
export class StaffInvite {
  @Prop({ required: true, index: true }) adminId: string;
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) usedAt: Date | null;
}
export type StaffInviteDocument = StaffInvite & Document;
export const StaffInviteSchema = SchemaFactory.createForClass(StaffInvite);

@Schema({ _id: true, timestamps: { createdAt: 'at', updatedAt: false } })
export class StaffTaskComment {
  @Prop({ required: true }) authorId: string;
  @Prop({ required: true }) authorName: string;
  @Prop({ required: true, maxlength: 1000 }) text: string;
  at: Date;
}
export const StaffTaskCommentSchema = SchemaFactory.createForClass(StaffTaskComment);

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TASK_LINK_TYPES = ['order', 'store', 'listing', 'user', 'chat', 'refund', 'payout', 'other'] as const;

@Schema({ timestamps: true, collection: 'staff_tasks' })
export class StaffTask {
  @Prop({ required: true, trim: true, maxlength: 140 }) title: string;
  @Prop({ default: '', maxlength: 2000 }) description: string;
  @Prop({ type: String, enum: TASK_STATUSES, default: 'todo', index: true }) status: string;
  @Prop({ type: String, enum: TASK_PRIORITIES, default: 'normal' }) priority: string;
  @Prop({ type: Date, default: null }) dueAt: Date | null;
  @Prop({ required: true, index: true }) assigneeId: string;
  @Prop({ required: true }) createdById: string;
  @Prop({ type: Object, default: null }) link: { type: string; id: string; label?: string } | null;
  @Prop({ type: [StaffTaskCommentSchema], default: [] }) comments: StaffTaskComment[];
  @Prop({ type: Date, default: null }) completedAt: Date | null;
  /** False until the assignee opens the task list — drives the 'new' count. */
  @Prop({ default: false }) seenByAssignee: boolean;
}
export type StaffTaskDocument = StaffTask & Document;
export const StaffTaskSchema = SchemaFactory.createForClass(StaffTask);

/** Every state-changing request a staff member makes (written by the access middleware). */
@Schema({ timestamps: { createdAt: 'at', updatedAt: false }, collection: 'staff_audit' })
export class StaffAudit {
  @Prop({ required: true, index: true }) adminId: string;
  @Prop() name: string;
  @Prop() method: string;
  @Prop() path: string;
  @Prop() status: number;
  @Prop() ip: string;
  @Prop({ type: String, default: null }) denied: string | null;
}
export type StaffAuditDocument = StaffAudit & Document;
export const StaffAuditSchema = SchemaFactory.createForClass(StaffAudit);
StaffAuditSchema.index({ at: -1 });

export const NOTE_ENTITY_TYPES = ['user', 'seller', 'store', 'order', 'listing'] as const;
/** Staff-only notes on a buyer, seller, store, order or listing. Never shown to customers. */
@Schema({ timestamps: true, collection: 'staff_notes' })
export class StaffNote {
  @Prop({ type: String, enum: NOTE_ENTITY_TYPES, required: true }) entityType: string;
  @Prop({ required: true, index: true }) entityId: string;
  @Prop({ required: true, maxlength: 1000 }) text: string;
  @Prop({ required: true }) authorId: string;
  @Prop({ required: true }) authorName: string;
}
export type StaffNoteDocument = StaffNote & Document;
export const StaffNoteSchema = SchemaFactory.createForClass(StaffNote);
StaffNoteSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

/** A staff member asked to do something that needs a second person's approval. */
@Schema({ timestamps: true, collection: 'staff_approvals' })
export class StaffApproval {
  @Prop({ required: true, index: true }) requestedById: string;
  @Prop() requestedByName: string;
  @Prop({ required: true }) kind: string;
  @Prop({ required: true }) label: string;
  @Prop({ required: true }) method: string;
  @Prop({ required: true }) path: string;
  @Prop({ type: String, enum: ['pending', 'approved', 'rejected', 'used', 'expired'], default: 'pending', index: true }) status: string;
  @Prop({ type: String, default: null }) decidedById: string | null;
  @Prop({ type: String, default: null }) decidedByName: string | null;
  @Prop({ type: Date, default: null }) decidedAt: Date | null;
  @Prop({ type: String, default: '' }) decisionNote: string;
  @Prop({ type: Date, default: null }) usedAt: Date | null;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
}
export type StaffApprovalDocument = StaffApproval & Document;
export const StaffApprovalSchema = SchemaFactory.createForClass(StaffApproval);

/** One document: owner-controlled staff safety settings. */
@Schema({ timestamps: true, collection: 'staff_settings' })
export class StaffSettings {
  @Prop({ default: true }) approvalsEnabled: boolean;
  /** Which approval kinds are on (see approvals.ts). */
  @Prop({ type: [String], default: ['payout', 'payout_retry', 'refund', 'payment_proof'] }) approvalKinds: string[];
}
export type StaffSettingsDocument = StaffSettings & Document;
export const StaffSettingsSchema = SchemaFactory.createForClass(StaffSettings);