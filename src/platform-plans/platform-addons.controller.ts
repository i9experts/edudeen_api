/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PlatformAddonsService } from './platform-addons.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PurchaseAddonDto } from './dto/purchase-addon.dto';

@ApiTags('Platform Plans — Add-ons')
@Controller('api/platform-plans')
export class PlatformAddonsController {
  constructor(private readonly addonsService: PlatformAddonsService) {}

  // Static "admin/addons" registered before the parameterized ":storeId/addons"
  // routes below — otherwise "admin" would be matched as a :storeId value.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/addons')
  adminListAddons(@Query() query: any) {
    return this.addonsService.adminListAddonPurchases(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/addons')
  @UsePipes(new ValidationPipe({ transform: true }))
  purchaseAddon(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PurchaseAddonDto) {
    return this.addonsService.purchaseAddon(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/addons')
  listAddons(@Req() req: any, @Param('storeId') storeId: string) {
    return this.addonsService.listAddons(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/addons/:addonId')
  cancelAddon(@Req() req: any, @Param('storeId') storeId: string, @Param('addonId') addonId: string) {
    return this.addonsService.cancelAddon(req.user.userId, storeId, addonId);
  }
}
