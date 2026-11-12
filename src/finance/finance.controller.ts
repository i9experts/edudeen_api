/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Req, Res, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FinanceService } from './finance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { AddPayoutMethodDto } from './dto/add-payout-method.dto';
import { UpdatePayoutScheduleDto } from './dto/update-payout-schedule.dto';

@ApiTags('Finance & Payouts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/finance')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':storeId/dashboard')
  getDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    return this.financeService.getDashboard(req.user.userId, storeId);
  }

  // Monthly settlement statement — ?month=YYYY-MM (default: current UTC month), ?currency= (default: store baseCurrency)
  @Get(':storeId/monthly-statement')
  getMonthlyStatement(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query('month') month?: string,
    @Query('currency') currency?: string,
  ) {
    return this.financeService.getMonthlyStatement(req.user.userId, storeId, { month, currency });
  }

  // Earnings page (read-only): hero numbers, per-order statement lines, CSV/PDF download.
  @Get(':storeId/earnings-summary')
  getEarningsSummary(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Query('currency') currency?: string) {
    return this.financeService.getEarningsSummary(req.user.userId, storeId, { currency });
  }

  @Get(':storeId/earnings-statement/download')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async downloadEarningsStatement(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Query('month') month: string | undefined,
    @Query('currency') currency: string | undefined,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ) {
    const out = await this.financeService.exportEarningsStatement(req.user.userId, storeId, { month, currency, format }, req.ip, req.headers?.['user-agent']);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }

  @Get(':storeId/earnings-statement')
  getEarningsStatement(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Query('month') month?: string,
    @Query('currency') currency?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.financeService.getEarningsStatement(req.user.userId, storeId, { month, currency, page, limit });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSACTIONS  (static routes before parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':storeId/transactions/export')
  async exportCsv(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
    @Res() res: Response,
  ) {
    const csv = await this.financeService.exportTransactionsCsv(req.user.userId, storeId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${storeId}.csv"`);
    res.send(csv);
  }

  @Get(':storeId/transactions')
  getTransactions(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.financeService.getTransactions(req.user.userId, storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':storeId/analytics')
  getAnalytics(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.financeService.getAnalytics(req.user.userId, storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUTS  (static before parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @Post(':storeId/payouts/request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @UsePipes(new ValidationPipe({ transform: true }))
  requestPayout(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RequestPayoutDto) {
    return this.financeService.requestPayout(req.user.userId, storeId, dto);
  }

  @Get(':storeId/payouts')
  getPayouts(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.financeService.getPayouts(req.user.userId, storeId, query);
  }

  @Get(':storeId/payouts/:payoutId')
  getPayoutById(@Req() req: any, @Param('storeId') storeId: string, @Param('payoutId') payoutId: string) {
    return this.financeService.getPayoutById(req.user.userId, storeId, payoutId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post(':storeId/payout-methods')
  @UsePipes(new ValidationPipe({ transform: true }))
  addPayoutMethod(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AddPayoutMethodDto) {
    return this.financeService.addPayoutMethod(req.user.userId, storeId, dto);
  }

  @Get(':storeId/payout-methods')
  getPayoutMethods(@Req() req: any, @Param('storeId') storeId: string) {
    return this.financeService.getPayoutMethods(req.user.userId, storeId);
  }

  // Static set-default route BEFORE /:methodId
  @Patch(':storeId/payout-methods/:methodId/default')
  setDefault(@Req() req: any, @Param('storeId') storeId: string, @Param('methodId') methodId: string) {
    return this.financeService.setDefaultPayoutMethod(req.user.userId, storeId, methodId);
  }

  @Patch(':storeId/payout-methods/:methodId')
  @UsePipes(new ValidationPipe({ transform: true }))
  updatePayoutMethod(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('methodId') methodId: string,
    @Body() dto: AddPayoutMethodDto,
  ) {
    return this.financeService.updatePayoutMethod(req.user.userId, storeId, methodId, dto);
  }

  @Delete(':storeId/payout-methods/:methodId')
  deletePayoutMethod(@Req() req: any, @Param('storeId') storeId: string, @Param('methodId') methodId: string) {
    return this.financeService.deletePayoutMethod(req.user.userId, storeId, methodId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT SCHEDULE
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':storeId/payout-schedule')
  getPayoutSchedule(@Req() req: any, @Param('storeId') storeId: string, @Query('currency') currency?: string) {
    return this.financeService.getPayoutSchedule(req.user.userId, storeId, currency || 'USD');
  }

  @Patch(':storeId/payout-schedule')
  @UsePipes(new ValidationPipe({ transform: true }))
  updatePayoutSchedule(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdatePayoutScheduleDto) {
    return this.financeService.updatePayoutSchedule(req.user.userId, storeId, dto, req.ip, req.headers['user-agent']);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAX REPORTS  (static generate route BEFORE parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @Post(':storeId/tax-reports/generate')
  generateTaxReport(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query('year') year: string,
    @Query('period') period: string,
    @Query('currency') currency?: string,
  ) {
    return this.financeService.generateTaxReport(
      req.user.userId, storeId,
      parseInt(year) || new Date().getFullYear(),
      period || 'q1',
      currency || 'USD',
    );
  }

  @Get(':storeId/tax-reports')
  getTaxReports(@Req() req: any, @Param('storeId') storeId: string) {
    return this.financeService.getTaxReports(req.user.userId, storeId);
  }
}
