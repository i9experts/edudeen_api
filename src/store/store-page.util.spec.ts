import { cleanStorePageDraft, cleanEducatorProfile, storePageFromStore, normalizeStorePhone, cleanStoreContactPhone, cleanStoreContactEmail } from './store-page.util';

const base = storePageFromStore({ name: 'Noor Hub', tagline: 'Hi', logo: 'https://x.com/l.png', educatorProfile: { headline: 'T', qualifications: [], experienceYears: 3, subjects: [], institutions: [], teachingLevels: [], introVideoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' } });

describe('store-page.util', () => {
  it('partial save keeps the rest of the draft', () => {
    const d = cleanStorePageDraft({ tagline: '  New <b>line</b> ' }, base);
    expect(d.tagline).toBe('New line');
    expect(d.name).toBe('Noor Hub');
    expect(d.logo).toBe('https://x.com/l.png');
  });
  it('rejects blank name, non-https images, long about text', () => {
    expect(() => cleanStorePageDraft({ name: '   ' }, base)).toThrow();
    expect(() => cleanStorePageDraft({ logo: 'http://x.com/a.png' }, base)).toThrow(/https/);
    expect(() => cleanStorePageDraft({ aboutBio: 'a'.repeat(1501) }, base)).toThrow();
  });
  it('empty values clear nullable fields', () => {
    const d = cleanStorePageDraft({ tagline: '', coverImage: null, aboutBio: '', logo: '' }, base);
    expect(d.tagline).toBeNull();
    expect(d.coverImage).toBeNull();
    expect(d.aboutBio).toBeNull();
    expect(d.logo).toBeNull();
  });
  it('teacher profile: years must be a whole 0-70, bad video link refused, missing video keeps the stored one', () => {
    expect(() => cleanEducatorProfile({ experienceYears: 71 }, null)).toThrow();
    expect(() => cleanEducatorProfile({ introVideoUrl: 'https://evil.com/x' }, null)).toThrow();
    const kept = cleanEducatorProfile({ headline: 'H', experienceYears: 5 }, 'https://www.youtube.com/watch?v=abcdefghijk');
    expect(kept?.introVideoUrl).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(cleanEducatorProfile(null, 'x')).toBeNull();
  });
  it('a draft teacher profile without a video keeps the draft base video', () => {
    const d = cleanStorePageDraft({ educatorProfile: { headline: 'New' } }, base);
    expect(d.educatorProfile?.introVideoUrl).toContain('youtube');
  });
});

describe('store profile limits (shared by updateStore and the draft)', () => {
  it('draft: new name > 60, tagline > 100, description > 1000 are refused', () => {
    expect(() => cleanStorePageDraft({ name: 'n'.repeat(61) }, base)).toThrow(/at most 60/);
    expect(() => cleanStorePageDraft({ tagline: 't'.repeat(101) }, base)).toThrow(/at most 100/);
    expect(() => cleanStorePageDraft({ description: 'd'.repeat(1001) }, base)).toThrow(/at most 1000/);
    expect(cleanStorePageDraft({ name: 'n'.repeat(60), tagline: 't'.repeat(100), description: 'd'.repeat(1000) }, base).description).toHaveLength(1000);
  });
  it('draft: a legacy value that is NOT changed is still accepted, a longer new one is not', () => {
    const legacy = storePageFromStore({ name: 'Noor Hub', description: 'word '.repeat(600).trim() }); // ~3000 chars
    expect(legacy.description!.length).toBeGreaterThan(1000);
    const kept = cleanStorePageDraft({ description: legacy.description, tagline: 'New' }, legacy);
    expect(kept.description).toBe(legacy.description);
    expect(() => cleanStorePageDraft({ description: legacy.description + ' more' }, legacy)).toThrow(/at most 1000/);
  });
  it('normalizeStorePhone: mobile + landline -> +92..., junk -> null', () => {
    expect(normalizeStorePhone('0300 1234567')).toBe('+923001234567');
    expect(normalizeStorePhone('+92 300-1234567')).toBe('+923001234567');
    expect(normalizeStorePhone('00923001234567')).toBe('+923001234567');
    expect(normalizeStorePhone('923001234567')).toBe('+923001234567');
    expect(normalizeStorePhone('(042) 3512 3456')).toBe('+924235123456');
    expect(normalizeStorePhone('021-34567890')).toBe('+922134567890');
    for (const bad of ['abc', '', '12345', '+1 555 123 4567', '0300123', '03001234567890', '+92 300 123 45x7', '3001234567']) {
      expect(normalizeStorePhone(bad)).toBeNull();
    }
  });
  it('contact phone: "abc" refused, new valid one normalised, unchanged legacy one kept, empty clears', () => {
    expect(() => cleanStoreContactPhone('abc', null)).toThrow(/valid Pakistani phone/);
    expect(cleanStoreContactPhone('0300 1234567', null)).toBe('+923001234567');
    expect(cleanStoreContactPhone('call me', 'call me')).toBe('call me');
    expect(() => cleanStoreContactPhone('call me now', 'call me')).toThrow();
    expect(cleanStoreContactPhone('', '+923001234567')).toBeNull();
    expect(() => cleanStoreContactPhone({ $ne: 1 }, null)).toThrow();
  });
  it('contact e-mail: format checked on change only', () => {
    expect(() => cleanStoreContactEmail('nope', null)).toThrow(/valid email/);
    expect(cleanStoreContactEmail('a@b.co', null)).toBe('a@b.co');
    expect(cleanStoreContactEmail('legacy-address', 'legacy-address')).toBe('legacy-address');
    expect(cleanStoreContactEmail('', 'a@b.co')).toBeNull();
  });
});

describe('teaching chips (grades / subjects / languages)', () => {
  it('starts empty and accepts fixed values, de-duplicated', () => {
    expect(base.gradesServed).toEqual([]);
    const next = cleanStorePageDraft({ gradesServed: ['class-1', 'class-1', 'o-level'], subjects: ['arabic'], teachingLanguages: ['urdu', 'english'] }, base);
    expect(next.gradesServed).toEqual(['class-1', 'o-level']);
    expect(next.subjects).toEqual(['arabic']);
    expect(next.teachingLanguages).toEqual(['urdu', 'english']);
  });
  it('null clears; an omitted key keeps the base', () => {
    const withChips = { ...base, subjects: ['arabic'] };
    expect(cleanStorePageDraft({ subjects: null }, withChips).subjects).toEqual([]);
    expect(cleanStorePageDraft({ name: 'Noor Hub 2' }, withChips).subjects).toEqual(['arabic']);
  });
  it('rejects unknown values, non-lists and too many', () => {
    expect(() => cleanStorePageDraft({ gradesServed: ['class-99'] }, base)).toThrow();
    expect(() => cleanStorePageDraft({ subjects: ['cooking'] }, base)).toThrow();
    expect(() => cleanStorePageDraft({ teachingLanguages: 'urdu' }, base)).toThrow();
    expect(() => cleanStorePageDraft({ teachingLanguages: ['urdu', 'english', 'arabic', 'other', 'urdu2'] }, base)).toThrow();
    expect(() => cleanStorePageDraft({ subjects: [1] }, base)).toThrow();
  });
});