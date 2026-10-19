/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AdminDocument = Admin & Document;

@Schema({ timestamps: true })
export class Admin {


 @Prop()
  name: string;

  @Prop({ required: true, unique: true })
  email: string;


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

    // Bumped whenever this account is suspended/deactivated so any
    // already-issued JWT is invalidated on its next request — see
    // JwtAuthGuard, which rejects a token whose tokenVersion claim doesn't
    // match this current DB value.
    @Prop({ default: 0 })
    tokenVersion: number;

    // ── Staff (admin-panel team). An admin without `isStaff` is an OWNER with full access. ──
    @Prop({ default: false, index: true }) isStaff: boolean;
    @Prop({ type: String, enum: ['invited', 'active', 'suspended'], default: 'active' }) staffStatus: string;
    @Prop({ type: String, default: null }) staffRoleId: string | null;
    @Prop({ type: [String], default: [] }) permissionsAdd: string[];
    @Prop({ type: [String], default: [] }) permissionsRemove: string[];
    /** Access ends at this time (contractors); null = no end. */
    @Prop({ type: Date, default: null }) accessExpiresAt: Date | null;
    @Prop({ type: String, default: null }) invitedById: string | null;
    // Two-factor (authenticator app). The secret is stored encrypted; mandatory for staff.
    @Prop({ type: String, default: null }) totpSecretEnc: string | null;
    @Prop({ default: false }) totpEnabled: boolean;
    @Prop({ type: String, default: null }) emailCodeHash: string | null;
    @Prop({ type: Date, default: null }) emailCodeExpiresAt: Date | null;
    @Prop({ type: Date, default: null }) emailCodeSentAt: Date | null;
    @Prop({ default: 0 }) emailCodeTries: number;
    @Prop({ type: [String], default: [] }) recoveryHashes: string[];
    @Prop({ default: 0 }) totpFailures: number;
    @Prop({ type: Date, default: null }) totpLockedUntil: Date | null;
    @Prop({ type: Date, default: null }) lastLoginAt: Date | null;
    @Prop({ type: String, default: null }) lastLoginIp: string | null;
    // Optional limits: only these IPs / only these working hours (see staff/access-window.util.ts).
    @Prop({ type: [String], default: [] }) allowedIps: string[];
    /** Last authenticator step accepted — a code can be used only once. */
    @Prop({ type: Number, default: null }) lastTotpStep: number | null;
    @Prop({ type: Object, default: null }) workHours: { days: number[]; from: string; to: string; tz?: string } | null;
}



export const AdminSchema = SchemaFactory.createForClass(Admin);