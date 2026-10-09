/** Seller onboarding checklist: pure logic, computed from real store data. */
export interface ChecklistInput {
  hasLogo: boolean;
  hasBanner: boolean;
  hasPayoutOrBank: boolean;
  productCount: number;
  physicalProductCount: number;
  activeShippingZones: number;
}

export interface ChecklistStep {
  key: 'logo' | 'banner' | 'payout' | 'first_product' | 'shipping';
  label: string;
  done: boolean;
  /** Counts as done because it does not apply (e.g. no physical products). */
  notNeeded?: boolean;
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

export function buildOnboardingChecklist(i: ChecklistInput): ChecklistResult {
  const shippingNotNeeded = i.physicalProductCount === 0;
  const steps: ChecklistStep[] = [
    { key: 'logo', label: 'Add your store logo', done: i.hasLogo, path: 'settings' },
    { key: 'banner', label: 'Add a store banner', done: i.hasBanner, path: 'store-builder' },
    { key: 'payout', label: 'Set up payout or bank-transfer details', done: i.hasPayoutOrBank, path: 'finance' },
    { key: 'first_product', label: 'Publish your first product', done: i.productCount > 0, path: 'products/add' },
    {
      key: 'shipping',
      label: 'Review delivery options',
      done: shippingNotNeeded || i.activeShippingZones > 0,
      notNeeded: shippingNotNeeded,
      path: 'shipping',
    },
  ];
  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  return { steps, completed, total, percent: Math.round((completed / total) * 100), allDone: completed === total };
}
