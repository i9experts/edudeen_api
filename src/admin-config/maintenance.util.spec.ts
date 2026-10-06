import { blockedByMaintenance, areaOfRequest, maintenanceState, normalizeMaintenance } from './maintenance.util';

const on = (over: any = {}) => normalizeMaintenance({ enabled: true, scopes: ['all'], ...over });

describe('maintenance mode', () => {
  it('is off by default and for the legacy flag only when true', () => {
    expect(maintenanceState(normalizeMaintenance(null))).toBe('off');
    expect(maintenanceState(normalizeMaintenance(null, true))).toBe('active');
  });

  it('a future start is scheduled (banner only) and blocks nothing yet', () => {
    const m = on({ startsAt: new Date(Date.now() + 3600_000) });
    expect(maintenanceState(m)).toBe('scheduled');
    expect(blockedByMaintenance(m, 'GET', '/api/products/products-by-category')).toBe(false);
  });

  it('whole-platform maintenance blocks buyer, seller and checkout routes but never admin, auth, config or webhooks', () => {
    const m = on();
    expect(blockedByMaintenance(m, 'GET', '/api/products/products-by-category')).toBe(true);
    expect(blockedByMaintenance(m, 'POST', '/api/checkout/create-checkout')).toBe(true);
    expect(blockedByMaintenance(m, 'GET', '/api/finance/abc/payout-methods')).toBe(true);
    for (const p of ['/api/admin/platform-config', '/api/auth/login', '/api/platform-config/maintenance', '/api/payment/stripe/webhook']) {
      expect(blockedByMaintenance(m, 'POST', p)).toBe(false);
    }
  });

  it('a scoped maintenance blocks only that area', () => {
    const m = on({ scopes: ['checkout'] });
    expect(blockedByMaintenance(m, 'POST', '/api/payment/initiate')).toBe(true);
    expect(blockedByMaintenance(m, 'GET', '/api/products/products-by-category')).toBe(false);
    expect(blockedByMaintenance(m, 'GET', '/api/finance/abc/dashboard')).toBe(false);
  });

  it('seller scope covers store management writes but not public store reads', () => {
    const m = on({ scopes: ['seller'] });
    expect(areaOfRequest('GET', '/api/store/getStoreById/1')).toBe('buyer');
    expect(blockedByMaintenance(m, 'GET', '/api/store/getStoreById/1')).toBe(false);
    expect(blockedByMaintenance(m, 'POST', '/api/products/add-digital-product')).toBe(true);
  });
});
