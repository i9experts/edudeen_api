import { buildOnboardingChecklist, storePageDetails } from './onboarding-checklist.util';

describe('buildOnboardingChecklist', () => {
  const base = { hasLogo: false, hasBanner: false, hasPayoutOrBank: false, productCount: 0, physicalProductCount: 0, shippingConfigured: false, pageDetails: { done: 0, total: 4 } };

  it('empty store: only shipping is auto-done; total is always 6', () => {
    const r = buildOnboardingChecklist(base);
    expect(r.total).toBe(6);
    expect(r.completed).toBe(1);
    expect(r.steps.find((s) => s.key === 'shipping')?.notNeeded).toBe(true);
    expect(r.steps.find((s) => s.key === 'store_page')?.label).toBe('Store page 0/4');
    expect(r.allDone).toBe(false);
  });

  it('total does not change with physical products', () => {
    expect(buildOnboardingChecklist({ ...base, productCount: 2, physicalProductCount: 2 }).total).toBe(6);
  });

  it('physical products need shipping set up', () => {
    const r = buildOnboardingChecklist({ ...base, productCount: 2, physicalProductCount: 2 });
    expect(r.steps.find((s) => s.key === 'shipping')?.done).toBe(false);
    const r2 = buildOnboardingChecklist({ ...base, productCount: 2, physicalProductCount: 2, shippingConfigured: true });
    expect(r2.steps.find((s) => s.key === 'shipping')?.done).toBe(true);
  });

  it('fully set up store is 100%', () => {
    const r = buildOnboardingChecklist({ hasLogo: true, hasBanner: true, hasPayoutOrBank: true, productCount: 1, physicalProductCount: 0, shippingConfigured: false, pageDetails: { done: 4, total: 4 } });
    expect(r.percent).toBe(100);
    expect(r.allDone).toBe(true);
  });
});

describe('storePageDetails', () => {
  it('counts tagline, 80+ description, 3 FAQs, teaching profile', () => {
    expect(storePageDetails({})).toEqual({ done: 0, total: 4 });
    expect(storePageDetails({
      tagline: 'x', description: 'a'.repeat(80), subjects: ['Math'],
      faqs: [{ q: '1', a: '1' }, { q: '2', a: '2' }, { q: '3', a: '3' }],
    })).toEqual({ done: 4, total: 4 });
  });
});
