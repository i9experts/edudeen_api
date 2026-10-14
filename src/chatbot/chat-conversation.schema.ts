/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const CHAT_USER_KINDS = ['buyer', 'seller', 'guest'] as const;
export type ChatUserKind = (typeof CHAT_USER_KINDS)[number];
export const CHAT_STATUSES = ['open', 'answered', 'closed'] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];
export type ChatFrom = 'user' | 'admin' | 'bot';
export type ChatVia = 'widget' | 'panel';

export interface ChatMessageRow {
  id: string;
  from: ChatFrom;
  text: string;
  at: Date;
  via: ChatVia;
}

/**
 * One support thread between a widget visitor and the Edudeen team (admin). Created when a typed question is not
 * answered by the greeting table / FAQ matcher. Identity (name/email/store) is copied from the verified account, never
 * from the request body, except for guests who give a name + contact once.
 */
@Schema({ timestamps: true })
export class ChatConversation {
  /** Short human code (e.g. A7K2) the admin quotes on WhatsApp: "#A7K2 your answer". */
  @Prop({ type: String, required: true, unique: true }) shortCode: string;
  @Prop({ type: String, enum: ['buyer', 'seller'], default: 'buyer' }) audience: string;
  @Prop({ type: String, enum: CHAT_USER_KINDS, required: true }) userKind: string;
  @Prop({ type: String, default: null }) userId: string | null;
  /** sha256 of the guest token (the raw token lives only in the guest's browser). */
  @Prop({ type: String, default: null }) guestTokenHash: string | null;
  @Prop({ type: String, default: '' }) senderName: string;
  @Prop({ type: String, default: null }) senderEmail: string | null;
  @Prop({ type: String, default: null }) senderPhone: string | null;
  @Prop({ type: String, default: null }) storeName: string | null;
  @Prop({ type: String, enum: CHAT_STATUSES, default: 'open' }) status: string;
  @Prop({ type: Number, default: 0 }) unreadForAdmin: number;
  @Prop({ type: Number, default: 0 }) unreadForUser: number;
  @Prop({ type: Date, default: () => new Date() }) lastMessageAt: Date;
  @Prop({ type: String, default: 'en' }) lang: string;
  @Prop({ type: [Object], default: [] }) messages: ChatMessageRow[];
  /** Last time the user's widget polled this thread (used to decide whether an email is needed). */
  @Prop({ type: Date, default: null }) lastUserSeenAt: Date | null;
  @Prop({ type: Date, default: null }) lastUserEmailAt: Date | null;
}
export type ChatConversationDocument = ChatConversation & Document;
export const ChatConversationSchema = SchemaFactory.createForClass(ChatConversation);
ChatConversationSchema.index({ userId: 1, status: 1, lastMessageAt: -1 });
ChatConversationSchema.index({ guestTokenHash: 1, status: 1, lastMessageAt: -1 });
ChatConversationSchema.index({ status: 1, lastMessageAt: -1 });
