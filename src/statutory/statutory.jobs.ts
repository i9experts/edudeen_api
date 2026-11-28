import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StatutoryService } from './statutory.service';

@Injectable()
export class StatutoryJobs {
  private readonly logger = new Logger(StatutoryJobs.name);
  constructor(private readonly svc: StatutoryService) {}

  // Every 20 minutes: tax / EOBI / PF statements for newly approved payroll runs (unique per run + authority).
  @Cron('11,31,51 * * * *')
  async generate() {
    try {
      const { created } = await this.svc.generateFromRuns();
      if (created) this.logger.log(`Statutory statements created: ${created}`);
    } catch (err: any) {
      this.logger.error(
        `Statutory statement generation failed: ${err?.message}`,
      );
    }
  }

  // Daily 05:23 UTC (10:23 PKT): "due within 5 days" and "overdue" e-mails, each statement once per kind.
  @Cron('23 5 * * *')
  async reminders() {
    try {
      const { sent, statements } = await this.svc.sendReminders();
      if (statements)
        this.logger.log(
          `Statutory reminders: ${statements} statement(s), ${sent} e-mail(s)`,
        );
    } catch (err: any) {
      this.logger.error(`Statutory reminders failed: ${err?.message}`);
    }
  }
}
