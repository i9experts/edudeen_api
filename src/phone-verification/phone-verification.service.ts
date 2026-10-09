/* eslint-disable prettier/prettier */
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ChannelMessagingService } from '../notifications/channels/channel-messaging.service';
import { PhoneOtp, PhoneOtpDocument } from './phone-otp.schema';
import { HOUR_MS, MAX_SENDS_PER_HOUR, OTP_TTL_MS, RESEND_COOLDOWN_MS, evaluateSend, evaluateVerify, generatePhoneOtp, hashPhoneOtp, normalizeE164, type PhoneOtpState } from './phone-otp.util';

type Role = 'user' | 'seller';
const GENERIC_SENT = { success: true, message: 'If this number can receive messages, a code is on its way.', data: { expiresInSec: OTP_TTL_MS / 1000, resendAfterSec: RESEND_COOLDOWN_MS / 1000 } };
const BAD_CODE = 'That code is invalid or has expired. Request a new one.';

/**
 * Verifies a phone number for a signed-in buyer/seller by sending a 6-digit code over WhatsApp (SMS fallback).
 * This ADDS a verified identifier to the account; email sign-up/login and the email OTP are untouched.
 * Responses never reveal whether a number already belongs to another account (the same generic answer is returned,
 * with identical throttle bookkeeping, and the verify step fails with the one generic message).
 */
@Injectable()
export class PhoneVerificationService {
  private readonly logger = new Logger(PhoneVerificationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly channels: ChannelMessagingService,
    @InjectModel(PhoneOtp.name) private readonly otpModel: Model<PhoneOtpDocument>,
  ) {}

  private accountModel(role: Role): Model<any> {
    return (role === 'seller' ? this.db.repositories.sellerModel : this.db.repositories.userModel) as any;
  }

  /** Public: lets pages hide the option when no WhatsApp/SMS channel is configured. */
  availability() {
    return { success: true, data: { available: this.channels.isAnyChannelConfigured() } };
  }

  async status(userId: string, role: Role) {
    const a: any = await this.accountModel(role).findById(userId).select('phone phoneVerified phoneE164').lean();
    return {
      success: true,
      data: {
        available: this.channels.isAnyChannelConfigured(),
        phone: a?.phoneVerified ? a.phoneE164 : a?.phone ?? null,
        verified: !!a?.phoneVerified,
      },
    };
  }

  async sendCode(userId: string, role: Role, rawPhone: unknown, lang: 'en' | 'ur' = 'en') {
    if (!this.channels.isAnyChannelConfigured()) {
      throw new ServiceUnavailableException({ statusCode: 503, code: 'PHONE_OTP_UNAVAILABLE', message: 'Phone verification is not available right now. Please use email.' });
    }
    const phone = normalizeE164(rawPhone);
    if (!phone) throw new BadRequestException('Enter a valid mobile number, e.g. 0300 1234567 or +92 300 1234567.');

    const model = this.accountModel(role);
    const account: any = await model.findOne({ _id: userId, isDelete: false, status: { $nin: ['deleted', 'suspended'] } }).select('phoneVerified phoneE164').lean();
    if (!account) throw new UnauthorizedException('Account not available');

    const now = new Date();
    // Per-account guard: at most MAX_SENDS_PER_HOUR codes an hour across all numbers.
    const recent = await this.otpModel.countDocuments({ userId, lastSentAt: { $gt: new Date(now.getTime() - HOUR_MS) } });
    if (recent >= MAX_SENDS_PER_HOUR) this.tooMany('Too many codes requested. Try again later.', 600);

    const state = await this.otpModel.findOne({ phone }).lean();
    const decision = evaluateSend(state as PhoneOtpState | null, now);
    if (!decision.allowed) this.tooMany(decision.reason === 'cooldown' ? 'Please wait a moment before requesting another code.' : 'Too many codes for this number. Try again later.', decision.retryAfterSec);
    const ok = decision as Extract<typeof decision, { allowed: true }>;

    // Numbers verified by ANOTHER account (or already verified by this one) get no SMS, but identical bookkeeping + response.
    const [takenByOther, ownVerified] = await Promise.all([
      model.exists({ phoneE164: phone, phoneVerified: true, _id: { $ne: userId } }),
      Promise.resolve(account.phoneVerified === true && account.phoneE164 === phone),
    ]);
    const deliver = !takenByOther && !ownVerified;
    const code = generatePhoneOtp();

    const fields = {
      userId, role,
      codeHash: deliver ? hashPhoneOtp(phone, code) : null,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      attempts: 0, lastSentAt: now, windowStart: ok.windowStart, sendCount: ok.sendCount,
    };
    // Atomic claim: only one concurrent request can pass the cooldown for this number.
    if (state) {
      const claimed = await this.otpModel.findOneAndUpdate({ phone, lastSentAt: (state as any).lastSentAt ?? null }, { $set: fields });
      if (!claimed) this.tooMany('Please wait a moment before requesting another code.', 60);
    } else {
      try {
        await this.otpModel.create({ phone, ...fields });
      } catch (err: any) {
        if (err?.code === 11000) this.tooMany('Please wait a moment before requesting another code.', 60);
        throw err;
      }
    }

    if (deliver) {
      const res = await this.channels.sendDirect({ to: phone, event: 'phone_otp', vars: { code }, lang });
      if (!res.ok) {
        // Do not keep a code nobody received; the cooldown still applies.
        await this.otpModel.updateOne({ phone }, { $set: { codeHash: null } });
        throw new ServiceUnavailableException({ statusCode: 503, code: 'PHONE_OTP_UNAVAILABLE', message: 'We could not send the code right now. Please try again shortly or use email.' });
      }
    }
    return GENERIC_SENT;
  }

  async verifyCode(userId: string, role: Role, rawPhone: unknown, otp: unknown) {
    const phone = normalizeE164(rawPhone);
    if (!phone) throw new UnauthorizedException(BAD_CODE);
    const state: any = await this.otpModel.findOne({ phone }).lean();
    // Someone else's request (or none) looks exactly like a wrong code.
    if (!state || state.userId !== userId || state.role !== role) throw new UnauthorizedException(BAD_CODE);

    const verdict = evaluateVerify(state as PhoneOtpState, phone, otp);
    if (!verdict.ok) {
      if (verdict.reason === 'wrong') {
        await this.otpModel.updateOne({ phone, codeHash: state.codeHash }, verdict.burn ? { $set: { codeHash: null }, $inc: { attempts: 1 } } : { $inc: { attempts: 1 } });
      } else if (verdict.burn) {
        await this.otpModel.updateOne({ phone, codeHash: state.codeHash }, { $set: { codeHash: null } });
      }
      throw new UnauthorizedException(BAD_CODE);
    }

    // Single use: whoever flips the hash to null owns this verification.
    const burned = await this.otpModel.findOneAndUpdate({ phone, codeHash: state.codeHash }, { $set: { codeHash: null } });
    if (!burned) throw new UnauthorizedException(BAD_CODE);

    try {
      const res = await this.accountModel(role).updateOne(
        { _id: userId, isDelete: false },
        { $set: { phone, phoneE164: phone, phoneVerified: true, phoneVerifiedAt: new Date() } },
      );
      if (!res.matchedCount) throw new UnauthorizedException(BAD_CODE);
    } catch (err: any) {
      if (err?.code === 11000) throw new UnauthorizedException(BAD_CODE); // claimed by another account in the meantime
      throw err;
    }
    return { success: true, message: 'Phone number verified', data: { phone, verified: true } };
  }

  private tooMany(message: string, retryAfterSec: number): never {
    throw new HttpException({ statusCode: 429, message, retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
