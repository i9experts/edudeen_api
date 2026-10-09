/** Admin-assigned trust badges on a listing (set during listing review). */
export interface TrustBadges {
  scholarReviewed: boolean;
  /** Ages the admin team judged the content appropriate for; either end may be open. */
  ageAppropriateMin: number | null;
  ageAppropriateMax: number | null;
}

export class TrustBadgeError extends Error {}

const toAge = (v: unknown, label: string): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 25) throw new TrustBadgeError(`${label} must be a whole number between 0 and 25`);
  return n;
};

/** Validates admin input and merges it onto the current badges (omitted fields are kept). */
export function mergeTrustBadges(
  current: Partial<TrustBadges> | null | undefined,
  input: { scholarReviewed?: unknown; ageAppropriateMin?: unknown; ageAppropriateMax?: unknown },
): TrustBadges {
  const next: TrustBadges = {
    scholarReviewed: !!current?.scholarReviewed,
    ageAppropriateMin: current?.ageAppropriateMin ?? null,
    ageAppropriateMax: current?.ageAppropriateMax ?? null,
  };
  if (input.scholarReviewed !== undefined) {
    if (typeof input.scholarReviewed !== 'boolean') throw new TrustBadgeError('scholarReviewed must be true or false');
    next.scholarReviewed = input.scholarReviewed;
  }
  if (input.ageAppropriateMin !== undefined) next.ageAppropriateMin = toAge(input.ageAppropriateMin, 'Minimum age');
  if (input.ageAppropriateMax !== undefined) next.ageAppropriateMax = toAge(input.ageAppropriateMax, 'Maximum age');
  if (next.ageAppropriateMin != null && next.ageAppropriateMax != null && next.ageAppropriateMin > next.ageAppropriateMax) {
    throw new TrustBadgeError('Minimum age cannot be more than maximum age');
  }
  return next;
}
