/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MessageDocument = Message & Document;

@Schema({ timestamps: true })
export class Message {
  @Prop({ type: String, required: true }) conversationId: string;
  @Prop({ type: String, required: true }) senderId: string;
  @Prop({ type: String, enum: ['user', 'seller', 'admin'], required: true }) senderRole: string;

  @Prop({
    type: String,
    enum: ['text', 'image', 'video', 'pdf', 'document', 'voice', 'product_share'],
    required: true,
  })
  type: string;

  @Prop({ type: String, default: null }) text: string | null;

  // Media / document attachments
  @Prop({ type: [Object], default: [] })
  attachments: {
    url: string;
    publicId: string;
    resourceType: string;
    fileName: string | null;
    fileSize: number | null;
    mimeType: string;
    thumbnailUrl: string | null;
  }[];

  // Product share — snapshot so deleted products still render
  @Prop({ type: Object, default: null })
  productShare: {
    productId: string;
    title: string;
    price: number;
    image: string;
    slug: string;
    currency?: string | null;
  } | null;

  // Reply-to — snapshot of the parent message
  @Prop({ type: Object, default: null })
  replyTo: {
    messageId: string;
    text: string | null;
    type: string;
    senderId: string;
    senderRole: string;
  } | null;

  // Forward metadata
  @Prop({ type: Object, default: null })
  forwardedFrom: {
    originalSenderId: string;
    originalSenderRole: string;
  } | null;

  // Delivery/read status
  @Prop({ type: String, enum: ['sent', 'delivered', 'seen'], default: 'sent' }) status: string;

  @Prop({ type: [Object], default: [] })
  seenBy: { userId: string; seenAt: Date }[];

  // Edit tracking
  @Prop({ type: Boolean, default: false }) isEdited: boolean;
  @Prop({ type: Date, default: null }) editedAt: Date | null;

  // Soft-delete — tracks which user IDs removed it from their view
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date, default: null }) deletedAt: Date | null;
  @Prop({ type: [String], default: [] }) deletedByUsers: string[];

  // Spam detection hook — flagged by automated scoring
  @Prop({ type: Number, default: 0 }) spamScore: number;
  @Prop({ type: Boolean, default: false }) isFlagged: boolean;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Cursor-based pagination (newest first within a conversation)
MessageSchema.index({ conversationId: 1, createdAt: -1 });
// Full-text search hook — ready for $text queries
MessageSchema.index({ text: 'text' });
// Sender lookups
MessageSchema.index({ senderId: 1, createdAt: -1 });
