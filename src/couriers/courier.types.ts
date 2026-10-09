/**
 * Courier integrations (Pakistan). Manual tracking stays the default; a courier is only
 * usable when its env credentials are set. Request shapes here follow each courier's public
 * merchant API as best known and are marked TODO(owner) where they must be confirmed against
 * the signed merchant agreement / sandbox before going live.
 */
export type CourierId = 'tcs' | 'leopards' | 'postex';

export interface ShipmentInput {
  /** Our order reference (order number). */
  orderRef: string;
  consignee: { name: string; phone: string; email?: string | null; address: string; city: string };
  pieces: number;
  weightKg: number;
  /** Cash to collect from the receiver, in PKR. 0 for prepaid orders. */
  codAmount: number;
  description: string;
  remarks?: string;
}

export interface ShipmentResult {
  ok: boolean;
  trackingNumber?: string;
  labelUrl?: string | null;
  trackingUrl?: string | null;
  error?: string;
}

export type NormalizedStatus =
  | 'booked' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'returned' | 'failed' | 'unknown';

export interface CourierEvent {
  trackingNumber: string;
  status: NormalizedStatus;
  description: string;
  location: string | null;
  at: Date;
}

export type EnvLike = Record<string, string | undefined>;
export type HttpRequest = (
  url: string,
  init: { method: 'POST' | 'GET'; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<any> }>;

export const DEFAULT_HTTP_REQUEST: HttpRequest = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, json: () => res.json().catch(() => ({})) };
};

export interface CourierAdapter {
  readonly id: CourierId;
  readonly label: string;
  isConfigured(): boolean;
  createShipment(input: ShipmentInput): Promise<ShipmentResult>;
  trackingUrl(trackingNumber: string): string;
  /** Secret the courier must present on its status webhook (null = webhook disabled). */
  webhookSecret(): string | null;
  parseWebhook(body: any): CourierEvent[];
}
