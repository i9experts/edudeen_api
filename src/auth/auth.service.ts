import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { OtpService } from 'src/otp/otp.service';
import { DatabaseService } from 'src/database/databaseservice';
import { OAuth2Client } from 'google-auth-library';
import * as appleSignin from 'apple-signin-auth';
// import axios from 'axios';
import { stat } from 'fs';
import { RedisService } from '../redis/redis.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';

@Injectable()
export class AuthService {
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

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
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
        otp,
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
      throw new UnauthorizedException(error.message || 'Signup failed');
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
      const payload = {
        sub: existingUser._id,
        email: existingUser.email,
        role: existingUser.role,
        tokenVersion: existingUser.tokenVersion ?? 0,
      };

      const token = this.jwtService.sign(payload);

      await this.redisService.set(
        token,
        existingUser._id.toString(),
        24 * 60 * 60,
      );

      // ✅ Refresh Token (long expiry)
      const refreshToken = this.jwtService.sign(payload, {
        expiresIn: '7d',
      });

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
      throw new UnauthorizedException(error.message || 'Login failed');
    }
  }

  /** Verifies the provider token server-side so a forged socialId/email pair can't be used to hijack an account. */
  private async verifySocialToken(
    authProvider: string,
    socialId: string,
    token?: string,
  ) {
    if (!token) {
      throw new UnauthorizedException(
        'Missing provider token for verification',
      );
    }

    if (authProvider === 'google') {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload || payload.sub !== socialId) {
        throw new UnauthorizedException('Invalid Google token');
      }
    } else if (authProvider === 'facebook') {
      const resp = await fetch(
        `https://graph.facebook.com/me?fields=id&access_token=${encodeURIComponent(token)}`,
      );
      const data: any = await resp.json();
      if (!data?.id || data.id !== socialId) {
        throw new UnauthorizedException('Invalid Facebook token');
      }
    } else if (authProvider === 'apple') {
      const payload = await appleSignin.verifyIdToken(token, {
        audience: process.env.APPLE_CLIENT_ID,
      });
      if (!payload || payload.sub !== socialId) {
        throw new UnauthorizedException('Invalid Apple token');
      }
    } else {
      throw new UnauthorizedException('Unsupported auth provider');
    }
  }

  /** Social login resolves against the buyer (User) or seller (Seller) collection based on dto.role (default 'user') — same role-picks-the-model pattern as login()/signup(). */
  async socialLogin(dto: SocialLoginDto) {
    try {
      const {
        authProvider,
        socialId,
        userName,
        name,
        email,
        image,
        fcmToken,
        token,
        role,
      } = dto;

      await this.verifySocialToken(authProvider, socialId, token);

      const targetRole: 'user' | 'seller' = role === 'seller' ? 'seller' : 'user';
      let accountModel;
      if (targetRole === 'seller') {
        accountModel = this.databaseService.repositories.sellerModel;
      } else {
        accountModel = this.databaseService.repositories.userModel;
      }

      let account = await accountModel.findOne({
        $or: [{ email }, { providerId: socialId, authProvider }],
      });

      if (!account) {
        account = new accountModel({
          name: name || userName,
          email,
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
        if (!account.isVerified) {
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

      const payload = {
        sub: account._id,
        email: account.email,
        role: account.role,
        tokenVersion: account.tokenVersion ?? 0,
      };
      const accessToken = this.jwtService.sign(payload);
      await this.redisService.set(
        accessToken,
        account._id.toString(),
        24 * 60 * 60,
      );
      const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

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
      throw new UnauthorizedException(error.message || 'Social login failed');
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

      const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      user.otp = newOtp;
      user.otpExpiresAt = otpExpiresAt;
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
      throw new UnauthorizedException(error.message || 'Resend OTP failed');
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

      if (user.otp !== otp) {
        throw new UnauthorizedException('Invalid OTP');
      }

      if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
        throw new UnauthorizedException('OTP has expired');
      }

      user.isVerified = true;
      user.otp = null as any;
      user.otpExpiresAt = null as any;
      await user.save();

      const payload = {
        sub: user._id,
        email: user.email,
        role: user.role,
        tokenVersion: user.tokenVersion ?? 0,
      };
      const token = this.jwtService.sign(payload, { expiresIn: '1h' });

      await this.redisService.set(token, user._id.toString(), 30 * 60);

      const refreshToken = this.jwtService.sign(payload, {
        expiresIn: '7d',
      });

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
      throw new UnauthorizedException(
        error.message || 'OTP verification failed',
      );
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
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        user.otp = otp;
        user.otpExpiresAt = otpExpiresAt;
        await user.save();

        await this.otpService.sendOtp(user.email, otp);
      }

      return {
        message: 'If an account exists for this email, a password reset code has been sent.',
        success: true,
        data: null,
      };
    } catch (error) {
      throw new UnauthorizedException(
        error.message || 'Forgot password failed',
      );
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

      const user = await userModel.findOne({ email });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.otp !== otp) {
        throw new UnauthorizedException('Invalid OTP');
      }

      const now = new Date();
      if (!user.otpExpiresAt || now > user.otpExpiresAt) {
        throw new UnauthorizedException('OTP has expired');
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);

      user.password = hashedPassword;
      user.otp = null;
      user.otpExpiresAt = null;
      await user.save();

      return {
        message: 'Your password has been changed successfully',
        success: true,
      };
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Password reset failed');
    }
  }

  async editProfile(userId: string, role: string, dto: UpdateProfileDto) {
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
          { new: true, runValidators: true },
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
      throw new BadRequestException(
        error.message || 'Failed to update profile',
      );
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
      throw new UnauthorizedException(
        error.message || 'Failed to fetch profile',
      );
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
      throw new UnauthorizedException(
        error.message || 'Failed to create admin account',
      );
    }
  }
}
