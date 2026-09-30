/* eslint-disable prettier/prettier */
import { SpendCreditDto } from './dto/spend-credit.dto';
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Req, Res, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { EstimatePlanHealthDto } from './dto/estimate-plan-health.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { RefundInvoiceDto } from './dto/refund-invoice.dto';

@ApiTags('Subscriptions')
@Controller('api/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — static routes registered first (see Orders/POS controllers for
  // the same "static before parameterized" convention used elsewhere).
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('public/:storeId/plans')
  browsePlans(@Param('storeId') storeId: string) {
    return this.subscriptionsService.browsePlans(storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  // Tighter than the platform default (100/min) — this endpoint moves money
  // and creates provider-side objects, so it's worth a stricter ceiling even
  // with idempotency-key protection already in front of it.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('subscribe')
  @UsePipes(new ValidationPipe({ transform: true }))
  subscribe(@Req() req: any, @Body() dto: SubscribeDto) {
    return this.subscriptionsService.subscribe(req.user.userId, dto, req.headers['idempotency-key']);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my')
  listMySubscriptions(@Req() req: any, @Query() query: any) {
    return this.subscriptionsService.listMySubscriptions(req.user.userId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('my/setup-intent')
  createSetupIntent(@Req() req: any) {
    return this.subscriptionsService.createSetupIntent(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('my/billing-portal')
  createBillingPortalSession(@Req() req: any, @Body() body: { returnUrl: string }) {
    return this.subscriptionsService.createBillingPortalSession(req.user.userId, body.returnUrl);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/benefits/:storeId')
  getBenefitsSummary(@Req() req: any, @Param('storeId') storeId: string) {
    return this.subscriptionsService.getBenefitsSummary(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/credits')
  getCreditWallets(@Req() req: any) {
    return this.subscriptionsService.getCreditWallets(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('my/credits/:storeId/spend')
  spendCredit(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() body: SpendCreditDto,
  ) {
    return this.subscriptionsService.spendCredit(req.user.userId, storeId, body.creditType, body.amount, body.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/notification-preferences')
  getNotificationPreferences(@Req() req: any) {
    return this.subscriptionsService.getNotificationPreferences(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/notification-preferences')
  // Validate only (no transform): body is spread into a Mongo $set.
  @UsePipes(new ValidationPipe())
  updateNotificationPreferences(@Req() req: any, @Body() dto: UpdateNotificationPreferencesDto) {
    return this.subscriptionsService.updateNotificationPreferences(req.user.userId, { ...dto });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/:id')
  getMySubscriptionById(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.getMySubscriptionById(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/:id/timeline')
  getSubscriptionTimeline(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.getSubscriptionTimeline(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/pause')
  selfPause(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.selfPauseSubscription(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/resume')
  selfResume(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.selfResumeSubscription(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/cancel')
  @UsePipes(new ValidationPipe({ transform: true }))
  selfCancel(@Req() req: any, @Param('id') id: string, @Query('atPeriodEnd') atPeriodEnd: string, @Body() body: CancelSubscriptionDto) {
    return this.subscriptionsService.selfCancelSubscription(req.user.userId, id, atPeriodEnd === 'true', body.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Patch('my/:id/change-plan')
  @UsePipes(new ValidationPipe({ transform: true }))
  changePlan(@Req() req: any, @Param('id') id: string, @Body() dto: ChangePlanDto) {
    return this.subscriptionsService.changePlan(req.user.userId, id, dto, req.headers['idempotency-key']);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════════════════

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/overview')
  adminOverview() {
    return this.subscriptionsService.adminGetOverview();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/revenue-breakdown')
  adminRevenueBreakdown(@Query() query: any) {
    return this.subscriptionsService.adminGetRevenueBreakdown(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/churn-cohorts')
  adminChurnCohorts(@Query() query: any) {
    return this.subscriptionsService.adminGetChurnCohorts(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/ltv')
  adminLtv() {
    return this.subscriptionsService.adminGetLtv();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/webhooks')
  adminWebhookHistory(@Query() query: any) {
    return this.subscriptionsService.adminGetWebhookHistory(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/webhooks/:id/retry')
  adminRetryWebhook(@Param('id') id: string) {
    return this.subscriptionsService.adminRetryWebhook(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/stores')
  adminStoreBreakdown(@Query() query: any) {
    return this.subscriptionsService.adminGetStoreBreakdown(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/stores/:storeId')
  adminStoreDetail(@Param('storeId') storeId: string) {
    return this.subscriptionsService.adminGetStoreDetail(storeId);
  }

  // ── Dunning / retry visibility ──────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/payment-failures')
  adminPaymentFailures(@Query() query: any) {
    return this.subscriptionsService.adminGetPaymentFailures(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/subscriptions/:id/payment-attempts')
  adminSubscriptionPaymentAttempts(@Param('id') id: string, @Query() query: any) {
    return this.subscriptionsService.adminGetSubscriptionPaymentAttempts(id, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/subscriptions/:id')
  adminSubscriptionDetail(@Param('id') id: string) {
    return this.subscriptionsService.adminGetSubscriptionDetail(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/invoices/:invoiceId/refund')
  @UsePipes(new ValidationPipe({ transform: true }))
  adminRefundInvoice(@Req() req: any, @Param('invoiceId') invoiceId: string, @Body() dto: RefundInvoiceDto) {
    return this.subscriptionsService.adminRefundInvoice(req.user.userId, invoiceId, dto.amountUSD, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('admin/plans/:id/suspend')
  adminSuspendPlan(@Param('id') id: string) {
    return this.subscriptionsService.adminSuspendPlan(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('admin/plans/:id/unsuspend')
  adminUnsuspendPlan(@Param('id') id: string) {
    return this.subscriptionsService.adminUnsuspendPlan(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — store-scoped (parameterized routes registered last)
  // ═══════════════════════════════════════════════════════════════════════════

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/plans')
  createPlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePlanDto) {
    return this.subscriptionsService.createPlan(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/plans')
  listPlans(@Req() req: any, @Param('storeId') storeId: string) {
    return this.subscriptionsService.listPlans(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/plans/:id')
  getPlanById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.getPlanById(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/plans/:id')
  updatePlan(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.subscriptionsService.updatePlan(req.user.userId, storeId, id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/plans/:id')
  archivePlan(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Query('force') force: string) {
    return this.subscriptionsService.archivePlan(req.user.userId, storeId, id, force === 'true');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/dashboard')
  getDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    return this.subscriptionsService.getDashboard(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/analytics/advanced')
  getAdvancedAnalytics(@Req() req: any, @Param('storeId') storeId: string) {
    return this.subscriptionsService.getAdvancedSellerAnalytics(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/export')
  async exportCsv(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.subscriptionsService.exportCsv(req.user.userId, storeId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="subscribers-${storeId}.csv"`);
    res.send(csv);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/subscribers')
  listSubscriptions(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.subscriptionsService.listSubscriptions(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/subscribers/:id')
  getSubscriptionById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.getSubscriptionById(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/subscribers/:id/pause')
  pauseSubscription(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.pauseSubscription(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/subscribers/:id/resume')
  resumeSubscription(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.resumeSubscription(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/subscribers/:id/cancel')
  @UsePipes(new ValidationPipe({ transform: true }))
  cancelSubscription(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Query('atPeriodEnd') atPeriodEnd: string,
    @Body() body: CancelSubscriptionDto,
  ) {
    return this.subscriptionsService.cancelSubscription(req.user.userId, storeId, id, atPeriodEnd === 'true', body.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/subscribers/:id/invoices/:invoiceId/refund')
  @UsePipes(new ValidationPipe({ transform: true }))
  sellerRefundInvoice(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: RefundInvoiceDto,
  ) {
    return this.subscriptionsService.sellerRefundInvoice(req.user.userId, storeId, id, invoiceId, dto.amountUSD, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/plans/estimate-health')
  estimatePlanHealth(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() body: EstimatePlanHealthDto,
  ) {
    return this.subscriptionsService.estimatePlanHealth(req.user.userId, storeId, body.benefits ?? [], body.monthlyPriceUSD);
  }
}
