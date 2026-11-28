/* eslint-disable prettier/prettier */
/**
 * Company books: base currency, fiscal year and the seeded chart of accounts.
 * Account CODES are the stable keys used by journal lines and the posting rules: an account's name can change,
 * its code cannot once it has been used. Every auto-posting rule reads its accounts from POSTING_ACCOUNTS only.
 */

export const BASE_CURRENCY = 'PKR';
/** The books start here (fiscal year 2026-27). Opening balances are dated this day. */
export const BOOKS_START = '2026-07-01';
/** Fiscal year runs July..June (Pakistan tax year). */
export const FISCAL_YEAR_START_MONTH = 7;

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  'cash', 'bank', 'clearing', 'receivable', 'other_current_asset', 'fixed_asset', 'accum_depreciation',
  'payable', 'tax_payable', 'accrued', 'other_liability',
  'capital', 'retained_earnings', 'current_earnings', 'opening_equity',
  'revenue', 'other_income',
  'cogs', 'opex', 'payroll', 'other_expense',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

/** Assets and expenses grow with debits; the rest with credits. */
export const DEBIT_NORMAL: Record<AccountType, boolean> = { asset: true, expense: true, liability: false, equity: false, income: false };

export interface SeedAccount { code: string; name: string; type: AccountType; subtype: AccountSubtype; parent?: string; description?: string }

export const SEED_ACCOUNTS: SeedAccount[] = [
  // Assets
  { code: '1000', name: 'Cash in hand', type: 'asset', subtype: 'cash' },
  { code: '1010', name: 'Bank — main account', type: 'asset', subtype: 'bank', description: 'Rename or add one account per bank account.' },
  { code: '1100', name: 'Stripe clearing', type: 'asset', subtype: 'clearing', description: 'Card payments received by Stripe, not yet paid out to the bank.' },
  { code: '1110', name: 'COD receivable from couriers', type: 'asset', subtype: 'receivable', description: 'Cash on delivery collected by couriers for Edudeen, not yet remitted.' },
  { code: '1120', name: 'Payment gateway clearing', type: 'asset', subtype: 'clearing', description: 'Other online payment rails awaiting settlement.' },
  { code: '1200', name: 'Accounts receivable', type: 'asset', subtype: 'receivable' },
  { code: '1300', name: 'Advances to staff', type: 'asset', subtype: 'receivable' },
  { code: '1400', name: 'Prepaid expenses', type: 'asset', subtype: 'other_current_asset' },
  { code: '1500', name: 'Computers & equipment', type: 'asset', subtype: 'fixed_asset' },
  { code: '1510', name: 'Furniture & fixtures', type: 'asset', subtype: 'fixed_asset' },
  { code: '1520', name: 'Vehicles', type: 'asset', subtype: 'fixed_asset' },
  { code: '1590', name: 'Accumulated depreciation', type: 'asset', subtype: 'accum_depreciation', description: 'Contra-asset (credit balance).' },
  // Liabilities
  { code: '2000', name: 'Seller payables', type: 'liability', subtype: 'payable', description: 'What Edudeen owes sellers (marketplace balances). A debit balance for a seller means the seller owes Edudeen.' },
  { code: '2010', name: 'Seller payouts in transit', type: 'liability', subtype: 'payable', description: 'Payouts requested/approved but not yet paid from the bank.' },
  { code: '2020', name: 'Buyer refunds payable', type: 'liability', subtype: 'payable' },
  { code: '2100', name: 'Accounts payable — vendors', type: 'liability', subtype: 'payable' },
  { code: '2200', name: 'Sales tax payable', type: 'liability', subtype: 'tax_payable' },
  { code: '2210', name: 'Withholding tax payable', type: 'liability', subtype: 'tax_payable' },
  { code: '2220', name: 'Income tax withheld — salaries', type: 'liability', subtype: 'tax_payable' },
  { code: '2230', name: 'EOBI payable', type: 'liability', subtype: 'tax_payable' },
  { code: '2240', name: 'Provident fund payable', type: 'liability', subtype: 'other_liability' },
  { code: '2300', name: 'Salaries payable', type: 'liability', subtype: 'payable' },
  { code: '2400', name: 'Accrued expenses', type: 'liability', subtype: 'accrued' },
  // Equity
  { code: '3000', name: "Owner's capital", type: 'equity', subtype: 'capital' },
  { code: '3100', name: 'Retained earnings', type: 'equity', subtype: 'retained_earnings' },
  { code: '3200', name: 'Current year earnings', type: 'equity', subtype: 'current_earnings', description: 'Computed in reports (income - expenses this fiscal year); never posted to.' },
  { code: '3900', name: 'Opening balance equity', type: 'equity', subtype: 'opening_equity' },
  // Income
  { code: '4000', name: 'Marketplace commission — self-managed', type: 'income', subtype: 'revenue' },
  { code: '4010', name: 'Managed-store commission (MOU)', type: 'income', subtype: 'revenue' },
  { code: '4020', name: 'Card processing fees charged to sellers', type: 'income', subtype: 'revenue' },
  { code: '4100', name: 'Platform plan subscriptions', type: 'income', subtype: 'revenue' },
  { code: '4110', name: 'Platform add-ons (AI credits, seats, placement)', type: 'income', subtype: 'revenue' },
  { code: '4200', name: 'Premium memberships', type: 'income', subtype: 'revenue' },
  { code: '4300', name: 'Shipping income', type: 'income', subtype: 'revenue' },
  { code: '4800', name: 'Other income', type: 'income', subtype: 'other_income' },
  { code: '4900', name: 'FX gain / loss', type: 'income', subtype: 'other_income' },
  // Expenses
  { code: '5000', name: 'Payment gateway fees', type: 'expense', subtype: 'cogs' },
  { code: '5010', name: 'Courier & shipping expense', type: 'expense', subtype: 'cogs' },
  { code: '5100', name: 'Platform subsidies (sponsored discounts)', type: 'expense', subtype: 'cogs' },
  { code: '5110', name: 'Seller adjustments & goodwill', type: 'expense', subtype: 'cogs' },
  { code: '5120', name: 'Refund losses', type: 'expense', subtype: 'cogs' },
  { code: '6000', name: 'Salaries & wages', type: 'expense', subtype: 'payroll' },
  { code: '6010', name: 'Allowances (petrol, lunch)', type: 'expense', subtype: 'payroll' },
  { code: '6020', name: 'Staff incentives & commissions', type: 'expense', subtype: 'payroll' },
  { code: '6030', name: 'Employer EOBI contribution', type: 'expense', subtype: 'payroll' },
  { code: '6040', name: 'Employer provident fund contribution', type: 'expense', subtype: 'payroll' },
  { code: '6050', name: 'Contractor fees', type: 'expense', subtype: 'payroll', description: 'Pay to team members engaged as contractors (no salary tax).' },
  { code: '6060', name: 'Staff claims & reimbursements', type: 'expense', subtype: 'payroll', description: 'Approved petrol, lunch, visit and travel claims paid through payroll.' },
  { code: '6100', name: 'Marketing & advertising', type: 'expense', subtype: 'opex' },
  { code: '6200', name: 'Hosting & software', type: 'expense', subtype: 'opex' },
  { code: '6300', name: 'Rent', type: 'expense', subtype: 'opex' },
  { code: '6310', name: 'Utilities', type: 'expense', subtype: 'opex' },
  { code: '6400', name: 'Depreciation', type: 'expense', subtype: 'opex' },
  { code: '6500', name: 'Bank charges', type: 'expense', subtype: 'opex' },
  { code: '6900', name: 'Miscellaneous expenses', type: 'expense', subtype: 'other_expense' },
];

/** The ONE place auto-posting rules get their accounts from (codes from SEED_ACCOUNTS). */
export const POSTING_ACCOUNTS = {
  bank: '1010',
  stripeClearing: '1100',
  codReceivable: '1110',
  gatewayClearing: '1120',
  sellerPayable: '2000',
  payoutsInTransit: '2010',
  commissionSelf: '4000',
  commissionManaged: '4010',
  processingFeeIncome: '4020',
  platformPlanIncome: '4100',
  addonIncome: '4110',
  premiumIncome: '4200',
  subsidyExpense: '5100',
  sellerAdjustments: '5110',
  depreciationExpense: '6400',
  accumulatedDepreciation: '1590',
  openingEquity: '3900',
  retainedEarnings: '3100',
  currentEarnings: '3200',
} as const;

export const PARTY_TYPES = ['customer', 'seller', 'vendor', 'employee', 'subscriber'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const JOURNAL_STATUSES = ['draft', 'submitted', 'posted', 'void'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

/** Auto-posting source types (journal.source.type). Manual entries have no source. */
export const SOURCE_TYPES = [
  'seller_tx', 'payout_completed', 'platform_plan_invoice', 'platform_plan_refund', 'addon_purchase', 'premium_payment',
  'depreciation', 'asset_purchase', 'asset_disposal', 'opening_balance', 'reversal', 'payroll',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const ASSET_CATEGORIES = ['computers', 'furniture', 'vehicles', 'other'] as const;
