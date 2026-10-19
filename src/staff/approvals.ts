/* eslint-disable prettier/prettier */
/**
 * "Two people" rule: when STAFF (not the owner) performs one of these actions, it is not executed.
 * It becomes an approval request; the owner (or a staff member with `approvals.decide`) must approve it,
 * and then the requester repeats the same action once within 24 h.
 */
export interface ApprovalRoute { key: string; label: string; method: string; re: RegExp }

export const APPROVAL_ROUTES: ApprovalRoute[] = [
  { key: 'payout', label: 'Approve a seller payout', method: 'PATCH', re: /^\/api\/admin\/finance\/payouts\/[^/]+\/approve$/ },
  { key: 'payout_retry', label: 'Retry a failed payout', method: 'PATCH', re: /^\/api\/admin\/finance\/payouts\/[^/]+\/retry$/ },
  { key: 'refund', label: 'Approve a refund', method: 'PATCH', re: /^\/api\/refund-request\/[^/]+\/approve$/ },
  { key: 'payment_proof', label: 'Approve a payment proof', method: 'PATCH', re: /^\/api\/admin\/manual-payments\/[^/]+\/approve$/ },
];

export function approvalRouteFor(method: string, path: string): ApprovalRoute | null {
  const m = method.toUpperCase();
  return APPROVAL_ROUTES.find((r) => r.method === m && r.re.test(path)) ?? null;
}

export const APPROVAL_TTL_MS = 24 * 3600_000;
