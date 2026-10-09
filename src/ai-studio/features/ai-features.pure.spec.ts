/* eslint-disable prettier/prettier */
import { buildProductFilter, normalizeFilters } from './catalog.service';
import { fallbackFilters, RewriteCache } from './smart-search.service';
import { normalizeModeration } from './moderation-ai.service';
import { computeCodRisk, CodSignals } from './cod-risk.service';
import { summaryIsStale } from './reviews-ai.service';
import { pctChange } from './insights.service';
import { clampNum, AskDataService, ASK_TOOLS } from './ask-data.service';
import { rankFaqs } from './help-bot.service';
import { buildCoverSvg, normalizeCover, renderWorksheetHtml } from './studio-extras.service';
import { detectDirection } from './translate.service';
import { AssistantService, sanitizeHistory } from './assistant.service';
import { evaluateReceipt } from '../../manual-payments/receipt-check.service';

describe('A1 smart search logic', () => {
  it('normalizes model filters strictly (drops unknown enums, bounds numbers)', () => {
    const f = normalizeFilters({ keywords: ['Urdu', ' qaida ', 'x', 42], educationLevel: 'galaxy', productType: 'digital', curricula: ['punjab', 'mars'], age: 200, maxPrice: 500, minPrice: 1000, sort: 'rating' });
    expect(f.keywords).toEqual(['urdu', 'qaida', '42']);
    expect(f.educationLevel).toBeUndefined();
    expect(f.productType).toBe('digital');
    expect(f.curricula).toEqual(['punjab']);
    expect(f.age).toBeUndefined();
    expect(f.maxPrice).toBeUndefined(); // max < min is dropped
    expect(f.sort).toBe('rating');
  });
  it('builds an escaped, active-stores-only mongo filter', () => {
    const q = buildProductFilter({ keywords: ['c++'], age: 8, curricula: ['punjab'] }, ['s1'], ['cat1']);
    expect(q.status).toBe('active');
    expect(q.storeId).toEqual({ $in: ['s1'] });
    expect(String(q.$or[0].name)).toContain('c\\+\\+');
    expect(q.$or.some((c: any) => c.categoryId)).toBe(true);
    expect(q.$and).toHaveLength(2);
    expect(q.curricula).toEqual({ $in: ['punjab'] });
  });
  it('falls back to plain keywords and caches rewrites', () => {
    expect(fallbackFilters('class 5 ki Urdu kitab').keywords).toEqual(['urdu', 'kitab']);
    let t = 0; const c = new RewriteCache(2, 1000, () => t);
    c.set('Urdu  Book', { keywords: ['urdu'] });
    expect(c.get('urdu book')).toEqual({ keywords: ['urdu'] });
    t = 2000; expect(c.get('urdu book')).toBeNull();
  });
});

describe('A4 moderation normalizer', () => {
  it('never lets approve stand against risk flags and forces reject for unsuitable', () => {
    expect(normalizeModeration({ islamicSuitability: 'unsuitable', ageSuitability: 'all_ages', copyrightRisk: 'low', qualityIssues: [], suggestedDecision: 'approve', reasons: ['x'] }).suggestedDecision).toBe('reject');
    expect(normalizeModeration({ islamicSuitability: 'suitable', ageSuitability: 'all_ages', copyrightRisk: 'high', qualityIssues: [], suggestedDecision: 'approve', reasons: [] }).suggestedDecision).toBe('needs_changes');
    const ok = normalizeModeration({ islamicSuitability: 'suitable', ageSuitability: 'all_ages', copyrightRisk: 'low', qualityIssues: [], suggestedDecision: 'approve', reasons: ['fine'] });
    expect(ok.suggestedDecision).toBe('approve');
    const junk = normalizeModeration({ islamicSuitability: 'zzz', qualityIssues: 'nope' });
    expect(junk).toMatchObject({ islamicSuitability: 'needs_review', ageSuitability: 'unclear', copyrightRisk: 'medium', suggestedDecision: 'needs_changes', qualityIssues: [] });
  });
});

describe('A6 COD risk score', () => {
  const base: CodSignals = { isCod: true, accountAgeDays: 100, priorOrders: 5, priorCancelled: 0, priorReturned: 0, orderTotal: 1500, avgOrderTotal: 1400, hasPhone: true, addressComplete: true, itemCount: 2, hasPhysicalItems: true, ordersLast24h: 1 };
  it('is zero for prepaid and low for a loyal buyer', () => {
    expect(computeCodRisk({ ...base, isCod: false }).score).toBe(0);
    expect(computeCodRisk(base).level).toBe('low');
  });
  it('is high for a new account, first order, no phone, large value', () => {
    const r = computeCodRisk({ ...base, accountAgeDays: 0, priorOrders: 0, hasPhone: false, orderTotal: 20000, avgOrderTotal: null });
    expect(r.level).toBe('high');
    expect(r.factors.map((f) => f.code)).toEqual(expect.arrayContaining(['new_account', 'first_order', 'no_phone', 'high_value']));
    expect(r.score).toBeLessThanOrEqual(100);
  });
  it('penalises a bad history', () => {
    expect(computeCodRisk({ ...base, priorOrders: 4, priorCancelled: 3 }).factors.map((f) => f.code)).toContain('bad_history');
  });
});

describe('A5 receipt evaluation', () => {
  const now = new Date('2026-10-09');
  it('matches a clean receipt', () => {
    const r = evaluateReceipt({ isReceipt: true, amount: 1500, reference: 'T123', payee: 'Ali 03001234567', date: '2026-10-08', looksEdited: false }, 1500, { accountHint: '4567', reference: 'T123' }, now);
    expect(r.status).toBe('match'); expect(r.flags).toEqual([]);
  });
  it('flags amount, old date, payee, reference and edits', () => {
    const r = evaluateReceipt({ isReceipt: true, amount: 900, reference: 'T999', payee: '****1111', date: '2026-09-01', looksEdited: true }, 1500, { accountHint: '4567', reference: 'T123' }, now);
    expect(r.status).toBe('mismatch');
    expect(r.flags).toEqual(expect.arrayContaining(['amount_mismatch', 'old_receipt', 'payee_mismatch', 'reference_mismatch', 'edited_looking']));
  });
  it('handles not-a-receipt and unreadable amount', () => {
    expect(evaluateReceipt({ isReceipt: false }, 100, {}, now).flags).toEqual(['not_a_receipt']);
    expect(evaluateReceipt({ isReceipt: true, amount: null }, 100, {}, now).status).toBe('unreadable');
  });
});

describe('A7/A8/A9/A10/A13 pure logic', () => {
  it('review summary staleness (>=3 reviews, refresh after +3 or 7 days)', () => {
    expect(summaryIsStale(null, 2)).toBe(false);
    expect(summaryIsStale(null, 3)).toBe(true);
    const at = new Date().toISOString();
    expect(summaryIsStale({ basedOn: 5, at }, 6)).toBe(false);
    expect(summaryIsStale({ basedOn: 5, at }, 8)).toBe(true);
    expect(summaryIsStale({ basedOn: 5, at: new Date(Date.now() - 8 * 86400000).toISOString() }, 5)).toBe(true);
  });
  it('pctChange guards zero baseline', () => {
    expect(pctChange(150, 100)).toBe(50); expect(pctChange(0, 0)).toBe(0); expect(pctChange(10, 0)).toBeNull();
  });
  it('ask-data clamps params and only exposes whitelisted tools', async () => {
    expect(clampNum(9999, 1, 365, 30)).toBe(365); expect(clampNum('x', 1, 365, 30)).toBe(30);
    expect(ASK_TOOLS.map((t) => t.name).sort()).toEqual(['ai_usage', 'listing_status_counts', 'new_users', 'orders_summary', 'review_stats', 'top_products', 'top_stores']);
    const svc = new AskDataService({ repositories: {} } as any, {} as any);
    await expect(svc.runTool('drop_database', {})).rejects.toThrow('unknown tool');
  });
  it('help-bot ranks FAQ entries by overlap and returns none when unrelated', () => {
    const faqs = [{ question: 'How do I request a payout?', answer: 'Go to Finance and add a payout method.' }, { question: 'How to add a product', answer: 'Open Products then Add.' }];
    expect(rankFaqs('how can i get my payout', faqs)[0].question).toContain('payout');
    expect(rankFaqs('zzz qqq', faqs)).toEqual([]);
  });
  it('cover svg escapes text and wraps; worksheet html escapes and adds key', () => {
    const spec = normalizeCover({ headline: 'Grade 5 <script>alert(1)</script> Urdu Qaida Practice Book', subtitle: 'A & B', badge: 'Grade 5', theme: 'bogus' }, 'T');
    const svg = buildCoverSvg(spec);
    expect(spec.theme).toBe('royal'); expect(svg).not.toContain('<script>'); expect(svg).toContain('<svg');
    const html = renderWorksheetHtml({ title: 'Fractions <b>', sections: [{ instructions: 'Answer all', questions: [{ prompt: '1/2 + 1/2?', type: 'multiple_choice', choices: ['1', '2'], answer: 'A' }] }] }, { includeAnswers: true });
    expect(html).toContain('Fractions &lt;b&gt;'); expect(html).toContain('Answer key');
    expect(renderWorksheetHtml({ title: 'x', sections: [] })).not.toContain('Answer key');
  });
  it('translation direction detection', () => {
    expect(detectDirection('Maths Worksheet')).toBe('en_to_ur');
    expect(detectDirection('اردو قاعدہ')).toBe('ur_to_en');
  });
});

describe('A2 assistant never invents data', () => {
  it('sanitizes history', () => {
    const h = sanitizeHistory([{ role: 'system', content: 'x' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: '  hello  ' }, { role: 'user', content: 5 }]);
    expect(h).toEqual([{ role: 'user', content: 'hello' }]);
  });
  it('binds order tools to the signed-in buyer and returns only real product cards', async () => {
    const find = jest.fn(() => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [{ orderNumber: 'ED-1', orderStatus: 'pending', paymentStatus: 'unpaid', paymentType: 'cash_on_delivery', totalAmount: 10, currency: 'PKR', createdAt: new Date(), sellerOrders: [] }] }) }) }) }));
    const db: any = { repositories: { orderModel: { find } } };
    const catalog: any = { search: jest.fn(async () => [{ id: 'p1', slug: 's', name: 'Real Book', nameUr: null, image: null, price: 5, currency: 'PKR', rating: 4, ratingCount: 3, productType: 'digital', educationLevel: null, url: '/product/s' }]), getOne: jest.fn() };
    // Fake AiService: the "model" calls search_products then get_my_orders(userId attempt) then answers.
    const ai: any = {
      runToolLoop: async (_req: any, exec: any) => {
        await exec('search_products', { keywords: ['book'] });
        const orders = await exec('get_my_orders', { userId: 'someone-else' });
        return { text: `Found. ${JSON.stringify(orders).length}`, toolResults: [], usage: {}, costUsd: 0 };
      },
    };
    const svc = new AssistantService(db, ai, catalog);
    const res: any = await svc.chat('buyer-1', [{ role: 'user', content: 'show me a book and my orders' }]);
    expect(res.data.products.map((p: any) => p.name)).toEqual(['Real Book']);
    expect((find.mock.calls[0] as any[])[0]).toEqual({ userId: 'buyer-1' }); // model-supplied userId ignored

    const guest: any = await new AssistantService(db, { runToolLoop: async (_r: any, exec: any) => ({ text: JSON.stringify(await exec('get_my_orders', {})), toolResults: [], usage: {}, costUsd: 0 }) } as any, catalog).chat(null, [{ role: 'user', content: 'orders?' }]);
    expect(guest.data.reply).toContain('login_required');
  });
});
