import { BadRequestException } from '@nestjs/common';
import { cleanProductSeries } from './store-policies.util';

describe('cleanProductSeries', () => {
  it('null and [] clear the list', () => {
    expect(cleanProductSeries(null)).toEqual([]);
    expect(cleanProductSeries([])).toEqual([]);
  });
  it('trims, strips tags, drops blanks and duplicates (ignoring case)', () => {
    expect(cleanProductSeries(['  Maths Workbook ', '', 'maths workbook', '<b>Urdu</b> Readers'])).toEqual(['Maths Workbook', 'Urdu Readers']);
  });
  it('rejects non-lists and non-text rows', () => {
    expect(() => cleanProductSeries('x')).toThrow(BadRequestException);
    expect(() => cleanProductSeries([1])).toThrow(BadRequestException);
  });
  it('rejects names over 80 characters and lists over 30', () => {
    expect(() => cleanProductSeries(['a'.repeat(81)])).toThrow(BadRequestException);
    expect(() => cleanProductSeries(Array.from({ length: 31 }, (_, i) => `S${i}`))).toThrow(BadRequestException);
    expect(cleanProductSeries(Array.from({ length: 30 }, (_, i) => `S${i}`))).toHaveLength(30);
  });
});
