/** Where a store's buyers send bank-transfer / wallet payments: straight to the seller. */
export interface DirectPaymentDetails {
  bankName?: string | null;
  accountTitle?: string | null;
  accountNumber?: string | null;
  iban?: string | null;
  jazzcashNumber?: string | null;
  easypaisaNumber?: string | null;
  instructions?: string | null;
}

/** A store accepts direct transfers once it has at least one place to receive money. */
export function hasDirectPayment(dp: DirectPaymentDetails | null | undefined): boolean {
  return !!(dp && (dp.accountNumber?.trim() || dp.iban?.trim() || dp.jazzcashNumber?.trim() || dp.easypaisaNumber?.trim()));
}