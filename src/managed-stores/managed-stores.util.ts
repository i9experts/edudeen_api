import { BadRequestException } from '@nestjs/common';
import {
  MOU_RATE_MAX,
  MOU_RATE_MIN,
  STORE_MANAGEMENT_TYPES,
  type StoreManagementType,
} from '../store/schemas/store.schema';

export const MOU_EXPIRING_DAYS = 30;
const DAY_MS = 86_400_000;

export type MouStatus =
  | 'none'
  | 'not_started'
  | 'active'
  | 'expiring_soon'
  | 'expired';

/** Where an MOU stands on `now`. Open-ended (no end date) MOUs never expire. */
export function mouStatus(
  mou:
    | {
        commissionRate?: number | null;
        startDate?: Date | string | null;
        endDate?: Date | string | null;
      }
    | null
    | undefined,
  now: Date = new Date(),
): MouStatus {
  if (!mou || typeof mou.commissionRate !== 'number') return 'none';
  const start = mou.startDate ? new Date(mou.startDate).getTime() : null;
  const end = mou.endDate ? new Date(mou.endDate).getTime() : null;
  const t = now.getTime();
  if (start !== null && start > t) return 'not_started';
  if (end !== null && end < t) return 'expired';
  if (end !== null && end - t <= MOU_EXPIRING_DAYS * DAY_MS)
    return 'expiring_soon';
  return 'active';
}

export interface ManagedInput {
  managementType?: string;
  commissionRate?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
  fulfillmentMode?: string;
}

export interface CleanManaged {
  managementType?: StoreManagementType;
  mou?: {
    commissionRate: number;
    startDate: Date;
    endDate: Date | null;
    notes: string | null;
  };
  fulfillmentMode?: 'seller' | 'platform';
}

const parseDate = (
  v: string | Date | null | undefined,
  label: string,
): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(`${label} is not a valid date`);
  return d;
};

/**
 * Validates an admin's managed-store change. Switching a store to 'managed' needs a complete MOU
 * (commission 20–65%, start date; end date optional but after the start). MOU fields sent for a store
 * that stays/turns 'self' are refused, so nothing half-set is ever stored.
 * `current` is the store as stored, so an MOU edit on an already-managed store can send just the changed fields.
 */
export function cleanManagedInput(
  input: ManagedInput,
  current: {
    managementType?: string | null;
    mou?: {
      commissionRate?: number | null;
      startDate?: Date | null;
      endDate?: Date | null;
      notes?: string | null;
    } | null;
  },
): CleanManaged {
  const out: CleanManaged = {};
  if (input.managementType !== undefined) {
    if (
      !(STORE_MANAGEMENT_TYPES as readonly string[]).includes(
        input.managementType,
      )
    )
      throw new BadRequestException(
        'managementType must be "self" or "managed"',
      );
    out.managementType = input.managementType as StoreManagementType;
  }
  if (input.fulfillmentMode !== undefined) {
    if (
      input.fulfillmentMode !== 'seller' &&
      input.fulfillmentMode !== 'platform'
    )
      throw new BadRequestException(
        'fulfillmentMode must be "seller" or "platform"',
      );
    out.fulfillmentMode = input.fulfillmentMode;
  }

  const type = out.managementType ?? current.managementType ?? 'self';
  const touchesMou = ['commissionRate', 'startDate', 'endDate', 'notes'].some(
    (k) => (input as any)[k] !== undefined,
  );
  if (type !== 'managed') {
    if (touchesMou)
      throw new BadRequestException('MOU details only apply to managed stores');
    return out;
  }
  if (!touchesMou && current.managementType === 'managed') return out;

  const prev = current.mou ?? {};
  const rate =
    input.commissionRate !== undefined
      ? input.commissionRate
      : prev.commissionRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate))
    throw new BadRequestException('Enter the MOU commission');
  // Small tolerance so 0.65 typed as 65% never trips on floating point.
  if (rate < MOU_RATE_MIN - 1e-9 || rate > MOU_RATE_MAX + 1e-9)
    throw new BadRequestException(
      `MOU commission must be between ${MOU_RATE_MIN * 100}% and ${MOU_RATE_MAX * 100}%`,
    );
  const startDate =
    input.startDate !== undefined
      ? parseDate(input.startDate, 'Start date')
      : prev.startDate
        ? new Date(prev.startDate)
        : null;
  if (!startDate) throw new BadRequestException('Enter the MOU start date');
  const endDate =
    input.endDate !== undefined
      ? parseDate(input.endDate, 'End date')
      : prev.endDate
        ? new Date(prev.endDate)
        : null;
  if (endDate && endDate.getTime() <= startDate.getTime())
    throw new BadRequestException(
      'The MOU end date must be after its start date',
    );
  const notesRaw = input.notes !== undefined ? input.notes : prev.notes;
  const notes =
    typeof notesRaw === 'string' && notesRaw.trim()
      ? notesRaw.trim().slice(0, 2000)
      : null;
  out.mou = {
    commissionRate: Math.round(rate * 10000) / 10000,
    startDate,
    endDate,
    notes,
  };
  return out;
}

/** The commission Edudeen takes on a managed store's sale (fraction), or null when the store is not managed.
 *  Kept while the store is 'managed' even after the MOU end date (admins get expiry notices instead), so an
 *  expired MOU never silently drops the store to the normal 0% / platform-fee rate. */
export function managedCommissionRate(
  store:
    | {
        managementType?: string | null;
        mou?: { commissionRate?: number | null } | null;
      }
    | null
    | undefined,
): number | null {
  if (!store || store.managementType !== 'managed') return null;
  const r = store.mou?.commissionRate;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}
