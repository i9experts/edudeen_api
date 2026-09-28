/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { GiftCardsService } from './gift-cards.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateGiftCardSettingsDto } from './dto/update-gift-card-settings.dto';
import { IssueManualGiftCardDto } from './dto/issue-manual-gift-card.dto';
import { CreatePurchaseIntentDto } from './dto/create-purchase-intent.dto';

@ApiTags('Gift Cards')
@Controller('api/gift-cards')
export class GiftCardsController {
  constructor(private readonly giftCardsService: GiftCardsService) {}

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/settings')
  getSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.giftCardsService.getSettings(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/settings')
  @UsePipes(new ValidationPipe({ transform: true }))
  updateSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateGiftCardSettingsDto) {
    return this.giftCardsService.updateSettings(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/issue')
  @UsePipes(new ValidationPipe({ transform: true }))
  issueManual(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: IssueManualGiftCardDto) {
    return this.giftCardsService.issueManual(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId')
  listGiftCards(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.giftCardsService.listGiftCards(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/:giftCardId/disable')
  disableGiftCard(@Req() req: any, @Param('storeId') storeId: string, @Param('giftCardId') giftCardId: string) {
    return this.giftCardsService.disableGiftCard(req.user.userId, storeId, giftCardId);
  }

  // ── Buyer-facing ──────────────────────────────────────────────────────────

  @Get(':storeId/public-settings')
  getPublicSettings(@Param('storeId') storeId: string) {
    return this.giftCardsService.getPublicSettings(storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':storeId/purchase-intent')
  @UsePipes(new ValidationPipe({ transform: true }))
  createPurchaseIntent(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePurchaseIntentDto) {
    return this.giftCardsService.createPurchaseIntent(req.user.userId, storeId, dto);
  }
}
