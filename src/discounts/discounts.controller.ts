/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DiscountsService } from './discounts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateAutomaticDiscountDto } from './dto/create-automatic-discount.dto';
import { UpdateAutomaticDiscountDto } from './dto/update-automatic-discount.dto';

@ApiTags('Discounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/discounts')
export class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Post(':storeId')
  @UsePipes(new ValidationPipe({ transform: true }))
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateAutomaticDiscountDto) {
    return this.discountsService.createDiscount(req.user.userId, storeId, dto);
  }

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.discountsService.listDiscounts(req.user.userId, storeId);
  }

  @Patch(':storeId/:discountId')
  @UsePipes(new ValidationPipe({ transform: true }))
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('discountId') discountId: string, @Body() dto: UpdateAutomaticDiscountDto) {
    return this.discountsService.updateDiscount(req.user.userId, storeId, discountId, dto);
  }

  @Delete(':storeId/:discountId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('discountId') discountId: string) {
    return this.discountsService.deleteDiscount(req.user.userId, storeId, discountId);
  }
}
