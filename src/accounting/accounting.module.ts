import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
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
  PayrollClaim,
  PayrollClaimSchema,
  PayrollRun,
  PayrollRunSchema,
  StaffAdvance,
  StaffAdvanceSchema,
  TaxYearConfig,
  TaxYearConfigSchema,
} from '../payroll/schemas/payroll.schemas';
import {
  Account,
  AccountSchema,
  AcctSettings,
  AcctSettingsSchema,
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
import { AccountingDashboardService } from './dashboard.service';
import { SettlementsController } from './settlements.controller';
import {
  ACCT_STRIPE_READER,
  StripeSettlementService,
} from './stripe/stripe-settlement.service';
import { CodRemittanceService } from './cod/cod-remittance.service';
import {
  CodRemittance,
  CodRemittanceItem,
  CodRemittanceItemSchema,
  CodRemittanceSchema,
  StripeBalanceTxn,
  StripeBalanceTxnSchema,
} from './schemas/settlement.schemas';
import {
  StatutoryPayment,
  StatutoryPaymentSchema,
} from '../statutory/schemas/statutory.schemas';

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
      { name: AcctSettings.name, schema: AcctSettingsSchema },
      // Read-only here (dashboard queue counts / tax-year warning); the payroll module owns them.
      { name: PayrollRun.name, schema: PayrollRunSchema },
      { name: StaffAdvance.name, schema: StaffAdvanceSchema },
      { name: PayrollClaim.name, schema: PayrollClaimSchema },
      { name: TaxYearConfig.name, schema: TaxYearConfigSchema },
      { name: StripeBalanceTxn.name, schema: StripeBalanceTxnSchema },
      { name: CodRemittance.name, schema: CodRemittanceSchema },
      { name: CodRemittanceItem.name, schema: CodRemittanceItemSchema },
      // Read-only here (dashboard alerts / approvals); the statutory module owns it.
      { name: StatutoryPayment.name, schema: StatutoryPaymentSchema },
    ]),
  ],
  controllers: [AccountingController, SettlementsController],
  providers: [
    AccountingService,
    ReportsService,
    PostingService,
    AccountingDashboardService,
    AccountingJobs,
    StripeSettlementService,
    CodRemittanceService,
    {
      // Read-only Stripe client for the settlement sync (same key as checkout); null when Stripe isn't configured.
      provide: ACCT_STRIPE_READER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('STRIPE_SECRET_KEY')?.trim();
        return key
          ? new Stripe(key, {
              apiVersion: '2025-04-30.basil',
            } as unknown as ConstructorParameters<typeof Stripe>[1])
          : null;
      },
    },
  ],
  // Phase B (payroll) posts salary journals through AccountingService.postJournal.
  exports: [AccountingService],
})
export class AccountingModule {}
