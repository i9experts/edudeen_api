/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from 'src/users/schemas/user.schema';

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
}



export const AdminSchema = SchemaFactory.createForClass(Admin);