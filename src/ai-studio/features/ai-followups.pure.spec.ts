import { HttpException } from '@nestjs/common';
import { AiStudioService } from '../ai-studio.service';
import { SmartSearchService } from './smart-search.service';
import { isoWeekKey, WeeklyDigestService } from './weekly-digest.service';
import { hasUrdu, normalizeQuiz, normalizeSheet, renderSheetPdf, toWinAnsi } from './quiz.service';
import { renderWorksheetHtml } from './studio-extras.service';
import { buildCloudinaryEnhanceUrl, CloudinaryImageEnhanceProvider } from '../providers/image-enhance.service';
import { buildReceiptExpectation } from '../../manual-payments/receipt-check.service';

describe('quiz normalisation', () => {
  const raw = {
    title: '<b>Fractions</b> quiz',
    sections: [
      { instructions: 'Pick one', questions: [
        { type: 'multiple_choice', prompt: '1/2 + 1/2 = ?', choices: ['1', '2', '3'], answer: '1', explanation: 'Whole' },
        { type: 'mcq', prompt: 'broken mcq', choices: ['only one'], answer: 'x' },
        { type: 'true_false', prompt: '1/2 is a fraction', answer: 'True' },
        { prompt: '' },
      ] },
      { questions: [] },
    ],
  };
  it('cleans markup, downgrades an mcq with <2 choices, drops empties', () => {
    const q = normalizeQuiz(raw, 'en', 'Grade 5');
    expect(q.title).toBe('Fractions quiz');
    expect(q.sections).toHaveLength(1);
    expect(q.sections[0].questions.map((x) => x.type)).toEqual(['multiple_choice', 'short_answer', 'true_false']);
    expect(q.grade).toBe('Grade 5');
  });
  it('rejects content with no questions', () => {
    expect(() => normalizeSheet({ title: 't', sections: [{ questions: [] }] })).toThrow();
    expect(() => normalizeSheet(null)).toThrow();
  });
  it('caps the number of questions', () => {
    const many = { title: 't', sections: [{ questions: Array.from({ length: 80 }, (_, i) => ({ type: 'short_answer', prompt: `q${i}` })) }] };
    expect(normalizeSheet(many).sections[0].questions.length).toBe(40);
  });
  it('the printable HTML renders the quiz and escapes html in questions', () => {
    const q = normalizeQuiz({ title: 'T', sections: [{ questions: [{ type: 'short_answer', prompt: '<script>x</script>2+2', answer: '4' }] }] }, 'en');
    const html = renderWorksheetHtml(q as any, { includeAnswers: true });
    expect(html).toContain('Answer key');
    expect(html).not.toContain('<script>');
  });
});

describe('sheet PDF', () => {
  it('produces a real PDF for English content (and handles curly quotes / long words)', async () => {
    const sheet = normalizeQuiz({ title: 'Science – “Cells”', sections: [{ instructions: 'Answer all', questions: [
      { type: 'multiple_choice', prompt: 'The powerhouse of the cell is the?', choices: ['Nucleus', 'Mitochondria', 'Ribosome'], answer: 'Mitochondria' },
      { type: 'short_answer', prompt: 'x'.repeat(300), answer: 'n/a' },
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'true_false', prompt: `Statement ${i}`, answer: 'True' })),
    ] }] }, 'en');
    const bytes = await renderSheetPdf(sheet, { includeAnswers: true });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1500);
  });
  it('refuses Urdu with a 422 and a clear code', async () => {
    const sheet = normalizeQuiz({ title: 'ریاضی', sections: [{ questions: [{ type: 'short_answer', prompt: 'دو جمع دو؟', answer: 'چار' }] }] }, 'ur');
    expect(hasUrdu(JSON.stringify(sheet))).toBe(true);
    const err: any = await renderSheetPdf(sheet).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse().errorCode).toBe('PDF_URDU_UNSUPPORTED');
  });
  it('toWinAnsi maps punctuation and never leaves unsupported characters', () => {
    expect(toWinAnsi('“hi” — ok…')).toBe('"hi" - ok...');
    expect(toWinAnsi('aمb')).toBe('a?b');
  });
});

describe('Cloudinary image enhancer', () => {
  const url = 'https://res.cloudinary.com/mycloud/image/upload/v123/products/a.jpg';
  it('builds the transformation URL only for our own Cloudinary uploads', () => {
    expect(buildCloudinaryEnhanceUrl(url, 'upscale', 'mycloud')).toBe('https://res.cloudinary.com/mycloud/image/upload/e_upscale/v123/products/a.jpg');
    expect(buildCloudinaryEnhanceUrl(url, 'background_cleanup', 'mycloud')).toContain('e_background_removal');
    expect(buildCloudinaryEnhanceUrl(url, 'denoise', 'mycloud')).toContain('e_improve');
    expect(buildCloudinaryEnhanceUrl(url, 'upscale', 'other')).toBeNull();
    expect(buildCloudinaryEnhanceUrl('https://evil.example.com/mycloud/image/upload/a.jpg', 'upscale', 'mycloud')).toBeNull();
    expect(buildCloudinaryEnhanceUrl('http://res.cloudinary.com/mycloud/image/upload/a.jpg', 'upscale', 'mycloud')).toBeNull();
    expect(buildCloudinaryEnhanceUrl('not a url', 'upscale', 'mycloud')).toBeNull();
  });
  it('waits while Cloudinary answers 423, then succeeds; surfaces a disabled add-on cleanly', async () => {
    const statuses = [423, 423, 200];
    const p = new CloudinaryImageEnhanceProvider('mycloud', async () => ({ status: statuses.shift() ?? 200, ok: true }), async () => undefined);
    const r = await p.enhance({ imageUrl: url, enhancementType: 'upscale' });
    expect(r.provider).toBe('cloudinary');
    expect(r.enhancedImageUrl).toContain('e_upscale');
    const off = new CloudinaryImageEnhanceProvider('mycloud', async () => ({ status: 400, ok: false }), async () => undefined);
    await expect(off.enhance({ imageUrl: url, enhancementType: 'background_cleanup' })).rejects.toMatchObject({ retryable: false });
    await expect(p.enhance({ imageUrl: 'https://example.com/a.jpg', enhancementType: 'upscale' })).rejects.toMatchObject({ retryable: false });
  });
});

describe('weekly digest', () => {
  it('isoWeekKey follows ISO weeks (Monday start, year boundaries)', () => {
    expect(isoWeekKey(new Date('2026-10-09T10:00:00Z'))).toBe('2026-W41');
    expect(isoWeekKey(new Date('2026-10-05T00:15:00Z'))).toBe('2026-W41'); // Monday
    expect(isoWeekKey(new Date('2026-10-04T23:00:00Z'))).toBe('2026-W40'); // Sunday
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });

  function make(opts: { available?: boolean; settings: any[]; generate?: jest.Mock; feature?: boolean }) {
    const updates: any[] = [];
    const settings = {
      find: () => ({ limit: () => ({ lean: async () => opts.settings }) }),
      updateOne: jest.fn(async (...a: any[]) => { updates.push(a); }),
    };
    const store = { _id: 's1', name: 'Shop', status: 'active', sellerId: 'u1' };
    const db: any = { repositories: { storeModel: { findOne: () => ({ select: () => ({ lean: async () => store }) }) } } };
    const ai: any = { isAvailable: () => opts.available !== false, isFeatureOn: async () => opts.feature !== false, credits: { costOf: () => 5 } };
    const insights: any = { generate: opts.generate ?? jest.fn(async () => ({})) };
    const notify = jest.fn(async () => undefined);
    const svc = new WeeklyDigestService(db, ai, insights, { notify } as any, settings as any);
    return { svc, insights, notify, updates };
  }
  const row = { storeId: 's1', sellerId: 'u1', weeklyDigestEnabled: true, weeklyDigestSkipNotified: false };

  it('does nothing (no debit, no AI) when AI is not configured', async () => {
    const t = make({ available: false, settings: [row] });
    const r = await t.svc.runDue();
    expect(r.considered).toBe(0);
    expect(t.insights.generate).not.toHaveBeenCalled();
  });
  it('generates for an opted-in store and notifies', async () => {
    const t = make({ settings: [row] });
    const r = await t.svc.runDue(new Date('2026-10-05T01:00:00Z'));
    expect(r.generated).toBe(1);
    expect(t.insights.generate).toHaveBeenCalledWith('u1', 's1');
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai_weekly_digest', recipientId: 'u1' }));
  });
  it('skips when credits are short and notifies only once', async () => {
    const no402 = jest.fn(async () => { throw new HttpException({ errorCode: 'INSUFFICIENT_AI_CREDITS' }, 402); });
    const first = make({ settings: [row], generate: no402 });
    expect((await first.svc.runDue()).skippedCredits).toBe(1);
    expect(first.notify).toHaveBeenCalledTimes(1);
    const again = make({ settings: [{ ...row, weeklyDigestSkipNotified: true }], generate: no402 });
    expect((await again.svc.runDue()).skippedCredits).toBe(1);
    expect(again.notify).not.toHaveBeenCalled();
  });
  it('respects the admin kill switch', async () => {
    const t = make({ settings: [row], feature: false });
    const r = await t.svc.runDue();
    expect(r.skippedOff).toBe(1);
    expect(t.insights.generate).not.toHaveBeenCalled();
  });
});

describe('hybrid smart search', () => {
  const card = (id: string) => ({ id, slug: id, name: id, nameUr: null, image: null, price: 1, currency: 'PKR', rating: 0, ratingCount: 0, productType: 'digital', educationLevel: null, url: `/product/${id}` });
  function make(semantic: any) {
    const catalog: any = { search: jest.fn(async () => [card('a'), card('b')]), cardsByIds: jest.fn(async (ids: string[]) => ids.map(card)) };
    const ai: any = { isAvailable: () => false };
    const flags: any = { isEnabled: async () => true };
    return { svc: new SmartSearchService(ai, flags, catalog, semantic), catalog };
  }
  it('keyword-only when embeddings are off', async () => {
    const { svc, catalog } = make({ isAvailable: () => false, rank: jest.fn() });
    const r: any = await svc.search('fractions', null);
    expect(r.data.usedSemantic).toBe(false);
    expect(r.data.products.map((p: any) => p.id)).toEqual(['a', 'b']);
    expect(catalog.cardsByIds).not.toHaveBeenCalled();
  });
  it('fuses keyword + semantic ranks and pulls in semantic-only products', async () => {
    const { svc, catalog } = make({ isAvailable: () => true, rank: jest.fn(async () => ['c', 'b']) });
    const r: any = await svc.search('how do shares of a pizza work', null);
    expect(r.data.usedSemantic).toBe(true);
    expect(r.data.products.map((p: any) => p.id)).toEqual(['b', 'a', 'c']);
    expect(catalog.cardsByIds).toHaveBeenCalledWith(['c'], expect.anything());
  });
  it('falls back to the keyword result when the semantic side returns nothing', async () => {
    const { svc } = make({ isAvailable: () => true, rank: jest.fn(async () => []) });
    const r: any = await svc.search('x y', null);
    expect(r.data.usedSemantic).toBe(false);
    expect(r.data.products).toHaveLength(2);
  });
});

describe('receipt expectation call-site helper', () => {
  it('is tolerant of a store with no direct payment details', () => {
    expect(buildReceiptExpectation(undefined, undefined)).toEqual({ accountHints: [undefined, undefined, undefined, undefined, undefined], reference: null });
  });
});

describe('legacy Studio on the mock provider', () => {
  function make(providerName: string) {
    const created: any = { _id: { toString: () => 'g1' }, sessionId: 's' };
    const generationModel: any = { create: jest.fn(async () => created), updateOne: jest.fn(async () => ({})), findOne: jest.fn() };
    const db: any = { repositories: { aiGenerationModel: generationModel, storeModel: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 's1', sellerId: 'u1' }) }) }), findById: () => ({ lean: async () => ({ _id: 's1', sellerId: 'u1' }) }) } } };
    const credits: any = { hold: jest.fn(async () => 't1'), capture: jest.fn(), refund: jest.fn(), costOf: () => 5 };
    const text: any = { name: providerName, providerName, generate: jest.fn(async () => ({ json: { title: 'T', description: 'D', suggestedTags: [] }, text: '', provider: providerName, model: 'm' })) };
    const svc: any = new AiStudioService(db, credits, text, {} as any, {} as any, { available: true } as any);
    jest.spyOn(svc, 'verifyStore').mockResolvedValue({ _id: 's1' });
    return { svc, credits, generationModel };
  }
  it('mock provider: no hold, no capture, zero charge, labelled as sample', async () => {
    const { svc, credits } = make('mock');
    const r = await svc.generateListing('u1', 's1', { productType: 'digital', keywords: ['math'] });
    expect(credits.hold).not.toHaveBeenCalled();
    expect(credits.capture).not.toHaveBeenCalled();
    expect(r.data.creditsCharged).toBe(0);
    expect(r.data.isSample).toBe(true);
    expect(r.data.sampleNotice).toMatch(/Sample output/);
  });
  it('real provider: still holds and captures the normal cost', async () => {
    const { svc, credits } = make('claude');
    const r = await svc.generateListing('u1', 's1', { productType: 'digital', keywords: ['math'] });
    expect(credits.hold).toHaveBeenCalledTimes(1);
    expect(credits.capture).toHaveBeenCalledWith('t1');
    expect(r.data.creditsCharged).toBe(5);
    expect(r.data.isSample).toBeUndefined();
  });
});