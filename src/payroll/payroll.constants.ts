/* eslint-disable prettier/prettier */
/**
 * Payroll & incentives: shared constants. Money is PKR, 2 dp. Payroll months are 'YYYY-MM' (UTC, like the books);
 * the tax year runs July..June and is labelled like the fiscal year ('2026-27').
 */

export const WORKER_TYPES = ['employee', 'contractor'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

/** Activity counted automatically for incentive rules (see payroll-metrics.service.ts for the exact definitions). */
export const INCENTIVE_METRICS = [
  'products_listed', 'products_edited', 'shipments_handled', 'orders_confirmed', 'support_replies', 'replies_within_24h',
  'sellers_onboarded', 'managed_store_commission', 'visits',
] as const;
export type IncentiveMetric = (typeof INCENTIVE_METRICS)[number];

export const METRIC_LABEL: Record<IncentiveMetric, string> = {
  products_listed: 'Products listed',
  products_edited: 'Products edited',
  shipments_handled: 'Shipments handled',
  orders_confirmed: 'Orders confirmed',
  support_replies: 'Buyer replies',
  replies_within_24h: 'Buyer replies within 24 h',
  sellers_onboarded: 'Sellers onboarded',
  managed_store_commission: 'Commission from my managed stores (PKR)',
  visits: 'Visits',
};

/** 'per_unit' pays rate x count; 'percent' pays rate% of a money metric (managed_store_commission). */
export const RULE_UNITS = ['per_unit', 'percent'] as const;
export type RuleUnit = (typeof RULE_UNITS)[number];

/** Performance bonus tiers compare these month figures against a threshold (>=). */
export const BONUS_METRICS = ['on_time_pct', 'reply_within_24h_pct', 'orders_handled', 'products_listed', 'sellers_onboarded', 'support_replies'] as const;
export type BonusMetric = (typeof BONUS_METRICS)[number];

export const BONUS_METRIC_LABEL: Record<BonusMetric, string> = {
  on_time_pct: 'On-time shipping %',
  reply_within_24h_pct: 'Replies within 24 h %',
  orders_handled: 'Orders handled',
  products_listed: 'Products listed',
  sellers_onboarded: 'Sellers onboarded',
  support_replies: 'Buyer replies',
};

export const CLAIM_TYPES = ['petrol', 'lunch', 'visit', 'travel', 'other'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CLAIM_STATUSES = ['submitted', 'approved', 'rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const RUN_STATUSES = ['draft', 'submitted', 'approved', 'paid', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ADVANCE_STATUSES = ['submitted', 'approved', 'rejected', 'cleared'] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** Ledger accounts payroll posts to (codes from accounting.constants SEED_ACCOUNTS). */
export const PAYROLL_ACCOUNTS = {
  salaries: '6000',
  allowances: '6010',
  incentives: '6020',
  employerEobi: '6030',
  employerPf: '6040',
  contractorFees: '6050',
  claims: '6060',
  advances: '1300',
  bank: '1010',
  withholdingServices: '2210',
  incomeTaxWithheld: '2220',
  eobiPayable: '2230',
  pfPayable: '2240',
  salariesPayable: '2300',
} as const;

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const RECEIPT_FOLDER = 'private/payroll-receipts';
