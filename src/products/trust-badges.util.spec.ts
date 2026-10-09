import { mergeTrustBadges, TrustBadgeError } from './trust-badges.util';

describe('mergeTrustBadges', () => {
  it('starts from nothing', () => {
    expect(mergeTrustBadges(null, { scholarReviewed: true, ageAppropriateMin: 6, ageAppropriateMax: '10' })).toEqual({ scholarReviewed: true, ageAppropriateMin: 6, ageAppropriateMax: 10 });
  });
  it('keeps fields that are not sent and clears with null', () => {
    const cur = { scholarReviewed: true, ageAppropriateMin: 6, ageAppropriateMax: 10 };
    expect(mergeTrustBadges(cur, { scholarReviewed: false })).toEqual({ scholarReviewed: false, ageAppropriateMin: 6, ageAppropriateMax: 10 });
    expect(mergeTrustBadges(cur, { ageAppropriateMax: null }).ageAppropriateMax).toBeNull();
  });
  it('rejects bad input', () => {
    expect(() => mergeTrustBadges(null, { scholarReviewed: 'yes' })).toThrow(TrustBadgeError);
    expect(() => mergeTrustBadges(null, { ageAppropriateMin: -1 })).toThrow(TrustBadgeError);
    expect(() => mergeTrustBadges(null, { ageAppropriateMax: 3.5 })).toThrow(TrustBadgeError);
    expect(() => mergeTrustBadges(null, { ageAppropriateMin: 12, ageAppropriateMax: 8 })).toThrow('cannot be more');
  });
});
