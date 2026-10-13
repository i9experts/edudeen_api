import { Controller, Get, Optional, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MarketingService } from './marketing.service';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { PremiumEntitlementsService } from '../premium/premium-entitlements.service';

// Public — no auth guard. Buyers browsing the marketplace/homepage need to
// see active platform-wide sale campaigns without logging in.
// Deliberately NOT under 'api/marketing/:storeId/...' — that dynamic prefix
// would greedily swallow a literal 'public' segment as :storeId.
@ApiTags('Marketing (public)')
@Controller('api/public/marketing')
export class PublicMarketingController {
  constructor(
    private readonly marketingService: MarketingService,
    @Optional() private readonly premium?: PremiumEntitlementsService,
  ) {}

  // Optional login: an active Premium member also sees campaigns `earlyAccessHours` before they start
  // (each such row carries earlyAccess: true). Everyone else gets exactly the previous response.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('campaigns')
  async getActiveCampaigns(@Req() req: any, @Query('storeType') storeType?: string) {
    const ent = this.premium && req?.user?.userId ? await this.premium.getEntitlements(req.user.userId) : null;
    return this.marketingService.getPublicActiveCampaigns(storeType, ent?.isPremium ? { earlyAccessHours: ent.earlyAccessHours } : {});
  }
}
