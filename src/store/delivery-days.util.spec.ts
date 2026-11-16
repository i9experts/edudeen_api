import { BadRequestException } from '@nestjs/common';
import { cleanDeliveryDays, routeDaysFor } from './delivery-days.util';

describe('cleanDeliveryDays', () => {
  it('accepts whole days 0-30 with min <= max; empty rows are dropped; all empty = null', () => {
    expect(cleanDeliveryDays({ sameCity: { min: 1, max: 2 }, national: { min: '3', max: '6' } })).toEqual({ sameCity: { min: 1, max: 2 }, national: { min: 3, max: 6 } });
    expect(cleanDeliveryDays({ sameCity: { min: '', max: '' } })).toBeNull();
    expect(cleanDeliveryDays({})).toBeNull();
    expect(cleanDeliveryDays(null)).toBeNull();
    expect(cleanDeliveryDays({ national: { min: 0, max: 30 } })).toEqual({ national: { min: 0, max: 30 } });
  });
  it.each([
    [{ sameCity: { min: 3, max: 2 } }],
    [{ sameCity: { min: -1, max: 2 } }],
    [{ sameCity: { min: 1, max: 31 } }],
    [{ sameCity: { min: 1.5, max: 2 } }],
    [{ sameCity: { min: 1 } }],
    [{ abroad: { min: 1, max: 2 } }],
    ['3-5'],
  ])('rejects %j', (bad) => {
    expect(() => cleanDeliveryDays(bad)).toThrow(BadRequestException);
  });
});

describe('routeDaysFor', () => {
  const stored = { sameCity: { min: 1, max: 2 }, national: { min: 4, max: 7 } };
  it('returns the stored range for the route, null when unset / unknown route / corrupt', () => {
    expect(routeDaysFor(stored, 'sameCity')).toEqual({ min: 1, max: 2 });
    expect(routeDaysFor(stored, 'sameProvince')).toBeNull();
    expect(routeDaysFor(stored, null)).toBeNull();
    expect(routeDaysFor(null, 'national')).toBeNull();
    expect(routeDaysFor({ national: { min: 9, max: 2 } }, 'national')).toBeNull();
  });
});
