import {
  Injectable,
  Logger,
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { LoginDto } from './dto/login.dto';
import { AuthUpdateProfileDto } from './dto/update-profile.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { OtpService } from 'src/otp/otp.service';
import { DatabaseService } from 'src/database/databaseservice';
import { OAuth2Client } from 'google-auth-library';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import * as appleSignin from 'apple-signin-auth';
// import axios from 'axios';
import { RedisService } from '../redis/redis.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // 👈 Google Client
  constructor(
    private databaseService: DatabaseService,
    private readonly otpService: OtpService,
    private readonly redisService: RedisService,
    private readonly activityLogService: ActivityLogService,

    private readonly jwtService: JwtService,
  ) {}

  /** Deletes the Redis session key for this access token so `JwtAuthGuard` rejects it immediately, instead of waiting out its TTL. */
  async logout(token: string) {
    await this.redisService.del(token);
    return {
      success: true,
      message: 'Logged out successfully',
      data: null,
    };
  }

  /** Seller logins/edits are logged against their store's activity feed; users/admins have no store to attach to. */
  private static readonly MAX_OTP_ATTEMPTS = 5;
  /** Lifetime of a password-reset code (see forgotPassword). */
  private static readonly OTP_TTL_SECONDS = 5 * 60;

  /** Cryptographically secure 6-digit code (Math.random is predictable). */
  private static generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  /** OTPs are stored as an HMAC (keyed with JWT_SECRET), never in plaintext.
   *  Pre-existing plaintext OTPs simply fail the comparison and expire. */
  private static hashOtp(otp: string): string {
    return createHmac('sha256', process.env.JWT_SECRET ?? '').update(String(otp ?? '')).digest('hex');
  }

  /** Keeps HttpExceptions (400/401/404/…) as they are; anything else is an
   *  unexpected failure — log it server-side and return a generic 500 so
   *  internal messages never reach the client. */
  private mapError(error: any, context: string): HttpException {
    if (error instanceof HttpException) return error;
    this.logger.error(`${context}: ${error?.message ?? error}`, error?.stack);
    return new InternalServerErrorException(context);
  }

  /** Reset-password for an email with no account must be indistinguishable from a real account, attempt by attempt
   *  (forgot-password answers the same for both, so this is the only place the difference could show). A Redis marker
   *  stands in for "a code was issued" (set by forgotPassword, lifetime = the OTP's) and a counter for the attempts:
   *  no pending code → OTP_EXPIRED; wrong tries count down 4..1; the 5th burns it (OTP_LOCKED); then it is gone
   *  (OTP_EXPIRED) — exactly the sequence checkOtp produces for a real account. Without Redis it degrades to a constant
   *  first-attempt answer. */
  private async failUnknownAccountOtp(role: string, email: string): Promise<never> {
    const max = AuthService.MAX_OTP_ATTEMPTS;
    if (!this.redisService.isConnected) {
      throw AuthService.otpError('Invalid OTP', 'OTP_INVALID', { attemptsLeft: max - 1 });
    }
    const id = `${role}:${String(email).toLowerCase()}`;
    const pendingKey = `otp-sim:pending:${id}`;
    const attemptsKey = `otp-sim:attempts:${id}`;
    if (!(await this.redisService.get(pendingKey))) {
      throw AuthService.otpError('OTP has expired, please request a new one', 'OTP_EXPIRED');
    }
    const n = await this.redisService.incrWithTtl(attemptsKey, AuthService.OTP_TTL_SECONDS);
    if (n >= max) {
      await this.redisService.del(pendingKey);
      await this.redisService.del(attemptsKey);
      throw AuthService.otpError('Invalid OTP', 'OTP_LOCKED');
    }
    throw AuthService.otpError('Invalid OTP', 'OTP_INVALID', { attemptsLeft: max - n });
  }

  /** An OTP failure: same HTTP status (401) and message as ever, plus a machine-readable `code` so the app does
   *  not have to string-match the message, and optionally `attemptsLeft`. */
  private static otpError(message: string, code: 'OTP_INVALID' | 'OTP_EXPIRED' | 'OTP_LOCKED', extra: Record<string, unknown> = {}) {
    return new UnauthorizedException({ statusCode: 401, message, error: 'Unauthorized', code, ...extra });
  }

  /** Validates an OTP against the account and burns it after
   *  MAX_OTP_ATTEMPTS wrong tries — the per-IP throttle alone does not stop
   *  a distributed brute force of a 6-digit code.
   *  Failures carry `code`: OTP_EXPIRED (none issued / past its time), OTP_INVALID (wrong, with `attemptsLeft`),
   *  OTP_LOCKED (the attempt that burned the code, or any attempt on a code already out of tries). */
  private async checkOtp(user: any, otp: string): Promise<void> {
    if (!user.otp || !user.otpExpiresAt || new Date() > user.otpExpiresAt) {
      throw AuthService.otpError('OTP has expired, please request a new one', 'OTP_EXPIRED');
    }
    if ((user.otpAttempts ?? 0) >= AuthService.MAX_OTP_ATTEMPTS) {
      throw AuthService.otpError('Too many wrong attempts, please request a new OTP', 'OTP_LOCKED');
    }
    const a = Buffer.from(AuthService.hashOtp(otp));
    const b = Buffer.from(String(user.otp));
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      user.otpAttempts = (user.otpAttempts ?? 0) + 1;
      const burned = user.otpAttempts >= AuthService.MAX_OTP_ATTEMPTS;
      if (burned) {
        user.otp = null;
        user.otpExpiresAt = null;
      }
      await user.save();
      if (burned) throw AuthService.otpError('Invalid OTP', 'OTP_LOCKED');
      throw AuthService.otpError('Invalid OTP', 'OTP_INVALID', {
        attemptsLeft: AuthService.MAX_OTP_ATTEMPTS - user.otpAttempts,
      });
    }
  }

  private static readonly ACCESS_TTL_SECONDS = 24 * 60 * 60;

  /** Single place that mints a session. `typ` separates access from refresh
   *  tokens (and from order download tokens, which share JWT_SECRET) so
   *  JwtStrategy can refuse anything that is not an access token. */
  async issueSession(account: any) {
    const base = {
      sub: account._id,
      email: account.email,
      role: account.role,
      tokenVersion: account.tokenVersion ?? 0,
    };
    const accessToken = this.jwtService.sign(
      { ...base, typ: 'access' },
      { expiresIn: AuthService.ACCESS_TTL_SECONDS },
    );
    await this.redisService.set(
      accessToken,
      account._id.toString(),
      AuthService.ACCESS_TTL_SECONDS,
    );
    const refreshToken = this.jwtService.sign(
      { ...base, typ: 'refresh' },
      { expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }

  /** Exchanges a refresh token for a new session. Rejects anything that is
   *  not a refresh token, and any token issued before a suspend/reset
   *  (tokenVersion mismatch). */
  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token expired or invalid');
    }
    if (payload?.typ !== 'refresh') throw new UnauthorizedException('Invalid refresh token');
    const repos = this.databaseService.repositories;
    const model: any =
      payload.role === 'user' ? repos.userModel
      : payload.role === 'seller' ? repos.sellerModel
      : payload.role === 'admin' ? repos.adminModel
      : null;
    if (!model) throw new UnauthorizedException('Invalid refresh token');
    const account = await model.findById(payload.sub);
    if (!account || account.isDelete || ['deleted', 'suspended'].includes(account.status)) {
      throw new UnauthorizedException('Account is not active');
    }
    if ((account.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)) {
      throw new UnauthorizedException('Session revoked, please login again');
    }
    const tokens = await this.issueSession(account);
    return { success: true, message: 'Token refreshed', data: { token: tokens } };
  }

  private async logSellerSecurityEvent(
    sellerId: string,
    category: 'security' | 'customers',
    action: string,
    description: string,
    ip?: string,
    userAgent?: string,
    isSecurityAlert = false,
  ) {
    try {
      const store = await this.databaseService.repositories.storeModel.findOne({
        sellerId,
        isDelete: false,
      });
      if (!store) return;
      await this.activityLogService.log({
        storeId: String(store._id),
        category,
        action,
        description,
        actorId: sellerId,
        actorRole: 'seller',
        ip,
        userAgent,
        isSecurityAlert,
      });
    } catch {
      // logging must never break auth
    }
  }

  async signup(RegisterDto: RegisterDto) {
    try {
      const { name, email, password, phone, address, role, profileImage } =
        RegisterDto;

      // Public registration only ever creates a buyer or seller account —
      // RegisterDto.role is already restricted to 'user'|'seller' at the
      // validation layer, and there is deliberately no 'admin' branch here.
      // Admin accounts are created only via the protected
      // POST /api/auth/admin/create-admin endpoint (see createAdmin() below).
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const existingUser = await userModel.findOne({ email });
      if (existingUser) {
        throw new UnauthorizedException('User already exists');
      }

      const otp = AuthService.generateOtp();
      const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = new userModel({
        name,
        email,
        password: hashedPassword,
        phone,
        address,
        profileImage,
        role,
        otp: AuthService.hashOtp(otp),
        otpExpiresAt,
        isVerified: false,
      });

      await user.save();

      await this.otpService.sendOtp(email, otp);

      return {
        message: 'OTP sent successfully',
        success: true,
        data: {
          userId: user._id,
        },
      };
    } catch (error) {
      throw this.mapError(error, 'Signup failed');
    }
  }

  async login(loginDto: LoginDto, ip?: string, userAgent?: string) {
    try {
      const { email, password, role } = loginDto;

      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const existingUser = await userModel.findOne({ email });
      if (!existingUser) {
        throw new UnauthorizedException('Invalid email or password');
      }

      // Checked BEFORE the password compare — otherwise whether a wrong
      // password gets 'Invalid email or password' vs an unverified account
      // getting 'Account not verified' becomes a password oracle: an
      // attacker who's guessed the right password for an unverified account
      // would see the message change, confirming the guess without ever
      // completing a real login. Checking this first means an unverified
      // account always gets the same response regardless of the password
      // tried.
      if (!existingUser.isVerified) {
        throw new UnauthorizedException(
          'Account not verified. Please verify OTP first',
        );
      }

      const isPasswordMatch = await bcrypt.compare(
        password,
        existingUser.password,
      );
      if (!isPasswordMatch) {
        if (role === 'seller') {
          this.logSellerSecurityEvent(
            existingUser._id.toString(),
            'security',
            'login_failed',
            `Failed login attempt from ${ip ?? 'unknown IP'}`,
            ip,
            userAgent,
            true,
          );
        }
        throw new UnauthorizedException('Invalid email or password');
      }

      // Applies uniformly to all three roles: User/Seller/Admin schemas all
      // share the same isDelete/status fields (see usersService.deleteAccount /
      // AdminUsersService.suspend) — a deleted or suspended account must not
      // be able to get a fresh session just by logging back in.
      if (existingUser.isDelete || existingUser.status === 'deleted') {
        throw new UnauthorizedException('This account has been deleted');
      }

      if (existingUser.status === 'suspended') {
        throw new UnauthorizedException(
          'This account has been suspended. Please contact support.',
        );
      }

      if (role === 'seller') {
        this.logSellerSecurityEvent(
          existingUser._id.toString(),
          'security',
          'login_success',
          `Login from ${ip ?? 'unknown IP'}`,
          ip,
          userAgent,
          false,
        );
      }

      // tokenVersion is embedded so a suspend/deactivate action elsewhere
      // (which bumps the DB value) invalidates this token on its very next
      // request — see JwtAuthGuard's comparison against the current DB value.
      const { accessToken: token, refreshToken } = await this.issueSession(existingUser);

      return {
        message: 'Login successful',
        success: true, // ye add karna zaroori hai
        data: {
          user: {
            // ⬅️ user object me rakhna
            id: existingUser._id,
            name: existingUser.name,
            email: existingUser.email,
            role: existingUser.role,
            image: existingUser.profileImage || null,
          },
          token: {
            // ⬅️ token object me rakhna
            accessToken: token,
            refreshToken: refreshToken,
          },
        },
      };
    } catch (error) {
      throw this.mapError(error, 'Login failed');
    }
  }

  /** Comma-separated GOOGLE_CLIENT_IDS (Android/iOS/web each have their own
   *  OAuth client, so an ID token's `aud` can be any of them), falling back
   *  to the single legacy GOOGLE_CLIENT_ID. */
  private googleAudiences(): string[] {
    const raw = process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  /** Verifies the provider token server-side and returns the identity the
   *  PROVIDER vouches for. The email used to find/link an account must come
   *  from here — never from the request body — otherwise anyone holding a
   *  valid token for their own social account could send someone else's
   *  email and receive that person's session (account takeover). */
  private async verifySocialToken(
    authProvider: string,
    socialId: string,
    token?: string,
  ): Promise<{ email: string | null; emailVerified: boolean }> {
    if (!token) {
      throw new UnauthorizedException(
        'Missing provider token for verification',
      );
    }

    if (authProvider === 'google') {
      const audience = this.googleAudiences();
      if (!audience.length) throw new UnauthorizedException('Google sign-in is not configured');
      const ticket = await this.googleClient.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      if (!payload || payload.sub !== socialId) {
        throw new UnauthorizedException('Invalid Google token');
      }
      return {
        email: payload.email ? payload.email.toLowerCase() : null,
        emailVerified: payload.email_verified === true,
      };
    }
    if (authProvider === 'facebook') {
      const resp = await fetch(
        `https://graph.facebook.com/me?fields=id,email&access_token=${encodeURIComponent(token)}`,
      );
      const data: any = await resp.json();
      if (!data?.id || data.id !== socialId) {
        throw new UnauthorizedException('Invalid Facebook token');
      }
      // Graph only returns an email the user has confirmed with Facebook.
      return {
        email: typeof data.email === 'string' ? data.email.toLowerCase() : null,
        emailVerified: typeof data.email === 'string',
      };
    }
    if (authProvider === 'apple') {
      const payload: any = await appleSignin.verifyIdToken(token, {
        audience: process.env.APPLE_CLIENT_ID,
      });
      if (!payload || payload.sub !== socialId) {
        throw new UnauthorizedException('Invalid Apple token');
      }
      const verified = payload.email_verified === true || payload.email_verified === 'true';
      return {
        email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
        emailVerified: verified,
      };
    }
    throw new UnauthorizedException('Unsupported auth provider');
  }

  /** Social login resolves against the buyer (User) or seller (Seller) collection based on dto.role (default 'user') — same role-picks-the-model pattern as login()/signup(). */
  async socialLogin(dto: SocialLoginDto) {
    try {
      const { authProvider, socialId, userName, name, image, fcmToken, token, role } = dto;

      const identity = await this.verifySocialToken(authProvider, socialId, token);
      const verifiedEmail = identity.emailVerified ? identity.email : null;

      const targetRole: 'user' | 'seller' = role === 'seller' ? 'seller' : 'user';
      const accountModel: any =
        targetRole === 'seller'
          ? this.databaseService.repositories.sellerModel
          : this.databaseService.repositories.userModel;

      // 1) Already-linked account for this exact provider identity.
      let account = await accountModel.findOne({ providerId: socialId, authProvider });
      // 2) Otherwise link to an existing account ONLY by a provider-verified email.
      if (!account && verifiedEmail) {
        const escaped = verifiedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        account = await accountModel.findOne({ email: new RegExp(`^${escaped}$`, 'i') });
      }

      if (!account) {
        if (!verifiedEmail) {
          throw new UnauthorizedException(
            'Your social account did not share a verified email address. Please sign up with email instead.',
          );
        }
        account = new accountModel({
          name: name || userName,
          email: verifiedEmail,
          role: targetRole,
          isVerified: true,
          authProvider,
          providerId: socialId,
          profileImage: image || null,
          fcmToken: fcmToken || undefined,
        });
        await account.save();
      } else {
        if (account.isDelete || account.status === 'deleted') {
          throw new UnauthorizedException('This account has been deleted');
        }
        if (account.status === 'suspended') {
          throw new UnauthorizedException(
            'This account has been suspended. Please contact support.',
          );
        }

        let changed = false;
        if (!account.providerId) {
          account.providerId = socialId;
          changed = true;
        }
        if (!account.authProvider) {
          account.authProvider = authProvider;
          changed = true;
        }
        if (fcmToken && account.fcmToken !== fcmToken) {
          account.fcmToken = fcmToken;
          changed = true;
        }
        // Only a provider-verified email proves ownership of the address.
        if (!account.isVerified && verifiedEmail && String(account.email).toLowerCase() === verifiedEmail) {
          account.isVerified = true;
          changed = true;
        }
        if (changed) await account.save();
      }

      if (targetRole === 'seller') {
        this.logSellerSecurityEvent(
          account._id.toString(),
          'security',
          'login_success',
          `Login via ${authProvider}`,
          undefined,
          undefined,
          false,
        );
      }

      const { accessToken, refreshToken } = await this.issueSession(account);

      return {
        message: 'Social login successful',
        success: true,
        data: {
          user: {
            id: account._id,
            name: account.name,
            email: account.email,
            role: account.role,
            image: account.profileImage || null,
          },
          token: {
            accessToken,
            refreshToken,
          },
        },
      };
    } catch (error) {
      throw this.mapError(error, 'Social login failed');
    }
  }

  async resendOtp(email: string, role: string) {
    try {
      // OTP resend only ever applies to a not-yet-verified buyer/seller
      // registration — admin accounts are always created pre-verified via
      // createAdmin() below, so there is no legitimate 'admin' case here.
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne({ email });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.isVerified) {
        throw new UnauthorizedException('User already verified');
      }

      const newOtp = AuthService.generateOtp();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      user.otp = AuthService.hashOtp(newOtp);
      user.otpExpiresAt = otpExpiresAt;
      user.otpAttempts = 0;
      await user.save();

      await this.otpService.sendOtp(user.email, newOtp);

      return {
        message: 'New OTP sent successfully to your email',
        success: true,
        data: {
          userId: user._id,
        },
      };
    } catch (error) {
      throw this.mapError(error, 'Resend OTP failed');
    }
  }

  async verifyOtp(email: string, role: string, otp: string) {
    try {
      // Registration-verification only — activates a not-yet-verified
      // buyer/seller account. Admin accounts are always created
      // pre-verified via createAdmin() below, so there is no legitimate
      // 'admin' case here (closes the other half of the old public
      // self-registration-as-admin path, alongside RegisterDto's fix).
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne({ email });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.isVerified) {
        throw new UnauthorizedException('User already verified');
      }

      await this.checkOtp(user, otp);

      user.isVerified = true;
      user.otp = null as any;
      user.otpExpiresAt = null as any;
      user.otpAttempts = 0;
      await user.save();

      const { accessToken: token, refreshToken } = await this.issueSession(user);

      return {
        message: 'OTP verified successfully',
        success: true,
        data: {
          user: {
            // ✅ user object
            id: user._id, // _id ko id me change karna better rahega Dart model ke liye
            name: user.name,
            email: user.email,
            phone: user.phone,
            address: user.address,
          },
          token: {
            // ✅ token object
            accessToken: token,
            refreshToken: refreshToken,
          },
        },
      };
    } catch (error) {
      throw this.mapError(error, 'OTP verification failed');
    }
  }

  // Deliberately still supports role:'admin' here (and in resetPassword
  // below) — unlike signup/verifyOtp, this never creates an account. It
  // only emails an OTP to the address already on file for an EXISTING
  // record, so an attacker gains nothing by requesting it for someone
  // else's admin email; removing it would just lock real admins out of
  // self-service password recovery for no security benefit.
  async forgotPassword(email: string, role: string) {
    try {
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne({ email });

      // Same response whether or not the account exists — an "email not
      // found" error here would let anyone enumerate which emails are
      // actually registered on Edudeen. Only genuinely sends an OTP when
      // there's a real account to send it to; a non-existent email silently
      // no-ops but still reports success, exactly as a real user's request
      // would look from the outside.
      if (user) {
        const otp = AuthService.generateOtp();
        const otpExpiresAt = new Date(Date.now() + AuthService.OTP_TTL_SECONDS * 1000); // 5 minutes

        user.otp = AuthService.hashOtp(otp);
        user.otpExpiresAt = otpExpiresAt;
        user.otpAttempts = 0;
        await user.save();

        await this.otpService.sendOtp(user.email, otp);
      } else {
        // Nothing to send, but remember that a code was "issued" so a later reset-password attempt for this email
        // behaves like a real account's (see failUnknownAccountOtp).
        const id = `${role}:${String(email).toLowerCase()}`;
        await this.redisService.set(`otp-sim:pending:${id}`, '1', AuthService.OTP_TTL_SECONDS);
        await this.redisService.del(`otp-sim:attempts:${id}`);
      }

      return {
        message: 'If an account exists for this email, a password reset code has been sent.',
        success: true,
        data: null,
      };
    } catch (error) {
      throw this.mapError(error, 'Forgot password failed');
    }
  }

  async resetPassword(
    email: string,
    role: string,
    otp: string,
    newPassword: string,
  ) {
    try {
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) {
        throw new BadRequestException('Password must be between 8 and 72 characters');
      }

      const user = await userModel.findOne({ email });
      if (!user) {
        // Same failure sequence as a real account — don't confirm which emails exist.
        return await this.failUnknownAccountOtp(role, email);
      }

      await this.checkOtp(user, otp);

      const hashedPassword = await bcrypt.hash(newPassword, 10);

      user.password = hashedPassword;
      user.otp = null;
      user.otpExpiresAt = null;
      user.otpAttempts = 0;
      // Revoke every session issued before the reset — a password reset is
      // exactly what a user does after suspecting their account is compromised.
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      await user.save();

      return {
        message: 'Your password has been changed successfully',
        success: true,
      };
    } catch (error) {
      throw this.mapError(error, 'Password reset failed');
    }
  }

  async editProfile(userId: string, role: string, dto: AuthUpdateProfileDto) {
    try {
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new BadRequestException('Invalid role');
      }

      const user = await userModel
        .findByIdAndUpdate(
          userId,
          { $set: dto },
          { returnDocument: 'after', runValidators: true },
        )
        .select('-password -otp -otpExpiresAt');

      if (!user) {
        throw new BadRequestException('User not found');
      }

      return {
        message: 'Profile updated successfully',
        success: true,
        data: user,
      };
    } catch (error) {
      throw this.mapError(error, 'Failed to update profile');
    }
  }

  async getProfile(userId: string, role: string) {
    try {
      let userModel;

      // 1️⃣ Role ke base pe model select
      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid role');
      }

      // 2️⃣ User find karo
      const user = await userModel.findById(userId).select('-password -otp');

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // 3️⃣ Return data
      return {
        message: 'Profile fetched successfully',
        success: true,
        data: user,
      };
    } catch (error) {
      throw this.mapError(error, 'Failed to fetch profile');
    }
  }

  /** The only way an admin account can be created now that public
   *  registration is restricted to 'user'|'seller'. Only reachable via
   *  POST /api/auth/admin/create-admin, which is guarded by
   *  JwtAuthGuard + Roles('admin') — so only an already-logged-in admin
   *  can call it. Created pre-verified (no OTP round-trip needed, since
   *  the caller is already a trusted, authenticated admin). */
  async createAdmin(dto: CreateAdminDto, actor: { adminId: string; ip?: string; userAgent?: string }) {
    try {
      const adminModel = this.databaseService.repositories.adminModel;

      const existing = await adminModel.findOne({ email: dto.email });
      if (existing) {
        throw new UnauthorizedException('An admin with this email already exists');
      }

      const hashedPassword = await bcrypt.hash(dto.password, 10);

      const admin = new adminModel({
        name: dto.name,
        email: dto.email,
        password: hashedPassword,
        phone: dto.phone,
        address: dto.address,
        role: 'admin',
        isVerified: true,
        status: 'active',
      });
      await admin.save();

      try {
        await this.activityLogService.log({
          category: 'security',
          action: 'admin_account_created',
          description: `Admin account "${dto.name}" (${dto.email}) created`,
          actorId: actor.adminId,
          actorRole: 'admin',
          targetId: String(admin._id),
          targetType: 'admin',
          ip: actor.ip,
          userAgent: actor.userAgent,
          isSecurityAlert: true,
        });
      } catch {
        // logging must never break account creation
      }

      return {
        message: 'Admin account created successfully',
        success: true,
        data: {
          id: admin._id,
          name: admin.name,
          email: admin.email,
        },
      };
    } catch (error) {
      throw this.mapError(error, 'Failed to create admin account');
    }
  }
}
