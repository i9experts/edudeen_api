import { BadRequestException } from '@nestjs/common';

/**
 * Store on holiday. ONE place for: validating what the seller sends, deciding whether a holiday is in force, and
 * deciding whether it blocks a given product. The cart, checkout and cron all use these functions.
 *
 * - `returnDate` is a Pakistan-time DAY (Asia/Karachi, UTC+5, no DST). It is stored as the instant that day STARTS
 *   in Pakistan, i.e. the store is "away until" that morning and the holiday is over from then on.
 * - Physical products are always blocked while a holiday is in force. Digital products (and courses, which are
 *   digital) are blocked only when `digitalStillSells` is false.
 */
export const HOLIDAY_MESSAGE_MAX = 200;
const PKT_OFFSET_MS = 5 * 3_600_000;

export type StoreHoliday = {
  enabled: boolean;
  returnDate: Date | null;
  message: string | null;
  digitalStillSells: boolean;
};

/** Start (00:00 Pakistan time) of the PKT day containing `d`, as a real instant. */
export function pktStartOfDay(d: Date): Date {
  const shifted = new Date(d.getTime() + PKT_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - PKT_OFFSET_MS);
}

/** "2026-11-20" (a Pakistan calendar day) -> the instant that day starts in Pakistan; null when not a real date. */
export function parsePktDay(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return new Date(probe.getTime() - PKT_OFFSET_MS);
}

/** Validates the seller's request. Throws 400 with a plain message; never trusts the shape of `body`. */
export function cleanHolidayInput(body: any, now: Date = new Date()): StoreHoliday {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Holiday settings must be an object');
  if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
  if (body.digitalStillSells !== undefined && typeof body.digitalStillSells !== 'boolean') {
    throw new BadRequestException('digitalStillSells must be true or false');
  }

  let message: string | null = null;
  if (body.message !== undefined && body.message !== null && body.message !== '') {
    if (typeof body.message !== 'string') throw new BadRequestException('message must be text');
    // eslint-disable-next-line no-control-regex
    const clean = body.message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length > HOLIDAY_MESSAGE_MAX) throw new BadRequestException(`message must be at most ${HOLIDAY_MESSAGE_MAX} characters`);
    message = clean || null;
  }

  let returnDate: Date | null = null;
  if (body.enabled && body.returnDate !== undefined && body.returnDate !== null && body.returnDate !== '') {
    returnDate = parsePktDay(body.returnDate);
    if (!returnDate) throw new BadRequestException('returnDate must be a date like 2026-11-20 (Pakistan time)');
    // The first day the store is back must be a FUTURE day, otherwise it would end the moment it starts.
    if (returnDate.getTime() <= now.getTime()) throw new BadRequestException('Return date must be a future day (Pakistan time)');
  }

  return {
    enabled: body.enabled,
    returnDate,
    message,
    digitalStillSells: body.digitalStillSells !== false,
  };
}

/** A holiday is in force when switched on and its return day (if any) has not started. Independent of the cron. */
export function holidayActive(h: Partial<StoreHoliday> | null | undefined, now: Date = new Date()): boolean {
  if (!h || h.enabled !== true) return false;
  if (!h.returnDate) return true;
  const t = new Date(h.returnDate).getTime();
  return Number.isNaN(t) ? true : t > now.getTime();
}

/** True when the holiday stops this kind of product from being bought. `type` is the product's `type` (physical | digital). */
export function holidayBlocks(
  h: Partial<StoreHoliday> | null | undefined,
  type: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!holidayActive(h, now)) return false;
  if (type === 'physical') return true;
  return h!.digitalStillSells === false;
}

/** "20 Nov 2026" for the return day, in Pakistan time. */
export function holidayDateLabel(returnDate: Date | string | null | undefined): string {
  if (!returnDate) return '';
  const d = new Date(returnDate);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** Buyer-facing sentence, e.g. "Store away until 20 Nov 2026". */
export function holidayText(h: Partial<StoreHoliday> | null | undefined): string {
  const label = holidayDateLabel(h?.returnDate);
  return label ? `Store away until ${label}` : 'Store is away for now';
}

/** The ONLY holiday fields buyers ever see (null when no holiday is in force). */
export function publicHoliday(store: any, now: Date = new Date()) {
  const h = store?.holiday;
  if (!holidayActive(h, now)) return null;
  return {
    enabled: true,
    returnDate: h.returnDate ? new Date(h.returnDate).toISOString() : null,
    message: h.message ?? null,
    digitalStillSells: h.digitalStillSells !== false,
  };
}

/** Message for a refused add-to-cart / checkout line. */
export function holidayRefusal(productName: string | null | undefined, h: Partial<StoreHoliday> | null | undefined): string {
  const name = productName ? `"${productName}"` : 'This item';
  return `${name} cannot be ordered right now. ${holidayText(h)}.`;
}
