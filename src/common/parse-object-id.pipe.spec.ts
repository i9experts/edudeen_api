import { BadRequestException } from '@nestjs/common';
import { OptionalParseObjectIdPipe, ParseObjectIdPipe } from './parse-object-id.pipe';

describe('ParseObjectIdPipe / OptionalParseObjectIdPipe', () => {
  const id = '64b000000000000000000a01';
  it('required: accepts a valid id, rejects missing / malformed', () => {
    const p = new ParseObjectIdPipe();
    expect(p.transform(id)).toBe(id);
    expect(() => p.transform(undefined)).toThrow(BadRequestException);
    expect(() => p.transform('nope')).toThrow(BadRequestException);
  });
  it('optional: an absent id passes (marketplace wishlist has no storeId), a malformed one is still a 400', () => {
    const p = new OptionalParseObjectIdPipe();
    expect(p.transform(undefined)).toBeUndefined();
    expect(p.transform(null)).toBeUndefined();
    expect(p.transform('')).toBeUndefined();
    expect(p.transform(id)).toBe(id);
    expect(() => p.transform('nope')).toThrow(BadRequestException);
  });
});
