import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminConfigService } from './admin-config.service';

// Public (no auth) read of the safe subset of the platform config — social
// links for the site footer and the platform payout schedule for seller
// marketing copy. Never exposes bank/email/AI/fx settings.
@ApiTags('Public Platform Config')
@Controller('api/platform-config')
export class PublicPlatformConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  /** What (if anything) is under maintenance — read by the maintenance page and the site-wide notice. */
  @Get('maintenance')
  getMaintenance() {
    return this.adminConfigService.getPublicMaintenance();
  }

  // Admins edit this live (inline edit mode): browsers/CDNs must revalidate instead of serving an older copy.
  @Header('Cache-Control', 'no-cache')
  @Get('public')
  getPublicConfig() {
    return this.adminConfigService.getPublicConfig();
  }
}
