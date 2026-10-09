import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from 'src/database/databaseservice';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuthService } from 'src/auth/auth.service';
import { phoneChangeInvalidatesVerification } from 'src/phone-verification/phone-otp.util';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authService: AuthService,
  ) {}

  private get userModel() {
    return this.db.repositories.userModel;
  }

  async getProfile(userId: string) {
    const user = await this.userModel
      .findById(userId)
      .select('-password -otp -otpExpiresAt');
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

    if (dto.email && dto.email !== user.email) {
      const emailExists = await this.userModel.findOne({ email: dto.email });
      if (emailExists) throw new BadRequestException('Email already in use');
      user.email = dto.email;
      user.isVerified = false;
    }

    await user.save();
    const updatedUser = await this.userModel
      .findById(userId)
      .select('-password -otp -otpExpiresAt');

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

  // Buyers and sellers are separate collections (see changePassword's comment
  // above) — this must branch on role too, or a seller's delete request 404s
  // against the buyer collection while their seller account stays fully live.
  async deleteAccount(userId: string, role: string) {
    if (role === 'seller') {
      return this.deleteSellerAccount(userId);
    }

    if (role !== 'user') {
      throw new UnauthorizedException('Invalid user type');
    }

    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    user.isDelete = true;
    user.status = 'deleted';
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();

    return {
      success: true,
      message: 'Account deactivated successfully',
    };
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
