import { BadRequestException } from '@nestjs/common';
import { reasonDisplayLabel, REJECT_REASON_MIN } from './refund-evidence.util';

/**
 * Status trail for returns and refund requests. TRACKING ONLY: none of these
 * steps moves money (the refund already happened at approval).
 *
 *   requested -> approved | rejected            (existing, atomic claim stays)
 *   approved  -> item_received                  (physical: seller confirms the parcel came back)
 *   item_received -> replacement_sent           (optional, seller note)
 *   approved  -> replacement_sent               (digital items have no parcel)
 */
export const FOLLOW_UP_STEPS = ['item_received', 'replacement_sent'] as const;
export type FollowUpStep = (typeof FOLLOW_UP_STEPS)[number];

export interface TrailEntry {
  status: string;
  at: Date | string | null;
  by?: string | null;
  byRole?: string | null;
  note?: string | null;
}

export function isFollowUpStep(v: unknown): v is FollowUpStep {
  return typeof v === 'string' && (FOLLOW_UP_STEPS as readonly string[]).includes(v);
}

/** The exact previous follow-up value a step may be applied from (null = none yet). Anything else is a 400. */
export function requiredPreviousFollowUp(step: unknown, isPhysical: boolean): FollowUpStep | null {
  if (!isFollowUpStep(step)) throw new BadRequestException('step must be item_received or replacement_sent');
  if (step === 'item_received') {
    if (!isPhysical) throw new BadRequestException('Digital items have no parcel to receive back');
    return null;
  }
  return isPhysical ? 'item_received' : null;
}

export function cleanFollowUpNote(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BadRequestException('note must be text');
  const n = raw.trim();
  if (n.length > 500) throw new BadRequestException('note can be at most 500 characters');
  return n || null;
}

export function cleanRejectReason(raw: unknown): string {
  const r = typeof raw === 'string' ? raw.trim() : '';
  if (r.length < REJECT_REASON_MIN) {
    throw new BadRequestException(`Please explain the rejection in at least ${REJECT_REASON_MIN} characters (the buyer will see it)`);
  }
  if (r.length > 500) throw new BadRequestException('The rejection reason can be at most 500 characters');
  return r;
}

export function trailEntry(status: string, by: string | null, byRole: string | null, note?: string | null, at: Date = new Date()): TrailEntry {
  return { status, at, by, byRole, ...(note ? { note } : {}) };
}

const TRAIL_LABEL: Record<string, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  item_received: 'Item received back',
  replacement_sent: 'Replacement sent',
};

/**
 * Timeline for the drawer. New requests carry their own `history`; old ones
 * are rebuilt from requestedAt / reviewedAt (item returns store no review time, so `at` is null).
 */
export function buildTimeline(args: {
  history?: TrailEntry[] | null;
  requestedAt: Date | string | null;
  requestedByRole?: string | null;
  status: 'open' | 'approved' | 'rejected';
  reviewedAt?: Date | string | null;
}) {
  const stored = Array.isArray(args.history) ? args.history.filter((h) => h && h.status) : [];
  // A trail that started after the request was filed (old request approved later) still opens with 'requested'.
  if (stored.length && stored[0].status !== 'requested') {
    stored.unshift({ status: 'requested', at: args.requestedAt, byRole: args.requestedByRole ?? 'user' });
  }
  const entries: TrailEntry[] = stored.length
    ? stored
    : [
        { status: 'requested', at: args.requestedAt, byRole: args.requestedByRole ?? 'user' },
        ...(args.status !== 'open' ? [{ status: args.status, at: args.reviewedAt ?? null, byRole: null }] : []),
      ];
  return entries.map((h) => ({
    status: h.status,
    label: TRAIL_LABEL[h.status] ?? h.status,
    at: h.at ? new Date(h.at as any).toISOString() : null,
    byRole: h.byRole ?? null,
    note: h.note ?? null,
  }));
}

export { reasonDisplayLabel };
