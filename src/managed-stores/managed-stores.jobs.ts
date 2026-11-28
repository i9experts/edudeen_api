import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ManagedStoresService } from './managed-stores.service';

@Injectable()
export class ManagedStoresJobs {
  private readonly logger = new Logger(ManagedStoresJobs.name);
  constructor(private readonly service: ManagedStoresService) {}

  // Daily. Safe on several instances at once: each notice is claimed per store with a guarded update.
  @Cron('17 5 * * *')
  async mouNotices() {
    try {
      const sent = await this.service.sendMouNotices();
      if (sent) this.logger.log(`MOU expiry notices sent: ${sent}`);
    } catch (err: any) {
      this.logger.error(`MOU expiry notices failed: ${err?.message}`);
    }
  }
}
