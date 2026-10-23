import { DENY, PERMISSION_KEYS, permissionForRequest } from './permissions';

describe('staff rights for exports, pending counts and held FX rates', () => {
  it('every export path needs its own export right - the module view right is not enough', () => {
    expect(permissionForRequest('GET', '/api/admin/exports/users')).toBe('users.export');
    expect(permissionForRequest('GET', '/api/admin/exports/orders')).toBe('orders.export');
    expect(permissionForRequest('GET', '/api/admin/exports/listings')).toBe('marketplace.export');
    expect(permissionForRequest('GET', '/api/admin/exports/payment-proofs')).toBe('payments.export');
    expect(permissionForRequest('GET', '/api/admin/activity-log/export')).toBe('activity.export');
    // the plain list keeps the view right
    expect(permissionForRequest('GET', '/api/admin/activity-log')).toBe('activity.view');
  });

  it('case / slash tricks on export paths do not slip past', () => {
    expect(permissionForRequest('GET', '/API/Admin/Exports/Users/')).toBe('users.export');
    expect(permissionForRequest('GET', '//api/admin/exports/../exports/orders')).toBe('orders.export');
  });

  it('an unknown export path is denied for staff', () => {
    expect(permissionForRequest('GET', '/api/admin/exports/secrets')).toBe(DENY);
    expect(permissionForRequest('GET', '/api/admin/exports')).toBe(DENY);
  });

  it('export rights exist in the catalogue (grantable by the owner)', () => {
    for (const k of ['users.export', 'orders.export', 'marketplace.export', 'payments.export', 'activity.export']) expect(PERMISSION_KEYS.has(k)).toBe(true);
  });

  it('pending-counts is readable by any staff member but never writable', () => {
    expect(permissionForRequest('GET', '/api/admin/pending-counts')).toBeNull();
    expect(permissionForRequest('POST', '/api/admin/pending-counts')).toBe(DENY);
  });

  it('held FX rates have no staff rule: owner only (default deny)', () => {
    expect(permissionForRequest('GET', '/api/admin/fx/held')).toBe(DENY);
    expect(permissionForRequest('POST', '/api/admin/fx/held/abc/confirm')).toBe(DENY);
  });
});
