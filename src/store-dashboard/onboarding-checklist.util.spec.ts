import { buildOnboardingChecklist } from './onboarding-checklist.util';

describe('buildOnboardingChecklist', () => {
  const base = { hasLogo: false, hasBanner: false, hasPayoutOrBank: false, productCount: 0, physicalProductCount: 0, activeShippingZones: 0 };

  it('empty store: only shipping is auto-done (digital-only/no products)', () => {
    const r = buildOnboardingChecklist(base);
    expect(r.completed).toBe(1);
    expect(r.percent).toBe(20);
    expect(r.steps.find((s) => s.key === 'shipping')?.notNeeded).toBe(true);
    expect(r.allDone).toBe(false);
  });

  it('physical products need an active zone', () => {
    const r = buildOnboardingChecklist({ ...base, productCount: 2, physicalProductCount: 2 });
    expect(r.steps.find((s) => s.key === 'shipping')?.done).toBe(false);
    const r2 = buildOnboardingChecklist({ ...base, productCount: 2, physicalProductCount: 2, activeShippingZones: 3 });
    expect(r2.steps.find((s) => s.key === 'shipping')?.done).toBe(true);
  });

  it('fully set up store is 100%', () => {
    const r = buildOnboardingChecklist({ hasLogo: true, hasBanner: true, hasPayoutOrBank: true, productCount: 1, physicalProductCount: 0, activeShippingZones: 0 });
    expect(r.percent).toBe(100);
    expect(r.allDone).toBe(true);
  });
});
