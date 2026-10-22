/* eslint-disable prettier/prettier */
/**
 * "Two people" rule: when STAFF (not the owner) performs one of these actions, it is not executed.
 * It becomes an approval request; the owner (or a staff member with `approvals.decide`) must approve it,
 * and then the requester repeats the same action once within 24 h.
 */
import { normalizeRequestPath } from '../common/request-path.util';

/** `required` = always held for staff while approvals are on, whatever older saved settings list (new money routes). */
export interface ApprovalRoute { key: string; label: string; method: string; re: RegExp; required?: boolean }

export const APPROVAL_ROUTES: ApprovalRoute[] = [
  { key: 'payout', label: 'Approve a seller payout', method: 'PATCH', re: /^\/api\/admin\/finance\/payouts\/[^/]+\/approve$/i },
  { key: 'payout_retry', label: 'Retry a failed payout', method: 'PATCH', re: /^\/api\/admin\/finance\/payouts\/[^/]+\/retry$/i },
  { key: 'refund', label: 'Approve a refund', method: 'PATCH', re: /^\/api\/refund-request\/[^/]+\/approve$/i },
  { key: 'payment_proof', label: 'Approve a payment proof', method: 'PATCH', re: /^\/api\/admin\/manual-payments\/[^/]+\/approve$/i },
  { key: 'order_mark_paid', label: 'Mark an order as paid by hand', method: 'PUT', re: /^\/api\/orders\/mark-paid\/[^/]+$/i, required: true },
  { key: 'manual_payment_account', label: 'Change the platform payment account', method: 'PUT', re: /^\/api\/admin\/platform-config\/manual-payment$/i, required: true },
  { key: 'manual_payout', label: 'Create a manual seller payout', method: 'POST', re: /^\/api\/admin\/finance\/sellers\/[^/]+\/payouts\/manual$/i, required: true },
  { key: 'monthly_settlement', label: 'Run the monthly settlement', method: 'POST', re: /^\/api\/admin\/finance\/monthly-settlement\/run$/i, required: true },
  { key: 'payout_method_verify', label: 'Verify a seller payout method', method: 'PATCH', re: /^\/api\/admin\/finance\/sellers\/[^/]+\/payout-methods\/[^/]+\/verify$/i, required: true },
  { key: 'process_clearing', label: 'Release cleared seller balances', method: 'POST', re: /^\/api\/admin\/finance\/process-clearing$/i, required: true },
  { key: 'credit_job_retry', label: 'Retry a failed seller credit', method: 'POST', re: /^\/api\/admin\/finance\/credit-jobs\/[^/]+\/retry$/i, required: true },
  { key: 'premium_payment', label: 'Approve a Premium payment', method: 'PATCH', re: /^\/api\/admin\/premium\/payments\/[^/]+\/approve$/i, required: true },
  { key: 'premium_grant', label: 'Grant Premium to a member', method: 'POST', re: /^\/api\/admin\/premium\/members\/grant$/i, required: true },
  { key: 'fx_override', label: 'Override an exchange rate', method: 'POST', re: /^\/api\/admin\/fx\/override$/i, required: true },
];

export const REQUIRED_APPROVAL_KEYS = APPROVAL_ROUTES.filter((r) => r.required).map((r) => r.key);

export function approvalRouteFor(method: string, rawPath: string): ApprovalRoute | null {
  const path = normalizeRequestPath(rawPath);
  if (path === null) return null;
  const m = method.toUpperCase();
  return APPROVAL_ROUTES.find((r) => r.method === m && r.re.test(path)) ?? null;
}

export const APPROVAL_TTL_MS = 24 * 3600_000;

/** Amounts under the owner's limit run without waiting (0 = no limit, everything waits). Unknown amount/currency always waits. */
export function isBelowThreshold(amount: number | null | undefined, currency: string | null | undefined, t: { usd?: number; pkr?: number }): boolean {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
  const limit = String(currency ?? '').toUpperCase() === 'USD' ? t.usd : String(currency ?? '').toUpperCase() === 'PKR' ? t.pkr : 0;
  return !!limit && limit > 0 && amount < limit;
}
