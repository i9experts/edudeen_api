import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminConfigService } from './admin-config.service';

// Public (no auth) read of the safe subset of the platform config — social
// links for the site footer and the platform payout schedule for seller
// marketing copy. Never exposes bank/email/AI/fx settings.
@ApiTags('Public Platform Config')
@Controller('api/platform-config')
export class PublicPlatformConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  @Get('public')
  getPublicConfig() {
    return this.adminConfigService.getPublicConfig();
  }
}
