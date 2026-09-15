/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SellerDocument = Seller & Document;

@Schema({ timestamps: true })
export class Seller {


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


    @Prop({ default: false })
    isDelete: boolean;

    @Prop({ default: null })
    storeId!: string;

    @Prop({ default: false })
    isOnboarded!: boolean;

    // Stripe Customer for PLATFORM-PLAN billing (seller paying Edudeen) — a
    // completely separate Stripe customer from any `User.stripeCustomerId`
    // the same person might also have as a buyer of someone else's VIP plan.
    @Prop({ type: String, default: null })
    stripeCustomerId: string | null;

    // Flips true once SellerPlatformSubscriptionsService.confirmOnboardingPaymentMethod
    // has verified (server-side, against Stripe) that this seller completed the
    // onboarding wizard's Payment step with a real card on file — StoreService.createStore
    // uses this to skip the pending/admin-review Leads queue entirely and activate a
    // self-serve seller's store immediately, Shopify-style (they've already paid/put a
    // card down, so there's nothing left for an admin to gate).
    @Prop({ type: Boolean, default: false })
    hasPlatformPaymentMethod: boolean;

    // Stripe Connect (Express) account for RECEIVING buyer payments directly
    // — a seller's "own payment gateway", completely separate from
    // `stripeCustomerId` above (that one is the seller PAYING Edudeen for
    // their platform plan; this one is Edudeen routing a BUYER's payment
    // straight to the seller). See StripeConnectService.
    @Prop({ type: String, default: null })
    stripeConnectedAccountId: string | null;

    // 'not_connected' until the seller starts onboarding; 'pending' while
    // Stripe still needs more info/verification; 'active' once both
    // chargesEnabled and payoutsEnabled are true on the Stripe account.
    // Synced from Stripe (StripeConnectService.syncAccountStatus), never
    // set directly from client input.
    @Prop({ type: String, enum: ['not_connected', 'pending', 'active', 'restricted'], default: 'not_connected' })
    stripeConnectStatus: 'not_connected' | 'pending' | 'active' | 'restricted';

    @Prop({ type: Boolean, default: false })
    stripeConnectChargesEnabled: boolean;

    @Prop({ type: Boolean, default: false })
    stripeConnectPayoutsEnabled: boolean;

    // Bumped whenever this account is suspended/deactivated so any
    // already-issued JWT is invalidated on its next request — see
    // JwtAuthGuard, which rejects a token whose tokenVersion claim doesn't
    // match this current DB value.
    @Prop({ default: 0 })
    tokenVersion: number;

    // Snapshot of the store ids this seller's own OWNED stores that were
    // auto-suspended as a side effect of THIS seller being suspended (see
    // AdminUsersService.suspend/unsuspend and AdminModerationService.remove).
    // Only these stores are restored to 'active' on unsuspend — a store that
    // was already suspended for an unrelated reason before this seller was
    // suspended is never in this list, so it's correctly left untouched.
    @Prop({ type: [String], default: [] })
    cascadeSuspendedStoreIds: string[];

    // In-progress /onboard wizard state (step + form fields), so a page
    // reload/lost connection/different device resumes exactly where the
    // seller left off instead of losing everything back to step 1. Cleared
    // (set back to null) once StoreService.createStore actually creates the
    // store — there's nothing left to resume once onboarding is done.
    @Prop({ type: Object, default: null })
    onboardingDraft: { step: number; maxReached: number; form: Record<string, unknown> } | null;
}



export const SellerSchema = SchemaFactory.createForClass(Seller); 