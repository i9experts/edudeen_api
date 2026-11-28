import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AccountingService } from './accounting.service';
import { PostingService } from './posting/posting.service';

@Injectable()
export class AccountingJobs {
  private readonly logger = new Logger(AccountingJobs.name);
  constructor(
    private readonly posting: PostingService,
    private readonly ledger: AccountingService,
  ) {}

  // Every 15 minutes: post new marketplace/billing activity to the ledger. Redis lock inside; the unique
  // source index makes a second instance harmless anyway.
  @Cron('7,22,37,52 * * * *')
  async post() {
    try {
      const res = await this.posting.runAll();
      if (!('skipped' in res)) {
        const posted = Object.values(res).reduce((s, r) => s + r.posted, 0);
        const errors = Object.values(res).reduce((s, r) => s + r.errors, 0);
        if (posted || errors)
          this.logger.log(
            `Accounting posting: ${posted} posted, ${errors} error(s)`,
          );
      }
    } catch (err: any) {
      this.logger.error(`Accounting posting failed: ${err?.message}`);
    }
  }

  // Daily: depreciation for finished months (idempotent per asset+month).
  @Cron('25 3 * * *')
  async depreciation() {
    try {
      const { posted } = await this.ledger.runDepreciation();
      if (posted) this.logger.log(`Depreciation entries posted: ${posted}`);
    } catch (err: any) {
      this.logger.error(`Depreciation failed: ${err?.message}`);
    }
  }
}
