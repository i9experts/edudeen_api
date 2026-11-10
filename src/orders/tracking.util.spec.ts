import { BadRequestException } from '@nestjs/common';
import { cleanTracking, isSelfDelivery } from './tracking.util';

describe('cleanTracking', () => {
  it('TCS without a number is rejected', () => {
    expect(() => cleanTracking({ carrier: 'TCS' })).toThrow(BadRequestException);
    expect(() => cleanTracking({ carrier: 'TCS', trackingNumber: '   ' })).toThrow('tracking number is required');
  });
  it('TCS with a number is accepted and trimmed', () => {
    expect(cleanTracking({ carrier: ' TCS ', trackingNumber: ' 123 ', trackingUrl: 'https://www.tcsexpress.com/track/123' }))
      .toMatchObject({ carrier: 'TCS', trackingNumber: '123', trackingUrl: 'https://www.tcsexpress.com/track/123', expectedDeliveryDate: null, note: null });
  });
  it('I deliver myself needs no number; keeps date + note', () => {
    const d = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const t = cleanTracking({ carrier: 'I deliver myself', expectedDeliveryDate: d, note: 'Rider will call' });
    expect(t.trackingNumber).toBeNull();
    expect(t.note).toBe('Rider will call');
    expect(t.expectedDeliveryDate).toBeInstanceOf(Date);
    expect(isSelfDelivery('i deliver myself')).toBe(true);
  });
  it('courier carriers drop date/note (not theirs)', () => {
    expect(cleanTracking({ carrier: 'TCS', trackingNumber: '1', note: 'x' }).note).toBeNull();
  });
  it('rejects non-http links, long values, bad dates, missing object', () => {
    expect(() => cleanTracking({ carrier: 'TCS', trackingNumber: '1', trackingUrl: 'javascript:alert(1)' })).toThrow('http');
    expect(() => cleanTracking({ carrier: 'TCS', trackingNumber: 'x'.repeat(61) })).toThrow('too long');
    expect(() => cleanTracking({ carrier: 'x'.repeat(61), trackingNumber: '1' })).toThrow('too long');
    expect(() => cleanTracking({ carrier: 'I deliver myself', note: 'n'.repeat(301) })).toThrow('too long');
    expect(() => cleanTracking({ carrier: 'I deliver myself', expectedDeliveryDate: 'nope' })).toThrow('valid date');
    expect(() => cleanTracking(undefined)).toThrow(BadRequestException);
    expect(() => cleanTracking({ trackingNumber: '1' })).toThrow('carrier');
  });
});