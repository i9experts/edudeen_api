/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';

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
      const updated = await this.databaseService.repositories.addressModel.findOneAndUpdate(
        { _id: addressId, userId },
        { $set: body },
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
