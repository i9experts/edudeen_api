import { BadRequestException } from '@nestjs/common';
import { cleanLearningMeta, cleanShortText, BOOK_DETAIL_LIMITS } from './product-input.util';

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
