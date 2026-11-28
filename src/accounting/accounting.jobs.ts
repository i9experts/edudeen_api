import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AccountingService } from './accounting.service';
import { PostingService } from './posting/posting.service';
import { AccountingDashboardService } from './dashboard.service';
import { StripeSettlementService } from './stripe/stripe-settlement.service';

@Injectable()
export class AccountingJobs {
  private readonly logger = new Logger(AccountingJobs.name);
  constructor(
    private readonly posting: PostingService,
    private readonly ledger: AccountingService,
    private readonly dash: AccountingDashboardService,
    private readonly stripe: StripeSettlementService,
  ) {}

  // Daily: Stripe payouts, fees, disputes and Connect transfers of the platform account (read-only Stripe calls).
  @Cron('41 2 * * *')
  async stripeSettlements() {
    try {
      const res = await this.stripe.sync();
      if ('posted' in res && (res.posted || res.errors))
        this.logger.log(
          `Stripe settlements: ${res.posted} posted, ${res.errors} error(s)`,
        );
    } catch (err: any) {
      this.logger.error(`Stripe settlement sync failed: ${err?.message}`);
    }
  }

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

  // 3rd of each month: tell the finance team last month's pack is ready (only when turned on in Accounting settings;
  // sent once per month even with several instances).
  @Cron('13 6 3 * *')
  async financePackNotice() {
    try {
      const { sent, month } = await this.dash.sendMonthlyNotice();
      if (sent)
        this.logger.log(
          `Finance pack notice for ${month} sent to ${sent} recipient(s)`,
        );
    } catch (err: any) {
      this.logger.error(`Finance pack notice failed: ${err?.message}`);
    }
  }
}
