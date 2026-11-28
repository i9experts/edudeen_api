import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { AccountingModule } from '../accounting/accounting.module';
import {
  AcctSettings,
  AcctSettingsSchema,
  JournalEntry,
  JournalEntrySchema,
} from '../accounting/schemas/accounting.schemas';
import {
  CompensationProfile,
  CompensationProfileSchema,
  PayrollRun,
  PayrollRunSchema,
  TaxYearConfig,
  TaxYearConfigSchema,
} from '../payroll/schemas/payroll.schemas';
import {
  StatutoryPayment,
  StatutoryPaymentSchema,
} from './schemas/statutory.schemas';
import { StatutoryService } from './statutory.service';
import { StatutoryController } from './statutory.controller';
import { StatutoryJobs } from './statutory.jobs';

/** Tax & EOBI payments: liabilities from approved payroll, payments (PSID / CPR) posted to the books, filing files. */
@Module({
  imports: [
    AuthModule,
    UploadModule,
    AccountingModule,
    MongooseModule.forFeature([
      { name: StatutoryPayment.name, schema: StatutoryPaymentSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: CompensationProfile.name, schema: CompensationProfileSchema },
      { name: TaxYearConfig.name, schema: TaxYearConfigSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
      { name: AcctSettings.name, schema: AcctSettingsSchema },
    ]),
  ],
  controllers: [StatutoryController],
  providers: [StatutoryService, StatutoryJobs],
})
export class StatutoryModule {}
