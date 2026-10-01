/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {


 @Prop()
  name: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: false})
  providerId: string;
  
  @Prop({ required: false  })
  authProvider: string;

  @Prop()
  phone: string;

  @Prop()
  address: string;


  @Prop()
  password: string;

  @Prop()
  otp: string;
  
   @Prop()
   otpExpiresAt: Date;

   // Wrong-code counter for the current OTP — reset whenever a new OTP is
   // issued. Once it hits the limit the code is burned (see AuthService).
   @Prop({ default: 0 })
   otpAttempts: number;

  @Prop({ default: false })
  isVerified: boolean;


  @Prop({ default: null })
  profileImage: string;


  @Prop({required: false })
  fcmToken: string;

  @Prop({required: false , default: "active" })
  status: string;

    @Prop({required: true})
  role: string;


    @Prop({default: false })
    isDelete: boolean ;

    // One Stripe Customer object per platform user, shared across every seller's
    // subscription plan they subscribe to (a buyer should never get a second
    // Stripe Customer just because they joined a second store's plan).
    @Prop({ type: String, default: null, index: true })
    stripeCustomerId: string | null;

    // Explicit buyer currency choice (see UpdateProfileDto.currencyPreference)
    // — null means "not yet chosen", in which case CheckoutService falls
    // back to a guest-style cookie/location-based default rather than
    // forcing one. Once set here, it's the cross-device source of truth and
    // is never silently overridden by IP/locale detection again.
    @Prop({ type: String, default: null })
    currencyPreference: string | null;

    // Bumped whenever this account is suspended/deactivated so any
    // already-issued JWT is invalidated on its next request — see
    // JwtAuthGuard, which rejects a token whose tokenVersion claim doesn't
    // match this current DB value.
    @Prop({ default: 0 })
    tokenVersion: number;
}



export const UserSchema = SchemaFactory.createForClass(User);