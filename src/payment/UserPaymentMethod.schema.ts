import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserPaymentMethodDocument = UserPaymentMethod & Document;

@Schema({ timestamps: true })
export class UserPaymentMethod {
  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({
    enum: ['card', 'google_pay', 'apple_pay'],
    required: true,
    index: true,
  })
  type: string;

  // 🔹 Card details (only for card type)
  @Prop({
    type: {
      holderName: { type: String, default: null },
      brand: { type: String, default: null },
      last4: { type: String, default: null },
      expiryMonth: { type: String, default: null },
      expiryYear: { type: String, default: null },
    },
    default: null,
  })
  cardDetails: {
    holderName?: string;
    brand?: string;
    last4?: string;
    expiryMonth?: string;
    expiryYear?: string;
  } | null;

  // 🔹 Payment gateway token (Stripe / Google / Apple)
  @Prop({ type: String, default: null })
  token: string | null;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({
    enum: ['active', 'inactive'],
    default: 'active',
    index: true,
  })
  status: string;

  @Prop({ default: false, index: true })
  isDelete: boolean;
}

export const UserPaymentMethodSchema =
  SchemaFactory.createForClass(UserPaymentMethod);

// Indexes
UserPaymentMethodSchema.index({ userId: 1, isDefault: 1 });
