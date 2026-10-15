import { BadRequestException } from '@nestjs/common';
import { assertDescriptionRule, assertPriceRules } from './price-rules.util';

const msg = (fn: () => void) => {
  try { fn(); } catch (e) { if (e instanceof BadRequestException) return String((e.getResponse() as any).message ?? e.message); throw e; }
  return null;
};

describe('assertPriceRules', () => {
  it('accepts a normal sale', () => {
    expect(msg(() => assertPriceRules({ price: 450, compareAtPrice: 500, currency: 'PKR' }))).toBeNull();
    expect(msg(() => assertPriceRules({ price: 4.99, compareAtPrice: 9.99, currency: 'USD' }))).toBeNull();
  });
  it('accepts no compare-at and a free price of 0', () => {
    expect(msg(() => assertPriceRules({ price: 450, compareAtPrice: null, currency: 'PKR' }))).toBeNull();
    expect(msg(() => assertPriceRules({ price: 450, currency: 'PKR' }))).toBeNull();
    expect(msg(() => assertPriceRules({ price: 0, currency: 'PKR' }))).toBeNull();
  });
  it('rejects compare-at below or equal to price', () => {
    expect(msg(() => assertPriceRules({ price: 450, compareAtPrice: 400, currency: 'PKR' }))).toBe('Compare-at must be higher than price');
    expect(msg(() => assertPriceRules({ price: 450, compareAtPrice: 450, currency: 'PKR' }))).toBe('Compare-at must be higher than price');
  });
  it('rejects negatives', () => {
    expect(msg(() => assertPriceRules({ price: -5, currency: 'PKR' }))).toBe("Price can't be negative");
    expect(msg(() => assertPriceRules({ price: 5, compareAtPrice: -1, currency: 'USD' }))).toBe("Compare-at price can't be negative");
  });
  it('PKR must be whole rupees, USD at most 2 decimals', () => {
    expect(msg(() => assertPriceRules({ price: 450.75, currency: 'PKR' }))).toMatch(/whole rupees/);
    expect(msg(() => assertPriceRules({ price: 450, compareAtPrice: 500.5, currency: 'PKR' }))).toMatch(/whole rupees/);
    expect(msg(() => assertPriceRules({ price: 4.999, currency: 'USD' }))).toMatch(/at most 2 decimals/);
  });
  it('leaves non-numbers to the type check', () => {
    expect(msg(() => assertPriceRules({ price: '450', compareAtPrice: '400', currency: 'PKR' }))).toBeNull();
  });
});

describe('assertDescriptionRule', () => {
  it('rejects missing, blank and whitespace-only descriptions', () => {
    expect(msg(() => assertDescriptionRule(undefined))).toBe('description is required');
    expect(msg(() => assertDescriptionRule(null))).toBe('description is required');
    expect(msg(() => assertDescriptionRule('   \n '))).toBe('description is required');
  });
  it('requires 20 trimmed characters', () => {
    expect(msg(() => assertDescriptionRule('Too short'))).toMatch(/at least 20 characters/);
    expect(msg(() => assertDescriptionRule(`${' '.repeat(40)}short`))).toMatch(/at least 20 characters/);
    expect(msg(() => assertDescriptionRule('A worksheet pack for class two maths.'))).toBeNull();
  });
});
