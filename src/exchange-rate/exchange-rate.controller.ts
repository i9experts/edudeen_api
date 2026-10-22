import { Body, Controller, Get, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminReauthGuard, RequireReauth } from '../admin-reauth/admin-reauth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { ExchangeRateService } from './exchange-rate.service';
import { AdminOverrideFxRateDto } from './dto/admin-override-fx-rate.dto';

@Controller('api/exchange-rate')
export class ExchangeRateController {
  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  // Public, read-only — the frontend uses this to convert prices for
  // display before checkout. No auth needed: exposing a currency's rate is
  // not sensitive, and requiring auth here would break guest browsing.
  @Get('current')
  async getCurrent() {
    const rates = await this.exchangeRateService.getAllCurrentRates();
    return { success: true, data: rates };
  }
}

@ApiTags('Admin FX')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
@Roles('admin')
@Controller('api/admin/fx')
export class AdminFxController {
  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  @Get('history')
  async getHistory(
    @Query('currency') currency?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const data = await this.exchangeRateService.getHistory(currency, Number(page) || 1, Number(limit) || 20);
    return { success: true, data };
  }

  @Get('staleness')
  async getStaleness() {
    const data = await this.exchangeRateService.getStaleness();
    return { success: true, data };
  }

  @RequireReauth()
  @Post('override')
  @UseInterceptors(IdempotencyInterceptor)
  async override(@Req() req: any, @Body() dto: AdminOverrideFxRateDto) {
    const result = await this.exchangeRateService.ingestRate(dto.currency, dto.ratePerUSD, 'admin', {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { success: true, data: result };
  }
}
