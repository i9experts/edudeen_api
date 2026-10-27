import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from 'src/database/databaseservice';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { AuthService } from 'src/auth/auth.service';
import { PremiumEntitlementsService } from 'src/premium/premium-entitlements.service';
import { phoneChangeInvalidatesVerification } from 'src/phone-verification/phone-otp.util';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authService: AuthService,
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  private get userModel() {
    return this.db.repositories.userModel;
  }

  async getProfile(userId: string) {
    const user = await this.userModel
      .findById(userId)
      .select('-password -otp -otpExpiresAt -otpAttempts -tokenVersion');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    user.name = dto.name ?? user.name;
    if (dto.phone !== undefined && user.phoneVerified && phoneChangeInvalidatesVerification(user.phoneE164, dto.phone)) {
      user.phoneVerified = false; // a changed number must be verified again
      user.phoneE164 = null;
    }
    user.phone = dto.phone ?? user.phone;
    user.profileImage = dto.profileImage ?? user.profileImage;
    user.address = dto.address ?? user.address;
    user.currencyPreference = dto.currencyPreference ?? user.currencyPreference;
    user.displayCurrency = dto.displayCurrency ?? user.displayCurrency;
    user.detectedCountry = dto.detectedCountry ?? user.detectedCountry;

    // The login email cannot be swapped by a signed-in session alone: it would hand the account to whoever holds a
    // stolen token (and leave the real owner unverified with no OTP). Needs a verified change-email flow.
    if (dto.email && dto.email.toLowerCase() !== String(user.email).toLowerCase()) {
      throw new BadRequestException('Email cannot be changed from here. Contact support to change your login email.');
    }

    await user.save();
    const updatedUser = await this.userModel
      .findById(userId)
      .select('-password -otp -otpExpiresAt -otpAttempts -tokenVersion');

    return {
      success: true,
      message: 'Profile updated successfully',
      data: updatedUser,
    };
  }

  // Buyers and sellers are separate Mongoose collections (see
  // auth.service.ts's login/editProfile/etc.) — change-password must branch
  // on role the same way, or it 404s for every seller/admin caller.
  async changePassword(userId: string, role: string, dto: ChangePasswordDto) {
    const { currentPassword, newPassword } = dto;

    let model;
    if (role === 'user') {
      model = this.db.repositories.userModel;
    } else if (role === 'seller') {
      model = this.db.repositories.sellerModel;
    } else if (role === 'admin') {
      model = this.db.repositories.adminModel;
    } else {
      throw new UnauthorizedException('Invalid user type');
    }

    const user = await model.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (!user.password) {
      throw new BadRequestException(
        'Cannot change password for social-login accounts',
      );
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch)
      throw new UnauthorizedException('Current password is incorrect');

    user.password = await bcrypt.hash(newPassword, 10);
    // Revoke every other session (old access/refresh tokens carry the old
    // tokenVersion) and hand back a fresh pair so this device stays logged in.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    const token = await this.authService.issueSession(user);

    return {
      success: true,
      message: 'Password changed successfully',
      data: { token },
    };
  }

  /** Sign out every other device: bump tokenVersion (old tokens stop working) and give this device a fresh pair. */
  async logoutOtherDevices(userId: string, role: string) {
    const repos = this.db.repositories;
    const model: any = role === 'user' ? repos.userModel : role === 'seller' ? repos.sellerModel : role === 'admin' ? repos.adminModel : null;
    if (!model) throw new UnauthorizedException('Invalid user type');
    const user = await model.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    const token = await this.authService.issueSession(user);
    return { success: true, message: 'Signed out of all other devices', data: { token } };
  }

  // Buyers and sellers are separate collections (see changePassword's comment
  // above) — this must branch on role too, or a seller's delete request 404s
  // against the buyer collection while their seller account stays fully live.
  async deleteAccount(userId: string, role: string, dto: DeleteAccountDto) {
    if (role !== 'user' && role !== 'seller') {
      throw new UnauthorizedException('Invalid user type');
    }

    const model: any = role === 'seller' ? this.db.repositories.sellerModel : this.userModel;
    const account = await model.findById(userId);
    if (!account) throw new NotFoundException(role === 'seller' ? 'Seller not found' : 'User not found');

    // 1) A stolen session must not be enough to destroy an account: typed confirmation + the password.
    //    (Social-only accounts have no password, so for them the typed word is the confirmation.)
    if (String(dto?.confirm ?? '').trim().toUpperCase() !== 'DELETE') {
      throw new BadRequestException('Type DELETE to confirm that you want to delete your account.');
    }
    if (account.password) {
      if (!dto.password) throw new BadRequestException('Enter your password to delete your account.');
      if (!(await bcrypt.compare(dto.password, account.password))) {
        throw new UnauthorizedException('Password is incorrect');
      }
    }

    // 2) Nothing may be left half-finished: open orders, active Premium, money owed or held.
    const blockers = await this.deletionBlockers(userId, role);
    if (blockers.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ACCOUNT_DELETE_BLOCKED',
        message: `You can't delete your account yet: ${blockers.join(' ')}`,
        blockers,
      });
    }

    if (role === 'seller') {
      return this.deleteSellerAccount(userId);
    }

    const user = account;

    user.isDelete = true;
    user.status = 'deleted';
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();

    return {
      success: true,
      message: 'Account deactivated successfully',
    };
  }

  /** Human-readable reasons this account cannot be deleted right now (empty = fine to delete). */
  private async deletionBlockers(accountId: string, role: 'user' | 'seller'): Promise<string[]> {
    const { orderModel, payoutModel, sellerBalanceModel } = this.db.repositories;
    const OPEN = ['pending', 'processing', 'partially_shipped'];
    const out: string[] = [];
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

    if (role === 'user') {
      const open = await orderModel.countDocuments({ userId: accountId, orderStatus: { $in: OPEN } });
      if (open > 0) out.push(`${plural(open, 'order')} still in progress - wait until ${open === 1 ? 'it is' : 'they are'} delivered or cancelled.`);
      const ent = this.premium ? await this.premium.getEntitlements(accountId).catch(() => null) : null;
      if (ent?.isPremium) out.push('Your Edudeen Premium membership is still active - let it end before deleting your account.');
      return out;
    }

    const open = await orderModel.countDocuments({ 'sellerOrders.sellerId': accountId, orderStatus: { $in: OPEN } });
    if (open > 0) out.push(`${plural(open, 'customer order')} still in progress - fulfil or cancel ${open === 1 ? 'it' : 'them'} first.`);
    const payouts = await payoutModel.countDocuments({ sellerId: accountId, status: { $in: ['pending', 'processing'] } });
    if (payouts > 0) out.push(`${plural(payouts, 'payout')} still being processed.`);
    const balances = await sellerBalanceModel.find({ sellerId: accountId }).select('availableBalance pendingBalance').lean();
    if (balances.some((b: any) => (b.availableBalance ?? 0) !== 0 || (b.pendingBalance ?? 0) !== 0)) {
      out.push('Your store wallet still holds money (or owes a refund balance) - withdraw it or contact support to settle it first.');
    }
    return out;
  }

  // Deactivates the seller account AND suspends every store they own, so
  // deleting an account doesn't leave live listings/storefronts behind under
  // a "deleted" seller — every public-facing store/product query in this
  // codebase (marketplace, search, follows, top stores, etc.) already filters
  // on `status: 'active'`, so this alone removes them everywhere without
  // needing a separate pass over each store's products.
  private async deleteSellerAccount(sellerId: string) {
    const seller = await this.db.repositories.sellerModel.findById(sellerId);
    if (!seller) throw new NotFoundException('Seller not found');

    seller.isDelete = true;
    seller.status = 'deleted';
    seller.tokenVersion = (seller.tokenVersion ?? 0) + 1;
    await seller.save();

    await this.db.repositories.storeModel.updateMany(
      { sellerId, isDelete: false },
      { $set: { status: 'suspended' } },
    );

    return {
      success: true,
      message: 'Account deactivated successfully',
    };
  }
}
