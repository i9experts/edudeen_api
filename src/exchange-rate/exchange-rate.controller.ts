import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { DisplayRateService } from './display-rate.service';
import { clientIpOf, countryFromIp } from './geo-ip.util';
import { countryFromHeaders, currencyForCountry, normalizeCountry } from './country-currency.util';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
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
  constructor(
    private readonly exchangeRateService: ExchangeRateService,
    private readonly displayRates: DisplayRateService,
  ) {}

  // Public. Detected country (CDN header, else the browser's own guess in ?country=) -> its
  // display currency + live rate. DISPLAY ONLY: never used for charging. ratePerUSD is null when
  // no valid rate exists at all (the web then shows native prices); stale=true = last-known-good.
  @Get('display')
  async getDisplay(@Req() req: any, @Res({ passthrough: true }) res: any, @Query('country') hint?: string) {
    res.setHeader('Cache-Control', 'no-store');
    // CDN header -> the visitor's real IP -> the browser's own guess (weakest: language/timezone, not location).
    const country = countryFromHeaders(req.headers) ?? (await countryFromIp(clientIpOf(req))) ?? normalizeCountry(hint);
    const currency = currencyForCountry(country);
    const table = currency && currency !== 'USD' ? await this.displayRates.getRates() : null;
    return {
      success: true,
      data: {
        country,
        currency,
        ratePerUSD: currency === 'USD' ? 1 : (currency ? table?.rates[currency] ?? null : null),
        asOf: table?.asOf ?? null,
        stale: table?.stale ?? false,
      },
    };
  }

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

  @Get('held')
  async held() {
    return { success: true, data: await this.exchangeRateService.listHeldRates() };
  }

  @RequireReauth()
  @Post('held/:id/confirm')
  async confirmHeld(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    const data = await this.exchangeRateService.confirmHeldRate(id, { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] });
    return { success: true, data };
  }

  @RequireReauth()
  @Post('held/:id/dismiss')
  async dismissHeld(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: { reason?: string }) {
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    const data = await this.exchangeRateService.dismissHeldRate(id, reason, { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] });
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
