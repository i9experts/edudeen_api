import { normalizePkPhone, renderMessage } from './message-templates';
import { planDelivery, type ChannelPrefs } from './channel-plan';
import { WhatsAppCloudChannel } from './whatsapp-cloud.channel';
import { HttpSmsChannel } from './sms.channel';

const WA_ENV = { WHATSAPP_ACCESS_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123' };
const SMS_ENV = { SMS_GATEWAY_URL: 'https://sms.test/send', SMS_GATEWAY_TOKEN: 'sk' };
const prefs = (o: Partial<ChannelPrefs> = {}): ChannelPrefs => ({ ordersCategoryEnabled: true, whatsappEnabled: true, smsEnabled: false, language: 'en', ...o });

describe('templates', () => {
  it('renders EN and UR with values and never leaves a placeholder', () => {
    expect(renderMessage('order_shipped', 'en', { orderNumber: 'ORD-1', carrier: 'TCS', trackingNumber: 'T123' })).toContain('TCS');
    const ur = renderMessage('order_delivered', 'ur', { orderNumber: 'ORD-1' });
    expect(ur).toContain('ORD-1');
    expect(ur).toMatch(/[\u0600-\u06FF]/);
    expect(renderMessage('order_shipped', 'en', { orderNumber: 'X' })).not.toContain('{');
  });
  it('normalises Pakistani numbers', () => {
    for (const n of ['03001234567', '3001234567', '923001234567', '+92 300 1234567', '0092-300-1234567']) expect(normalizePkPhone(n)).toBe('+923001234567');
    expect(normalizePkPhone('12345')).toBeNull();
    expect(normalizePkPhone(null)).toBeNull();
  });
});

describe('planDelivery (opt-in + preferences)', () => {
  const chans = [new WhatsAppCloudChannel(WA_ENV), new HttpSmsChannel(SMS_ENV)];
  const base = { event: 'order_placed' as const, vars: { orderNumber: 'A1', total: 'Rs 500' }, rawPhone: '03001234567', channels: chans };

  it('sends nothing unless the buyer opted in', () => {
    expect(planDelivery({ ...base, prefs: prefs({ whatsappEnabled: false }) })).toBeNull();
  });
  it('respects the orders category switch', () => {
    expect(planDelivery({ ...base, prefs: prefs({ ordersCategoryEnabled: false }) })).toBeNull();
  });
  it('needs a valid number', () => {
    expect(planDelivery({ ...base, rawPhone: 'abc', prefs: prefs() })).toBeNull();
  });
  it('prefers WhatsApp, falls back to SMS, never both', () => {
    expect(planDelivery({ ...base, prefs: prefs({ smsEnabled: true }) })?.channel).toBe('whatsapp');
    expect(planDelivery({ ...base, channels: [new HttpSmsChannel(SMS_ENV)], prefs: prefs({ smsEnabled: true }) })?.channel).toBe('sms');
  });
  it('does nothing when no channel is configured', () => {
    expect(planDelivery({ ...base, channels: [new WhatsAppCloudChannel({}), new HttpSmsChannel({})], prefs: prefs({ smsEnabled: true }) })).toBeNull();
  });
  it('uses the buyer language', () => {
    expect(planDelivery({ ...base, prefs: prefs({ language: 'ur' }) })?.text).toMatch(/[\u0600-\u06FF]/);
  });
});

describe('WhatsAppCloudChannel', () => {
  const msg = { to: '+923001234567', event: 'order_shipped' as const, lang: 'ur' as const, vars: { orderNumber: 'A1', carrier: 'TCS', trackingNumber: 'T9' }, text: 'hello' };
  const http = (status: number, body: any) => jest.fn().mockResolvedValue({ status, json: async () => body });

  it('is off without credentials and does not call the network', async () => {
    const post = http(200, {});
    const r = await new WhatsAppCloudChannel({}, post).send(msg);
    expect(r.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it('sends plain text when no template is configured', async () => {
    const post = http(200, { messages: [{ id: 'wamid.1' }] });
    const r = await new WhatsAppCloudChannel(WA_ENV, post).send(msg);
    expect(r).toEqual({ ok: true, id: 'wamid.1' });
    const [url, init] = post.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v20.0/123/messages');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toMatchObject({ to: '923001234567', type: 'text', text: { body: 'hello' } });
  });
  it('sends the approved template with ordered variables and language', async () => {
    const post = http(200, { messages: [{ id: 'w2' }] });
    await new WhatsAppCloudChannel({ ...WA_ENV, WHATSAPP_TEMPLATE_ORDER_SHIPPED: 'edudeen_shipped' }, post).send(msg);
    const body = JSON.parse(post.mock.calls[0][1].body);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('edudeen_shipped');
    expect(body.template.language.code).toBe('ur');
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(['A1', 'TCS', 'T9']);
  });
  it('reports API errors and network failures without throwing', async () => {
    expect((await new WhatsAppCloudChannel(WA_ENV, http(400, { error: { message: 'bad' } })).send(msg)).ok).toBe(false);
    expect((await new WhatsAppCloudChannel(WA_ENV, jest.fn().mockRejectedValue(new Error('net'))).send(msg)).ok).toBe(false);
  });
});

describe('HttpSmsChannel', () => {
  it('is a no-op stub until configured; posts to the gateway when configured', async () => {
    const msg = { to: '+923001234567', event: 'order_placed' as const, lang: 'en' as const, vars: {}, text: 'hi' };
    const never = jest.fn();
    expect((await new HttpSmsChannel({}, never).send(msg)).ok).toBe(false);
    expect(never).not.toHaveBeenCalled();
    const post = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ id: 's1' }) });
    expect(await new HttpSmsChannel(SMS_ENV, post).send(msg)).toEqual({ ok: true, id: 's1' });
    expect(JSON.parse(post.mock.calls[0][1].body)).toMatchObject({ to: '+923001234567', message: 'hi' });
  });
});
