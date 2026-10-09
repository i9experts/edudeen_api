import { buildCouriers, LeopardsCourier, PostExCourier, TcsCourier } from './courier.adapters';
import { normalizeCourierStatus, parseGenericWebhook } from './courier-status';
import type { ShipmentInput } from './courier.types';

const input: ShipmentInput = {
  orderRef: 'ORD-1', pieces: 2, weightKg: 0.5, codAmount: 1500, description: 'Workbooks',
  consignee: { name: 'Ali', phone: '+923001234567', address: 'House 1, Street 2', city: 'Lahore' },
};
const http = (status: number, body: any) => jest.fn().mockResolvedValue({ status, json: async () => body });

describe('courier gating', () => {
  it('nothing is configured without env, and nothing is called', async () => {
    const h = jest.fn();
    for (const c of buildCouriers({}, h)) {
      expect(c.isConfigured()).toBe(false);
      expect((await c.createShipment(input)).ok).toBe(false);
    }
    expect(h).not.toHaveBeenCalled();
  });
});

describe('Leopards', () => {
  const env = { LEOPARDS_API_KEY: 'k', LEOPARDS_API_PASSWORD: 'p' };
  it('books a packet and returns tracking + slip', async () => {
    const h = http(200, { status: 1, track_number: 'LE123', slip_link: 'https://slip/1' });
    const r = await new LeopardsCourier(env, h).createShipment(input);
    expect(r).toMatchObject({ ok: true, trackingNumber: 'LE123', labelUrl: 'https://slip/1' });
    const [url, init] = h.mock.calls[0];
    expect(url).toContain('merchantapistaging');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ booked_packet_collect_amount: 1500, booked_packet_weight: 500, destination_city: 'Lahore', booked_packet_order_id: 'ORD-1' });
  });
  it('uses the live host only when LEOPARDS_ENV=live', async () => {
    const h = http(200, { status: 1, track_number: 'L' });
    await new LeopardsCourier({ ...env, LEOPARDS_ENV: 'live' }, h).createShipment(input);
    expect(h.mock.calls[0][0]).toContain('https://merchantapi.leopardscourier.com');
  });
  it('surfaces API failures without throwing', async () => {
    expect((await new LeopardsCourier(env, http(200, { status: 0, error: 'bad city' })).createShipment(input)).ok).toBe(false);
    expect((await new LeopardsCourier(env, jest.fn().mockRejectedValue(new Error('net'))).createShipment(input)).ok).toBe(false);
  });
});

describe('PostEx', () => {
  it('creates an order with the token header', async () => {
    const h = http(200, { statusCode: '200', dist: { trackingNumber: 'PX9' } });
    const r = await new PostExCourier({ POSTEX_API_TOKEN: 'tok' }, h).createShipment(input);
    expect(r).toMatchObject({ ok: true, trackingNumber: 'PX9' });
    expect(h.mock.calls[0][1].headers.token).toBe('tok');
    expect(JSON.parse(h.mock.calls[0][1].body)).toMatchObject({ invoicePayment: 1500, cityName: 'Lahore' });
  });
});

describe('TCS (stub)', () => {
  it('only active with url + token', async () => {
    expect(new TcsCourier({ TCS_API_URL: 'https://x' }).isConfigured()).toBe(false);
    const h = http(200, { consignmentNo: 'TCS7' });
    expect((await new TcsCourier({ TCS_API_URL: 'https://x', TCS_API_TOKEN: 't' }, h).createShipment(input)).trackingNumber).toBe('TCS7');
  });
});

describe('status normalisation + webhook parsing', () => {
  it('maps common courier phrases', () => {
    expect(normalizeCourierStatus('Shipment Delivered')).toBe('delivered');
    expect(normalizeCourierStatus('Delivery attempt failed')).toBe('failed');
    expect(normalizeCourierStatus('Return to shipper')).toBe('returned');
    expect(normalizeCourierStatus('Out for delivery')).toBe('out_for_delivery');
    expect(normalizeCourierStatus('Picked up')).toBe('picked_up');
    expect(normalizeCourierStatus('Arrived at Lahore hub')).toBe('in_transit');
    expect(normalizeCourierStatus('')).toBe('unknown');
  });
  it('parses single, array and wrapped payloads; skips rows without a tracking number', () => {
    expect(parseGenericWebhook({ trackingNumber: 'A1', status: 'Delivered', city: 'Lahore' })[0]).toMatchObject({ trackingNumber: 'A1', status: 'delivered', location: 'Lahore' });
    expect(parseGenericWebhook([{ track_number: 'B', status: 'In transit' }, { status: 'x' }])).toHaveLength(1);
    expect(parseGenericWebhook({ events: [{ cn: 'C', status: 'Picked up' }] })[0].status).toBe('picked_up');
    expect(parseGenericWebhook(null)).toEqual([]);
  });
});
