import { cleanFaqs, cleanIntroVideoUrl, cleanShippingNote, parseIntroVideo } from './store-policies.util';

describe('parseIntroVideo', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=5', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://vimeo.com/123456789', 'vimeo', '123456789'],
    ['https://player.vimeo.com/video/123456789', 'vimeo', '123456789'],
  ])('accepts %s', (url, provider, id) => {
    expect(parseIntroVideo(url)).toMatchObject({ provider, id });
  });

  it.each([
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
    'https://www.youtube.com/watch?v=short',
    'https://vimeo.com/abc',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseIntroVideo(url)).toBeNull();
    expect(() => cleanIntroVideoUrl(url)).toThrow();
  });

  it('stores only the canonical url, empty clears', () => {
    expect(cleanIntroVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=x')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(cleanIntroVideoUrl('')).toBeNull();
    expect(cleanIntroVideoUrl(null)).toBeNull();
  });
});

describe('cleanFaqs / cleanShippingNote', () => {
  it('strips tags, drops blank rows, keeps order', () => {
    expect(cleanFaqs([{ q: ' Hi <b>there</b> ', a: 'A' }, { q: '', a: '' }, { q: 'Two', a: 'B' }])).toEqual([
      { q: 'Hi there', a: 'A' }, { q: 'Two', a: 'B' },
    ]);
  });
  it('rejects half rows, >8, long text, non-lists', () => {
    expect(() => cleanFaqs([{ q: 'only q', a: '' }])).toThrow();
    expect(() => cleanFaqs(Array.from({ length: 9 }, () => ({ q: 'q', a: 'a' })))).toThrow();
    expect(() => cleanFaqs([{ q: 'x'.repeat(151), a: 'a' }])).toThrow();
    expect(() => cleanFaqs([{ q: 'q', a: 'x'.repeat(501) }])).toThrow();
    expect(() => cleanFaqs('x')).toThrow();
    expect(cleanFaqs(null)).toEqual([]);
  });
  it('shipping note: max 500, clears on empty', () => {
    expect(cleanShippingNote('  We ship <i>Mon</i> ')).toBe('We ship Mon');
    expect(cleanShippingNote('')).toBeNull();
    expect(() => cleanShippingNote('x'.repeat(501))).toThrow();
  });
});
