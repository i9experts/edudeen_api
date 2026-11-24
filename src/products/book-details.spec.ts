import { BadRequestException } from '@nestjs/common';
import { cleanLearningMeta, cleanShortText, isValidIsbn, BOOK_DETAIL_LIMITS } from './product-input.util';

describe('optional book details (author / publisher / edition)', () => {
  it('is untouched when not sent (an edit leaves them alone)', () => {
    const out = cleanLearningMeta({});
    expect('author' in out).toBe(false);
    expect('publisher' in out).toBe(false);
    expect('edition' in out).toBe(false);
  });

  it('trims, collapses spaces and keeps plain text', () => {
    expect(cleanLearningMeta({ author: '  Ahmed   Khan ', publisher: 'Oxford University Press', edition: '3rd edition, 2024' }))
      .toEqual({ author: 'Ahmed Khan', publisher: 'Oxford University Press', edition: '3rd edition, 2024' });
  });

  it('empty string or null clears the field (stored as null)', () => {
    expect(cleanLearningMeta({ author: '', publisher: null, edition: '   ' })).toEqual({ author: null, publisher: null, edition: null });
  });

  it('strips tags and control characters', () => {
    expect(cleanShortText('<b>Ali</b>\u0000 Raza', 'author', 120)).toBe('Ali Raza');
  });

  it('rejects text that is too long or not text', () => {
    expect(() => cleanLearningMeta({ author: 'a'.repeat(BOOK_DETAIL_LIMITS.author + 1) })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ edition: 'e'.repeat(BOOK_DETAIL_LIMITS.edition + 1) })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ publisher: 42 })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ author: { $ne: 1 } })).toThrow(BadRequestException);
  });

  it('exactly the limit is accepted', () => {
    expect(cleanLearningMeta({ edition: 'e'.repeat(BOOK_DETAIL_LIMITS.edition) }).edition).toHaveLength(60);
  });
});

describe('optional book details (pages / isbn / binding)', () => {
  it('is untouched when not sent', () => {
    const out = cleanLearningMeta({});
    expect('pages' in out).toBe(false);
    expect('isbn' in out).toBe(false);
    expect('binding' in out).toBe(false);
  });

  it('accepts valid values; ISBN is stored as digits only', () => {
    expect(cleanLearningMeta({ pages: 240, isbn: '978-0-306-40615-7', binding: 'hardcover' }))
      .toEqual({ pages: 240, isbn: '9780306406157', binding: 'hardcover' });
    expect(cleanLearningMeta({ isbn: '0-8044-2957-X' }).isbn).toBe('080442957X');
    expect(cleanLearningMeta({ isbn: '0 306 40615 2' }).isbn).toBe('0306406152');
  });

  it('empty or null clears them', () => {
    expect(cleanLearningMeta({ pages: null, isbn: '  ', binding: '' })).toEqual({ pages: null, isbn: null, binding: null });
  });

  it('rejects a bad checksum, wrong length or letters', () => {
    expect(isValidIsbn('9780306406158')).toBe(false);
    expect(() => cleanLearningMeta({ isbn: '9780306406158' })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ isbn: '12345' })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ isbn: 'abcdefghij' })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ isbn: 9780306406157 })).toThrow(BadRequestException);
  });

  it('pages must be a whole number from 1 to 5000', () => {
    expect(cleanLearningMeta({ pages: 5000 }).pages).toBe(5000);
    for (const bad of [0, -3, 5001, 12.5, '12', NaN]) expect(() => cleanLearningMeta({ pages: bad })).toThrow(BadRequestException);
  });

  it('binding must be a known value', () => {
    expect(() => cleanLearningMeta({ binding: 'glued' })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ binding: { $ne: 1 } })).toThrow(BadRequestException);
  });
});
