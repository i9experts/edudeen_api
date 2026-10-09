import type { CourierEvent, NormalizedStatus } from './courier.types';

/** Maps a courier's free-text status to our small normalised set. */
export function normalizeCourierStatus(raw: string | null | undefined): NormalizedStatus {
  const s = String(raw ?? '').toLowerCase();
  if (!s.trim()) return 'unknown';
  if (/undeliver|not delivered|delivery (attempt )?fail|refus|cancel|lost|damag/.test(s)) return 'failed';
  if (/return|rto|to shipper/.test(s)) return 'returned';
  if (/out for delivery|dispatched for delivery|with courier|ofd/.test(s)) return 'out_for_delivery';
  if (/deliver/.test(s)) return 'delivered';
  if (/pick/.test(s)) return 'picked_up';
  if (/transit|arrived|departed|received at|reached|hub|forward/.test(s)) return 'in_transit';
  if (/book|created|generated|pending|ready/.test(s)) return 'booked';
  return 'unknown';
}

const pick = (o: any, keys: string[]): string => {
  for (const k of keys) if (o?.[k] != null && String(o[k]).trim() !== '') return String(o[k]).trim();
  return '';
};

/** Tolerant webhook parser: one event or an array, with the common field-name variants. */
export function parseGenericWebhook(body: any): CourierEvent[] {
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : body ? [body] : [];
  const out: CourierEvent[] = [];
  for (const e of list) {
    const trackingNumber = pick(e, ['trackingNumber', 'tracking_number', 'track_number', 'trackingNo', 'cn', 'consignment_no', 'cn_number']);
    if (!trackingNumber) continue;
    const text = pick(e, ['status', 'orderStatus', 'current_status', 'statusText', 'booked_packet_status']);
    const at = new Date(pick(e, ['at', 'date', 'timestamp', 'statusDate', 'datetime']) || Date.now());
    out.push({
      trackingNumber,
      status: normalizeCourierStatus(text),
      description: (pick(e, ['description', 'remarks', 'statusMessage', 'message']) || text).slice(0, 300),
      location: pick(e, ['location', 'city', 'hub']) || null,
      at: Number.isNaN(at.getTime()) ? new Date() : at,
    });
  }
  return out;
}
