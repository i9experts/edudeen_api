/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Req, Query, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { ChangePlatformPlanDto, CancelPlatformPlanDto, BillingPortalDto, ConfirmOnboardingPaymentMethodDto, SaveOnboardingDraftDto } from './dto/subscribe-platform-plan.dto';
import { RefundInvoiceDto } from '../subscriptions/dto/refund-invoice.dto';

@ApiTags('Platform Plans — Seller')
@Controller('api/platform-plans')
export class SellerPlatformSubscriptionsController {
  constructor(
    private readonly sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/invoices/:invoiceId/refund')
  @UsePipes(new ValidationPipe({ transform: true }))
  adminRefundInvoice(@Req() req: any, @Param('invoiceId') invoiceId: string, @Body() dto: RefundInvoiceDto) {
    return this.sellerPlatformSubscriptionsService.adminRefundInvoice(req.user.userId, invoiceId, dto.amountUSD, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/overview')
  getSellerOverview(@Req() req: any) {
    return this.sellerPlatformSubscriptionsService.getSellerOverview(req.user.userId);
  }

  // Onboarding wizard's Payment step — no store exists yet at this point, so
  // these are literal routes declared ahead of the `:storeId` routes below
  // (same convention as every other literal-vs-param route split in this
  // codebase — a param route registered first would otherwise swallow
  // "onboarding" as if it were a storeId).
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('onboarding/setup-intent')
  createOnboardingSetupIntent(@Req() req: any) {
    return this.sellerPlatformSubscriptionsService.createOnboardingSetupIntent(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('onboarding/confirm-payment-method')
  @UsePipes(new ValidationPipe({ transform: true }))
  confirmOnboardingPaymentMethod(@Req() req: any, @Body() dto: ConfirmOnboardingPaymentMethodDto) {
    return this.sellerPlatformSubscriptionsService.confirmOnboardingPaymentMethod(req.user.userId, dto.setupIntentId);
  }

  // Lets the onboarding wizard resume exactly where the seller left off
  // (step + form data) instead of restarting from step 1 after a
  // reload/lost connection/different device.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('onboarding/progress')
  getOnboardingProgress(@Req() req: any) {
    return this.sellerPlatformSubscriptionsService.getOnboardingProgress(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('onboarding/draft')
  saveOnboardingDraft(@Req() req: any, @Body() dto: SaveOnboardingDraftDto) {
    return this.sellerPlatformSubscriptionsService.saveOnboardingDraft(req.user.userId, dto.step, dto.maxReached, dto.form);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId')
  getStorePlan(@Req() req: any, @Param('storeId') storeId: string) {
    return this.sellerPlatformSubscriptionsService.getStorePlan(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/entitlements')
  async getEntitlements(@Req() req: any, @Param('storeId') storeId: string) {
    await this.sellerPlatformSubscriptionsService.verifyStoreOwnership(storeId, req.user.userId);
    const data = await this.entitlementsService.getEntitlementsSummary(storeId);
    return { success: true, data };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/invoices')
  listInvoices(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.sellerPlatformSubscriptionsService.listInvoices(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Patch(':storeId/change-plan')
  changePlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ChangePlatformPlanDto) {
    return this.sellerPlatformSubscriptionsService.changePlan(req.user.userId, storeId, dto, req.headers['idempotency-key']);
  }

  /** Dry-run of change-plan's exact proration math — what the "confirm your plan change" modal shows before the seller commits. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/preview-change-plan')
  previewChangePlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ChangePlatformPlanDto) {
    return this.sellerPlatformSubscriptionsService.previewChangePlan(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/cancel')
  @UsePipes(new ValidationPipe({ transform: true }))
  cancelSubscription(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CancelPlatformPlanDto) {
    return this.sellerPlatformSubscriptionsService.cancelSubscription(req.user.userId, storeId, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/reactivate')
  reactivateSubscription(@Req() req: any, @Param('storeId') storeId: string) {
    return this.sellerPlatformSubscriptionsService.reactivateSubscription(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/billing-portal')
  @UsePipes(new ValidationPipe({ transform: true }))
  createBillingPortalSession(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BillingPortalDto) {
    return this.sellerPlatformSubscriptionsService.createBillingPortalSession(req.user.userId, storeId, dto.returnUrl);
  }
}
