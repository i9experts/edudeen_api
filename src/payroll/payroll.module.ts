import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { AccountingModule } from '../accounting/accounting.module';
import {
  JournalEntry,
  JournalEntrySchema,
} from '../accounting/schemas/accounting.schemas';
import {
  StoreAssignment,
  StoreAssignmentSchema,
} from '../managed-stores/schemas/store-assignment.schema';
import {
  CompensationProfile,
  CompensationProfileSchema,
  PayrollClaim,
  PayrollClaimSchema,
  PayrollRun,
  PayrollRunSchema,
  StaffAdvance,
  StaffAdvanceSchema,
  TaxYearConfig,
  TaxYearConfigSchema,
} from './schemas/payroll.schemas';
import { PayrollService } from './payroll.service';
import { PayrollMetricsService } from './payroll-metrics.service';
import {
  PayrollClaimsController,
  PayrollController,
  PayrollMeController,
} from './payroll.controller';

/** Payroll & incentives: pay profiles, claims, advances, monthly runs posted to the company books (AccountingModule). */
@Module({
  imports: [
    AuthModule,
    UploadModule,
    AccountingModule,
    MongooseModule.forFeature([
      { name: CompensationProfile.name, schema: CompensationProfileSchema },
      { name: TaxYearConfig.name, schema: TaxYearConfigSchema },
      { name: PayrollClaim.name, schema: PayrollClaimSchema },
      { name: StaffAdvance.name, schema: StaffAdvanceSchema },
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
      { name: StoreAssignment.name, schema: StoreAssignmentSchema },
    ]),
  ],
  // Order matters: /payroll/me and /payroll/claims before the generic /payroll routes.
  controllers: [
    PayrollMeController,
    PayrollClaimsController,
    PayrollController,
  ],
  providers: [PayrollService, PayrollMetricsService],
})
export class PayrollModule {}
