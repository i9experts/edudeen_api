import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ConversationDocument = Conversation & Document;

@Schema({ timestamps: true })
export class Conversation {
  @Prop({ type: String, required: true }) buyerId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // Snapshot of the latest message — updated on every send
  @Prop({ type: Object, default: null })
  lastMessage: {
    messageId: string;
    text: string | null;
    type: string;
    senderId: string;
    senderRole: string;
    sentAt: Date;
  } | null;

  // Opened by the seller (students page) rather than the buyer; hidden from the buyer's inbox until a message exists.
  @Prop({ type: Boolean, default: false }) startedBySeller: boolean;

  @Prop({ type: Number, default: 0 }) buyerUnread: number;
  @Prop({ type: Number, default: 0 }) sellerUnread: number;

  // Seller-side inbox controls
  @Prop({ type: Boolean, default: false }) isPinned: boolean;
  // Buyer has an active priority_support subscription benefit at this store —
  // seller inbox sorts/highlights these above regular conversations.
  @Prop({ type: Boolean, default: false }) isPriority: boolean;
  @Prop({ type: Boolean, default: false }) isArchived: boolean;
  @Prop({ type: Boolean, default: false }) isMuted: boolean;

  // Soft-delete per side (restores on new message from that side)
  @Prop({ type: Boolean, default: false }) deletedByBuyer: boolean;
  @Prop({ type: Boolean, default: false }) deletedBySeller: boolean;

  // Block state — mirrors Block documents for fast read
  @Prop({ type: Boolean, default: false }) blockedByBuyer: boolean;
  @Prop({ type: Boolean, default: false }) blockedBySeller: boolean;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

// One conversation per buyer+store pair
ConversationSchema.index({ buyerId: 1, storeId: 1 }, { unique: true });
// Seller inbox query (by store, sorted by last activity)
ConversationSchema.index({ storeId: 1, updatedAt: -1 });
// Buyer inbox query
ConversationSchema.index({ buyerId: 1, updatedAt: -1 });
// Seller pinned/archived queries
ConversationSchema.index({ storeId: 1, isPinned: 1, updatedAt: -1 });
ConversationSchema.index({ storeId: 1, isPriority: 1, updatedAt: -1 });
ConversationSchema.index({ storeId: 1, isArchived: 1, updatedAt: -1 });
