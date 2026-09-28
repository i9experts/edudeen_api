import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  Get,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AddressService } from './address.service';

// Served on both paths: the web app calls `/api/address/*` (like every other
// module), while existing clients (mobile) already call `/address/*`.
@Controller(['address', 'api/address'])
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @UseGuards(JwtAuthGuard)
  @Post('add-address')
  async addAddress(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;

    return this.addressService.addAddress(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('update-address')
  async updateAddress(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    const { addressId, ...updateData } = body;

    return this.addressService.updateAddress(userId, addressId, updateData);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-address-by-id/:addressId')
  async getAddressById(@Req() req: any, @Param('addressId') addressId: string) {
    const { userId } = req.user;
    return this.addressService.getAddressById(userId, addressId);
  }
  @UseGuards(JwtAuthGuard)
  @Get('getMyAddresses')
  async getMyAddresses(@Req() req: any) {
    const { userId } = req.user;
    return this.addressService.getUserAddresses(userId);
  }

  // controller

  @UseGuards(JwtAuthGuard)
  @Get('getDefaultAddress')
  async getDefaultAddress(@Req() req: any) {
    const { userId } = req.user;
    return this.addressService.getDefaultAddress(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('setDefaultAddress/:addressId')
  async setDefaultAddress(
    @Req() req: any,
    @Param('addressId') addressId: string,
  ) {
    const { userId } = req.user;
    return this.addressService.setDefaultAddress(userId, addressId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('delete-address/:addressId')
  async deleteAddress(@Req() req: any, @Param('addressId') addressId: string) {
    const { userId } = req.user;
    return this.addressService.deleteAddress(userId, addressId);
  }
}
