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
