import { cleanStorePageDraft, cleanEducatorProfile, storePageFromStore } from './store-page.util';

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
