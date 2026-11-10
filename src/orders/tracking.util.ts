import { BadRequestException } from '@nestjs/common';

/** Carrier string the web sends when the seller delivers the parcel themselves (no tracking number). */
export const SELF_DELIVERY_CARRIER = 'I deliver myself';

const SELF_NAMES = new Set(['i deliver myself', 'self delivery', 'self-delivery', 'self', 'own delivery']);
export const isSelfDelivery = (carrier: unknown) => SELF_NAMES.has(String(carrier ?? '').trim().toLowerCase());

export interface CleanTracking {
  carrier: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  expectedDeliveryDate: Date | null;
  note: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Validates the `tracking` object sent with status "shipped".
 * - courier carriers: tracking number required (<= 60 chars)
 * - self delivery: number optional; optional expected delivery date + note
 * - trackingUrl: http(s) only (<= 500), empty = none
 * Throws 400 with a plain message. Never trusts types: anything not a string is treated as empty.
 */
export function cleanTracking(raw: unknown): CleanTracking {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('tracking info required when status is shipped');
  }
  const t = raw as Record<string, unknown>;
  const carrier = str(t.carrier);
  if (!carrier) throw new BadRequestException('Choose a carrier (or "I deliver myself")');
  if (carrier.length > 60) throw new BadRequestException('Carrier name is too long (max 60 characters)');

  const self = isSelfDelivery(carrier);
  const number = str(t.trackingNumber);
  if (number.length > 60) throw new BadRequestException('Tracking number is too long (max 60 characters)');
  if (!self && !number) throw new BadRequestException('A tracking number is required for this carrier');

  const url = str(t.trackingUrl);
  if (url) {
    if (url.length > 500) throw new BadRequestException('Tracking link is too long (max 500 characters)');
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { ok = false; }
    if (!ok) throw new BadRequestException('Tracking link must start with http:// or https://');
  }

  let expected: Date | null = null;
  const exp = str(t.expectedDeliveryDate);
  if (exp) {
    const d = new Date(exp);
    const now = Date.now();
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Expected delivery date is not a valid date');
    if (d.getTime() < now - 2 * 86_400_000 || d.getTime() > now + 120 * 86_400_000) {
      throw new BadRequestException('Expected delivery date must be within the next 120 days');
    }
    expected = d;
  }

  const note = str(t.note);
  if (note.length > 300) throw new BadRequestException('Note is too long (max 300 characters)');

  return {
    carrier,
    trackingNumber: number || null,
    trackingUrl: url || null,
    // The date/note only make sense for self-delivery; courier parcels keep the courier's own tracking.
    expectedDeliveryDate: self ? expected : null,
    note: self ? (note || null) : null,
  };
}
