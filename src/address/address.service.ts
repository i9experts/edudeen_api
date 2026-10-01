/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';

const ADDRESS_TEXT_FIELDS = ['label', 'recipientName', 'phoneNumber', 'addressLine1', 'addressLine2', 'state', 'city', 'zipCode', 'country'] as const;

/**
 * The only address fields a user may write. updateAddress used to `$set` the whole request body, so a user could
 * rewrite `userId` (hand an address to someone else), flip `isDelete` (resurrect a deleted one) or set `status`.
 */
export function pickAddressUpdate(body: unknown): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ADDRESS_TEXT_FIELDS) {
    if (src[key] === undefined) continue;
    const v = src[key];
    if (v === null && (key === 'addressLine2' || key === 'country')) { out[key] = null; continue; }
    if (typeof v !== 'string' || v.length > 200) throw new BadRequestException(`${key} must be a string of at most 200 characters`);
    out[key] = v;
  }
  for (const key of ['latitude', 'longitude'] as const) {
    if (src[key] === undefined) continue;
    const v = src[key];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new BadRequestException(`${key} must be a number`);
    out[key] = v;
  }
  if (src.isDefault !== undefined) {
    if (typeof src.isDefault !== 'boolean') throw new BadRequestException('isDefault must be a boolean');
    out.isDefault = src.isDefault;
  }
  return out;
}

@Injectable()
export class AddressService {
 constructor(private readonly databaseService: DatabaseService) {}



  // ➕ Add Address
  async addAddress(userId: string, body: any) {
    try {
  
      // 1️⃣ Check user exist
      const user = await this.databaseService.repositories.userModel.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (body.isDefault) {
        await this.databaseService.repositories.addressModel.updateMany(
            { userId, isDelete: false },
          { $set: { isDefault: false } },
        );

      }

      // 2️⃣ Create new address
  const address = await this.databaseService.repositories.addressModel.create({
  userId,
  label: body.label, // Home, Work, Other
  recipientName: body.recipientName,
  phoneNumber: body.phoneNumber,
  addressLine1: body.addressLine1,
  addressLine2: body.addressLine2 || null,
  state: body.state,
  city: body.city,
  zipCode: body.zipCode,
  country: body.country || null,
  latitude: body.latitude ?? null,
  longitude: body.longitude ?? null,
  isDefault: body.isDefault || false,
});
      return {
        success: true,
        message: 'Address added successfully',
        data: address,
      };
    } catch (error) {
      return {
        message: error.message,
      };
    }
  }
  


 async getUserAddresses(userId: string) {
    try {
      const addresses = await this.databaseService.repositories.addressModel.find({
        userId,
        isDelete: false,
      });

      return {
        message: 'Addresses fetched successfully',
        data: addresses,
      };
    } catch (error) {
      return {
        message: error.message,
      };
    }
  }

    async updateAddress(userId: string, addressId: string, body: any) {
    try {
      if (typeof addressId !== 'string' || !isValidObjectId(addressId)) throw new BadRequestException('Invalid addressId');
      const fields = pickAddressUpdate(body);
      if (fields.isDefault === true) {
        await this.databaseService.repositories.addressModel.updateMany(
          { userId, isDelete: false, _id: { $ne: addressId } },
          { $set: { isDefault: false } },
        );
      }
      const updated = await this.databaseService.repositories.addressModel.findOneAndUpdate(
        { _id: addressId, userId, isDelete: false },
        { $set: fields },
        { returnDocument: 'after' },
      );

      if (!updated) {
        throw new Error('Address not found');
      }

      return {
        message: 'Address updated successfully',
        data: updated,
      };
    } catch (error) {
      return {
        message: error.message,
      };
    }
  }

  async getAddressById(userId: string, addressId: string) {
  try {

    const address = await this.databaseService.repositories.addressModel.findOne({ _id: addressId, userId });

    return {
      message: 'Address fetched successfully',
      data: address,
    };

  } catch (error) {

    return {
      message: error.message,
    };

  }
}
  
  // service

async getDefaultAddress(userId: string) {
  try {

    const address =
      await this.databaseService.repositories.addressModel.findOne({
        userId,
        isDefault: true,
        isDelete: false,
      });

    if (!address) {
      return {
        success: false,
        message: 'Default address not found',
        data: null,
      };
    }

    return {
      success: true,
      message: 'Default address fetched successfully',
      data: address,
    };

  } catch (error) {

    return {
      success: false,
      message: error.message || 'Something went wrong',
    };

  }
}

  async deleteAddress(userId: string, addressId: string) {
    try {
      const deleted = await this.databaseService.repositories.addressModel.findOneAndUpdate(
        { _id: addressId, userId },
        { $set: { isDelete: true } },
        { returnDocument: 'after' },
      );

      if (!deleted) {
        return {
          success: false,
          message: 'Address not found',
        };
      }

      // If the deleted address was the default, promote another one so the
      // user isn't left without a default (matches setDefaultAddress's
      // "only one default at a time" invariant).
      if (deleted.isDefault) {
        await this.databaseService.repositories.addressModel.findOneAndUpdate(
          { userId, isDelete: false },
          { $set: { isDefault: true } },
        );
      }

      return {
        success: true,
        message: 'Address deleted successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }

  async setDefaultAddress(userId: string, addressId: string) {
    try {
      // remove old default
      await this.databaseService.repositories.addressModel.updateMany(
        { userId, isDelete: false },
        { $set: { isDefault: false } },
      );

      // set new default
      const updated = await this.databaseService.repositories.addressModel.findByIdAndUpdate(
        addressId,
        { isDefault: true },
        { returnDocument: 'after' },
      );

      return {
        success: true,
        message: 'Default address updated',
        data: updated,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }

  

}
