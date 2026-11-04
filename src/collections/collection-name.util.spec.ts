import { normalizeCollectionName, cleanCollectionName } from './collection-name.util';

describe('collection name rules', () => {
  it('treats spacing, case and punctuation as the same name', () => {
    const k = normalizeCollectionName('Hurry Up !');
    expect(k).toBe('hurryup');
    expect(normalizeCollectionName('hurry-up')).toBe(k);
    expect(normalizeCollectionName('  HURRY   UP!! ')).toBe(k);
  });
  it('keeps different names apart and keeps Urdu letters', () => {
    expect(normalizeCollectionName('Offer')).not.toBe(normalizeCollectionName('Offers'));
    expect(normalizeCollectionName('نئی کتابیں')).toBe('نئیکتابیں');
  });
  it('punctuation-only names normalise to empty', () => {
    expect(normalizeCollectionName('!!! ---')).toBe('');
  });
  it('cleans whitespace', () => {
    expect(cleanCollectionName('  New   Arrivals ')).toBe('New Arrivals');
    expect(cleanCollectionName(5)).toBe('');
  });
});
