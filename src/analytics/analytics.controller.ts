/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { TopProductsQueryDto } from './dto/top-products-query.dto';
import { ProductPerformanceQueryDto } from './dto/product-performance-query.dto';
import { ExportQueryDto } from './dto/export-query.dto';

@ApiTags('Seller Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/seller/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('today')
  getTodaySummary(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getTodaySummary(req.user.userId, query.storeId);
  }

  // ─── Every route below accepts an optional `storeId` on its DTO — present,
  // it scopes to that one store (ownership verified); omitted, it aggregates
  // across every store the seller owns, powering the cross-store view.

  @Get('overview')
  getOverview(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getOverview(req.user.userId, query.storeId, query);
  }

  @Get('revenue-over-time')
  getRevenueOverTime(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getRevenueOverTime(req.user.userId, query.storeId, query);
  }

  @Get('orders-over-time')
  getOrdersOverTime(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getOrdersOverTime(req.user.userId, query.storeId, query);
  }

  @Get('traffic-sources')
  async getTrafficSources(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    await this.analyticsService.assertAdvancedAnalytics(req.user.userId, query.storeId);
    return this.analyticsService.getTrafficSources(req.user.userId, query.storeId, query);
  }

  @Get('top-products')
  getTopProducts(@Req() req: any, @Query() query: TopProductsQueryDto) {
    return this.analyticsService.getTopProducts(req.user.userId, query.storeId, query);
  }

  @Get('customers')
  async getCustomerAnalytics(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    await this.analyticsService.assertAdvancedAnalytics(req.user.userId, query.storeId);
    return this.analyticsService.getCustomerAnalytics(req.user.userId, query.storeId, query);
  }

  @Get('products/performance')
  async getProductPerformance(@Req() req: any, @Query() query: ProductPerformanceQueryDto) {
    await this.analyticsService.assertAdvancedAnalytics(req.user.userId, query.storeId);
    return this.analyticsService.getProductPerformance(req.user.userId, query.storeId, query);
  }

  @Get('inventory-insights')
  async getInventoryInsights(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    await this.analyticsService.assertAdvancedAnalytics(req.user.userId, query.storeId);
    return this.analyticsService.getInventoryInsights(req.user.userId, query.storeId);
  }

  @Get('payment-methods')
  async getPaymentMethods(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    await this.analyticsService.assertAdvancedAnalytics(req.user.userId, query.storeId);
    return this.analyticsService.getPaymentMethods(req.user.userId, query.storeId, query);
  }

  @Get('revenue-breakdown')
  async getRevenueBreakdown(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    await this.analyticsService.assertAdvancedAnalytics(req.user.userId, query.storeId);
    return this.analyticsService.getRevenueBreakdown(req.user.userId, query.storeId, query);
  }

  @Get('export')
  async export(@Req() req: any, @Query() query: ExportQueryDto, @Res() res: Response) {
    const sellerId = req.user.userId;
    await this.analyticsService.assertAdvancedAnalytics(sellerId, query.storeId);

    if (query.format === 'pdf') {
      const pdf = await this.analyticsService.exportPdf(sellerId, query.storeId, query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics-report.pdf"');
      res.send(pdf);
      return;
    }

    const csv = await this.analyticsService.exportCsv(sellerId, query.storeId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${query.section ?? 'revenue'}.csv"`);
    res.send(csv);
  }
}
