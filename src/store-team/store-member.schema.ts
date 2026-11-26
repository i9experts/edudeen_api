/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const MEMBER_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export type StoreMemberDocument = StoreMember & Document;

/** A person the store owner gave access to ONE store (no new account type: they sign in with their own Edudeen account). */
@Schema({ timestamps: true, collection: 'store_members' })
export class StoreMember {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  /** Lower-case e-mail the invitation was sent to; the accepting account must have the same e-mail. */
  @Prop({ type: String, required: true }) email: string;
  @Prop({ type: String, default: null }) userId: string | null;
  @Prop({ type: String, default: '' }) name: string;
  @Prop({ type: String, required: true }) roleKey: string;
  @Prop({ type: [String], default: [] }) permissionsAdd: string[];
  @Prop({ type: [String], default: [] }) permissionsRemove: string[];
  @Prop({ type: String, enum: MEMBER_STATUSES, default: 'invited' }) status: MemberStatus;
  @Prop({ type: String, required: true }) invitedBy: string;
  @Prop({ type: String, default: null, index: true }) inviteTokenHash: string | null;
  @Prop({ type: Date, default: null }) inviteExpiresAt: Date | null;
  /** Optional end date: after it the member can no longer switch in and live sessions stop. */
  @Prop({ type: Date, default: null }) accessExpiresAt: Date | null;
  @Prop({ type: Date, default: null }) acceptedAt: Date | null;
  createdAt?: Date;
}

export const StoreMemberSchema = SchemaFactory.createForClass(StoreMember);
StoreMemberSchema.index({ storeId: 1, email: 1 }, { unique: true });
StoreMemberSchema.index({ email: 1, status: 1 });
