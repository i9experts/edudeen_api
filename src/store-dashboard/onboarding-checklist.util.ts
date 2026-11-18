/** Seller onboarding checklist: pure logic, computed from real store data. The ONLY place the step total comes from. */
export interface ChecklistInput {
  hasLogo: boolean;
  hasBanner: boolean;
  hasPayoutOrBank: boolean;
  /** Published (live) products. */
  productCount: number;
  physicalProductCount: number;
  /** The seller's own Shipping setup exists (delivery method, own delivery, or a ship-from city) - the same rule as the web Shipping page. */
  shippingConfigured: boolean;
  /** Store-page details beyond logo and banner (tagline, description, FAQs, teaching profile). */
  pageDetails: { done: number; total: number };
}

export interface ChecklistStep {
  key: 'logo' | 'banner' | 'payout' | 'first_product' | 'store_page' | 'shipping';
  label: string;
  done: boolean;
  /** Counts as done because it does not apply (e.g. no physical products). */
  notNeeded?: boolean;
  /** Grouped step progress, e.g. 2/4. */
  progress?: { done: number; total: number };
  /** Web path relative to /store/:storeId/ */
  path: string;
}

export interface ChecklistResult {
  steps: ChecklistStep[];
  completed: number;
  total: number;
  percent: number;
  allDone: boolean;
}

export const DESCRIPTION_MIN_CHARS = 80;
export const FAQ_MIN = 3;

/** Same four checks as the web store-page meter (minus logo/banner, which are their own steps). */
export function storePageDetails(s: {
  tagline?: string | null; description?: string | null; faqs?: { q?: string; a?: string }[] | null;
  educatorProfile?: { headline?: string | null; qualifications?: unknown[]; subjects?: unknown[]; institutions?: unknown[] } | null;
  gradesServed?: unknown[] | null; subjects?: unknown[] | null; teachingLanguages?: unknown[] | null;
}): { done: number; total: number } {
  const ep = s.educatorProfile;
  const teacher = !!(ep && (ep.headline?.trim() || ep.qualifications?.length || ep.subjects?.length || ep.institutions?.length))
    || !!(s.gradesServed?.length || s.subjects?.length || s.teachingLanguages?.length);
  const faqCount = (s.faqs ?? []).filter((f) => f?.q?.trim() && f?.a?.trim()).length;
  const checks = [
    !!s.tagline?.trim(),
    (s.description ?? '').trim().length >= DESCRIPTION_MIN_CHARS,
    faqCount >= FAQ_MIN,
    teacher,
  ];
  return { done: checks.filter(Boolean).length, total: checks.length };
}

export function buildOnboardingChecklist(i: ChecklistInput): ChecklistResult {
  const shippingNotNeeded = i.physicalProductCount === 0;
  const steps: ChecklistStep[] = [
    { key: 'logo', label: 'Add your store logo', done: i.hasLogo, path: 'settings' },
    { key: 'banner', label: 'Add a store banner', done: i.hasBanner, path: 'store-builder' },
    { key: 'payout', label: 'Set up payout or bank-transfer details', done: i.hasPayoutOrBank, path: 'finance' },
    { key: 'first_product', label: 'Publish your first product', done: i.productCount > 0, path: 'products/add' },
    {
      key: 'store_page',
      label: `Store page ${i.pageDetails.done}/${i.pageDetails.total}`,
      done: i.pageDetails.done === i.pageDetails.total,
      progress: i.pageDetails,
      path: 'storebuilder',
    },
    {
      key: 'shipping',
      label: 'Review delivery options',
      done: shippingNotNeeded || i.shippingConfigured,
      notNeeded: shippingNotNeeded,
      path: 'shipping',
    },
  ];
  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  return { steps, completed, total, percent: Math.round((completed / total) * 100), allDone: completed === total };
}
