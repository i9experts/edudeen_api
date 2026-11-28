import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import {
  PremiumMembership,
  PremiumMembershipSchema,
  PremiumPayment,
  PremiumPaymentSchema,
  PremiumPlan,
  PremiumPlanSchema,
} from '../premium/premium.schemas';
import {
  Account,
  AccountSchema,
  AccountingPeriod,
  AccountingPeriodSchema,
  AcctCounter,
  AcctCounterSchema,
  AcctPostingState,
  AcctPostingStateSchema,
  AcctSourceMark,
  AcctSourceMarkSchema,
  FixedAsset,
  FixedAssetSchema,
  JournalEntry,
  JournalEntrySchema,
  Vendor,
  VendorSchema,
} from './schemas/accounting.schemas';
import { AccountingService } from './accounting.service';
import { ReportsService } from './reports.service';
import { PostingService } from './posting/posting.service';
import { AccountingController } from './accounting.controller';
import { AccountingJobs } from './accounting.jobs';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: Account.name, schema: AccountSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
      { name: AccountingPeriod.name, schema: AccountingPeriodSchema },
      { name: FixedAsset.name, schema: FixedAssetSchema },
      { name: Vendor.name, schema: VendorSchema },
      { name: AcctCounter.name, schema: AcctCounterSchema },
      { name: AcctSourceMark.name, schema: AcctSourceMarkSchema },
      { name: AcctPostingState.name, schema: AcctPostingStateSchema },
      { name: PremiumPayment.name, schema: PremiumPaymentSchema },
      { name: PremiumMembership.name, schema: PremiumMembershipSchema },
      { name: PremiumPlan.name, schema: PremiumPlanSchema },
    ]),
  ],
  controllers: [AccountingController],
  providers: [
    AccountingService,
    ReportsService,
    PostingService,
    AccountingJobs,
  ],
  // Phase B (payroll) posts salary journals through AccountingService.postJournal.
  exports: [AccountingService],
})
export class AccountingModule {}
