/* eslint-disable prettier/prettier */
/**
 * "Two people" rule: when STAFF (not the owner) performs one of these actions, it is not executed.
 * It becomes an approval request; the owner (or a staff member with `approvals.decide`) must approve it,
 * and then the requester repeats the same action once within 24 h.
 */
import { normalizeRequestPath } from '../common/request-path.util';

export interface ApprovalRoute { key: string; label: string; method: string; re: RegExp }

export const APPROVAL_ROUTES: ApprovalRoute[] = [
  { key: 'payout', label: 'Approve a seller payout', method: 'PATCH', re: /^\/api\/admin\/finance\/payouts\/[^/]+\/approve$/i },
  { key: 'payout_retry', label: 'Retry a failed payout', method: 'PATCH', re: /^\/api\/admin\/finance\/payouts\/[^/]+\/retry$/i },
  { key: 'refund', label: 'Approve a refund', method: 'PATCH', re: /^\/api\/refund-request\/[^/]+\/approve$/i },
  { key: 'payment_proof', label: 'Approve a payment proof', method: 'PATCH', re: /^\/api\/admin\/manual-payments\/[^/]+\/approve$/i },
];

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
