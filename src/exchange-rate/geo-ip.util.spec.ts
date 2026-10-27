import { clientIpOf, countryFromIp, isPublicIp } from './geo-ip.util';

describe('geo-ip', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('only public IPs are looked up', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.1.1', '::1', 'nope']) expect(isPublicIp(ip)).toBe(false);
  });

  it('takes the first public client IP from X-Forwarded-For', () => {
    expect(clientIpOf({ ip: '10.0.0.2', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' } })).toBe('203.0.113.9');
    expect(clientIpOf({ ip: '::ffff:1.2.3.4', headers: {} })).toBe('1.2.3.4');
    expect(clientIpOf({ ip: '127.0.0.1', headers: {} })).toBeNull();
  });

  it('maps the lookup answer to a country, caches it, and fails soft', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ip: '5.6.7.8', country: 'de' }) }) as any;
    expect(await countryFromIp('5.6.7.8')).toBe('DE');
    expect(await countryFromIp('5.6.7.8')).toBe('DE');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as any;
    expect(await countryFromIp('9.9.9.9')).toBeNull();
    expect(await countryFromIp(null)).toBeNull();
  });
});
