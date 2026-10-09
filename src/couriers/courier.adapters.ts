import { DEFAULT_HTTP_REQUEST, type CourierAdapter, type CourierEvent, type EnvLike, type HttpRequest, type ShipmentInput, type ShipmentResult } from './courier.types';
import { parseGenericWebhook } from './courier-status';

const trim = (v: string | undefined) => (v ?? '').trim();

/** Leopards Courier merchant API (bookPacket). Env: LEOPARDS_API_KEY, LEOPARDS_API_PASSWORD, LEOPARDS_ENV=sandbox|live, LEOPARDS_ORIGIN_CITY, LEOPARDS_WEBHOOK_SECRET.
 * TODO(owner): Leopards books by city ID; map consignee.city through their getAllCities API (or pass IDs). */
export class LeopardsCourier implements CourierAdapter {
  readonly id = 'leopards' as const;
  readonly label = 'Leopards';
  constructor(private readonly env: EnvLike, private readonly http: HttpRequest = DEFAULT_HTTP_REQUEST) {}

  isConfigured() { return !!(trim(this.env.LEOPARDS_API_KEY) && trim(this.env.LEOPARDS_API_PASSWORD)); }
  webhookSecret() { return trim(this.env.LEOPARDS_WEBHOOK_SECRET) || null; }
  trackingUrl(tn: string) { return `https://www.leopardscourier.com/tracking?cn=${encodeURIComponent(tn)}`; }
  parseWebhook(body: any): CourierEvent[] { return parseGenericWebhook(body); }

  async createShipment(i: ShipmentInput): Promise<ShipmentResult> {
    if (!this.isConfigured()) return { ok: false, error: 'leopards_not_configured' };
    const base = trim(this.env.LEOPARDS_ENV).toLowerCase() === 'live' ? 'https://merchantapi.leopardscourier.com' : 'https://merchantapistaging.leopardscourier.com';
    const body = {
      api_key: trim(this.env.LEOPARDS_API_KEY),
      api_password: trim(this.env.LEOPARDS_API_PASSWORD),
      booked_packet_weight: Math.max(1, Math.round(i.weightKg * 1000)),
      booked_packet_no_piece: i.pieces,
      booked_packet_collect_amount: i.codAmount,
      booked_packet_order_id: i.orderRef,
      origin_city: trim(this.env.LEOPARDS_ORIGIN_CITY) || 'self',
      destination_city: i.consignee.city,
      shipment_name_eng: 'Edudeen',
      consignment_name_eng: i.consignee.name,
      consignment_phone: i.consignee.phone,
      consignment_email: i.consignee.email ?? '',
      consignment_address: i.consignee.address,
      special_instructions: i.remarks ?? i.description,
    };
    try {
      const res = await this.http(`${base}/api/bookPacket/format/json/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (res.status === 200 && Number(j?.status) === 1 && j?.track_number) {
        return { ok: true, trackingNumber: String(j.track_number), labelUrl: j.slip_link ?? null, trackingUrl: this.trackingUrl(String(j.track_number)) };
      }
      return { ok: false, error: `leopards:${j?.error ?? res.status}`.slice(0, 200) };
    } catch (e: any) {
      return { ok: false, error: `leopards_failed:${e?.message ?? 'error'}` };
    }
  }
}

/** PostEx merchant API (create-order v3). Env: POSTEX_API_TOKEN, POSTEX_PICKUP_ADDRESS_CODE, POSTEX_WEBHOOK_SECRET.
 * TODO(owner): PostEx labels need an authenticated download (token header), so labelUrl is null; print from the PostEx portal or add a proxy. */
export class PostExCourier implements CourierAdapter {
  readonly id = 'postex' as const;
  readonly label = 'PostEx';
  constructor(private readonly env: EnvLike, private readonly http: HttpRequest = DEFAULT_HTTP_REQUEST) {}

  isConfigured() { return !!trim(this.env.POSTEX_API_TOKEN); }
  webhookSecret() { return trim(this.env.POSTEX_WEBHOOK_SECRET) || null; }
  trackingUrl(tn: string) { return `https://postex.pk/tracking?cn=${encodeURIComponent(tn)}`; }
  parseWebhook(body: any): CourierEvent[] { return parseGenericWebhook(body); }

  async createShipment(i: ShipmentInput): Promise<ShipmentResult> {
    if (!this.isConfigured()) return { ok: false, error: 'postex_not_configured' };
    const body = {
      cityName: i.consignee.city,
      customerName: i.consignee.name,
      customerPhone: i.consignee.phone,
      deliveryAddress: i.consignee.address,
      invoiceDivision: 1,
      invoicePayment: i.codAmount,
      items: i.pieces,
      orderDetail: i.description,
      orderRefNumber: i.orderRef,
      orderType: 'Normal',
      transactionNotes: i.remarks ?? '',
      pickupAddressCode: trim(this.env.POSTEX_PICKUP_ADDRESS_CODE) || undefined,
    };
    try {
      const res = await this.http('https://api.postex.pk/services/integration/api/order/v3/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: trim(this.env.POSTEX_API_TOKEN) },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      const tn = j?.dist?.trackingNumber;
      if (res.status === 200 && String(j?.statusCode) === '200' && tn) {
        return { ok: true, trackingNumber: String(tn), labelUrl: null, trackingUrl: this.trackingUrl(String(tn)) };
      }
      return { ok: false, error: `postex:${j?.statusMessage ?? res.status}`.slice(0, 200) };
    } catch (e: any) {
      return { ok: false, error: `postex_failed:${e?.message ?? 'error'}` };
    }
  }
}

/** TCS adapter (stub). Env: TCS_API_URL (booking endpoint), TCS_API_TOKEN, TCS_COST_CENTER_CODE, TCS_WEBHOOK_SECRET.
 * TODO(owner): TCS e-commerce booking uses a merchant-specific token/endpoint; confirm the request/response shape
 * with TCS before enabling. It is only active when TCS_API_URL and TCS_API_TOKEN are both set. */
export class TcsCourier implements CourierAdapter {
  readonly id = 'tcs' as const;
  readonly label = 'TCS';
  constructor(private readonly env: EnvLike, private readonly http: HttpRequest = DEFAULT_HTTP_REQUEST) {}

  isConfigured() { return !!(trim(this.env.TCS_API_URL) && trim(this.env.TCS_API_TOKEN)); }
  webhookSecret() { return trim(this.env.TCS_WEBHOOK_SECRET) || null; }
  trackingUrl(tn: string) { return `https://www.tcsexpress.com/track/${encodeURIComponent(tn)}`; }
  parseWebhook(body: any): CourierEvent[] { return parseGenericWebhook(body); }

  async createShipment(i: ShipmentInput): Promise<ShipmentResult> {
    if (!this.isConfigured()) return { ok: false, error: 'tcs_not_configured' };
    try {
      const res = await this.http(trim(this.env.TCS_API_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${trim(this.env.TCS_API_TOKEN)}` },
        body: JSON.stringify({
          costCenterCode: trim(this.env.TCS_COST_CENTER_CODE) || undefined,
          consigneeName: i.consignee.name,
          consigneeAddress: i.consignee.address,
          consigneeMobNo: i.consignee.phone,
          consigneeEmail: i.consignee.email ?? '',
          destinationCityName: i.consignee.city,
          pieces: i.pieces,
          weight: i.weightKg,
          codAmount: i.codAmount,
          customerReferenceNo: i.orderRef,
          services: 'O',
          productDetails: i.description,
          fragile: 'No',
          remarks: i.remarks ?? '',
        }),
      });
      const j = await res.json();
      const tn = j?.consignmentNo ?? j?.consignmentNumber ?? j?.trackingNumber;
      if (res.status === 200 && tn) return { ok: true, trackingNumber: String(tn), labelUrl: j?.labelUrl ?? null, trackingUrl: this.trackingUrl(String(tn)) };
      return { ok: false, error: `tcs:${j?.message ?? res.status}`.slice(0, 200) };
    } catch (e: any) {
      return { ok: false, error: `tcs_failed:${e?.message ?? 'error'}` };
    }
  }
}

export function buildCouriers(env: EnvLike = process.env, http?: HttpRequest): CourierAdapter[] {
  return [new TcsCourier(env, http), new LeopardsCourier(env, http), new PostExCourier(env, http)];
}
