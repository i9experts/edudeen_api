/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminFinanceService } from './admin-finance.service';
import { AdminAnalyticsQueryDto } from '../admin-analytics/dto/admin-analytics-query.dto';
import { SellerBalancesQueryDto } from './dto/seller-balances-query.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transactions-query.dto';
import { PayoutQueueQueryDto } from './dto/payout-queue-query.dto';
import { RejectPayoutDto } from './dto/reject-payout.dto';
import { ManualPayoutDto } from './dto/manual-payout.dto';
import { AdminFinanceExportQueryDto } from './dto/admin-finance-export-query.dto';
import { VerifyPayoutMethodDto } from './dto/verify-payout-method.dto';

@ApiTags('Admin Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/finance')
export class AdminFinanceController {
  constructor(private readonly adminFinanceService: AdminFinanceService) {}

  // ─── Dashboard ───────────────────────────────────────────────────────────

  @Get('overview')
  getOverview(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getOverview(query);
  }

  @Get('revenue-over-time')
  getRevenueOverTime(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getRevenueOverTime(query);
  }

  @Get('commission-over-time')
  getCommissionOverTime(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getCommissionOverTime(query);
  }

  // ─── Reconciliation & FX exposure ───────────────────────────────────────

  @Get('reconciliation')
  getReconciliation(@Query('days') days?: string) {
    return this.adminFinanceService.getReconciliation(days ? Number(days) : 1);
  }

  @Get('reconciliation/history')
  getReconciliationHistory(@Query('limit') limit?: string) {
    return this.adminFinanceService.getReconciliationHistory(limit ? Number(limit) : 30);
  }

  @Get('fx-exposure')
  getFxExposure() {
    return this.adminFinanceService.getFxExposure();
  }

  // ─── Seller balances & drill-down ────────────────────────────────────────

  @Get('sellers/balances')
  getSellerBalances(@Query() query: SellerBalancesQueryDto) {
    return this.adminFinanceService.getSellerBalances(query);
  }

  @Get('sellers/:storeId')
  getSellerFinancialDetails(@Param('storeId') storeId: string) {
    return this.adminFinanceService.getSellerFinancialDetails(storeId);
  }

  @Get('sellers/:storeId/transactions')
  getSellerTransactions(@Param('storeId') storeId: string, @Query() query: AdminTransactionsQueryDto) {
    return this.adminFinanceService.getSellerTransactions(storeId, query);
  }

  @Post('sellers/:storeId/payouts/manual')
  createManualPayout(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ManualPayoutDto) {
    return this.adminFinanceService.createManualPayout(storeId, req.user.userId, dto.amount, dto.payoutMethodId, dto.notes, req.ip, req.headers['user-agent']);
  }

  // ─── Platform transactions ───────────────────────────────────────────────

  @Get('transactions')
  getPlatformTransactions(@Query() query: AdminTransactionsQueryDto) {
    return this.adminFinanceService.getPlatformTransactions(query);
  }

  // ─── Payout queue & lifecycle ────────────────────────────────────────────

  @Get('payouts')
  getPayoutQueue(@Query() query: PayoutQueueQueryDto) {
    return this.adminFinanceService.getPayoutQueue(query);
  }

  @Patch('payouts/:payoutId/approve')
  approvePayout(@Req() req: any, @Param('payoutId') payoutId: string) {
    return this.adminFinanceService.approvePayout(payoutId, req.user.userId, req.ip, req.headers['user-agent']);
  }

  @Patch('payouts/:payoutId/reject')
  rejectPayout(@Req() req: any, @Param('payoutId') payoutId: string, @Body() dto: RejectPayoutDto) {
    return this.adminFinanceService.rejectPayout(payoutId, req.user.userId, dto.reason, req.ip, req.headers['user-agent']);
  }

  @Patch('payouts/:payoutId/retry')
  retryPayout(@Req() req: any, @Param('payoutId') payoutId: string) {
    return this.adminFinanceService.retryPayout(payoutId, req.user.userId, req.ip, req.headers['user-agent']);
  }

  @Post('process-clearing')
  triggerClearingBalances(@Req() req: any) {
    return this.adminFinanceService.triggerClearingBalances({ adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Post('process-scheduled-payouts')
  triggerScheduledPayouts(@Req() req: any) {
    return this.adminFinanceService.triggerScheduledPayouts({ adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  // ─── Payout method verification ──────────────────────────────────────────

  @Get('payout-methods/pending-verification')
  getPendingVerificationMethods() {
    return this.adminFinanceService.getPendingVerificationMethods();
  }

  @Patch('sellers/:storeId/payout-methods/:methodId/verify')
  verifyPayoutMethod(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('methodId') methodId: string,
    @Body() dto: VerifyPayoutMethodDto,
  ) {
    return this.adminFinanceService.verifyPayoutMethod(storeId, methodId, req.user.userId, dto.approve, dto.note);
  }

  // ─── Reports ─────────────────────────────────────────────────────────────

  @Get('reports/refunds')
  getRefundReport(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getRefundReport(query);
  }

  @Get('reports/tax')
  getTaxReports(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getTaxReports(query);
  }

  @Get('reports/settlement')
  getSettlementReport(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getSettlementReport(query);
  }

  @Get('reports/monthly')
  getMonthlyReport(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getMonthlyReport(query);
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  @Get('export')
  async export(@Query() query: AdminFinanceExportQueryDto, @Res() res: Response) {
    if (query.format === 'pdf') {
      const pdf = await this.adminFinanceService.exportPdf(query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="admin-finance-report.pdf"');
      res.send(pdf);
      return;
    }

    const csv = await this.adminFinanceService.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="admin-finance-${query.section ?? 'transactions'}.csv"`);
    res.send(csv);
  }
}
