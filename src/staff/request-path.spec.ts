import { normalizeRequestPath } from '../common/request-path.util';
import { DENY, permissionForRequest } from './permissions';
import { approvalRouteFor } from './approvals';
import { createStaffAccessMiddleware } from './staff-access.middleware';
import { blockingScope, normalizeMaintenance } from '../admin-config/maintenance.util';

describe('normalizeRequestPath', () => {
  it('canonicalises case, slashes, dots and encoding', () => {
    expect(normalizeRequestPath('/API/Admin/Users/')).toBe('/api/admin/users');
    expect(normalizeRequestPath('//api//admin//x')).toBe('/api/admin/x');
    expect(normalizeRequestPath('/api/%61dmin/%2e/x')).toBe('/api/admin/x');
    expect(normalizeRequestPath('/api/admin/%2e%2e/auth')).toBe('/api/auth');
  });
  it('rejects bad encoding', () => {
    expect(normalizeRequestPath('/api/%E0%A4%A')).toBeNull();
  });
});

describe('staff permission decisions are path-spelling independent', () => {
  const same = (method: string, paths: string[], expected: string | null) =>
    paths.forEach((p) => expect(permissionForRequest(method, p)).toBe(expected));

  it('admin users', () => same('PATCH', ['/api/admin/users/1', '/API/admin/users/1', '/Api/Admin/Users/1/', '//api//admin//users//1', '/api/admin/%75sers/1'], 'users.manage'));
  it('create-admin', () => same('POST', ['/api/auth/admin/create-admin', '/Api/auth/admin/create-admin', '/api/Auth/Admin/Create-Admin/'], 'staff.manage'));
  it('payout approve', () => same('PATCH', ['/api/admin/finance/payouts/ID/approve', '/api/admin/finance/payouts/ID/approve/', '/API/ADMIN/FINANCE/PAYOUTS/ID/APPROVE'], 'finance.payouts'));
  it('spotlight alias = banners', () => {
    same('POST', ['/api/spotlight', '/api/banners', '/API/Spotlight/'], 'content.manage');
    same('GET', ['/api/spotlight/admin/all', '/api/banners/admin/all'], 'content.view');
  });
  it('unmapped admin route stays denied, normal public read allowed', () => {
    same('GET', ['/api/admin/unknown', '/API/ADMIN/unknown/'], DENY);
    same('GET', ['/api/products/x', '/API/products/x'], null);
  });
  it('malformed encoding is denied', () => expect(permissionForRequest('GET', '/api/%E0%A4%A')).toBe(DENY));

  it('approval gate matches every spelling', () => {
    for (const p of ['/api/admin/finance/payouts/ID/approve', '/api/admin/finance/payouts/ID/approve/', '/API/admin/finance/payouts/ID/Approve', '//api//admin//finance//payouts//ID//approve'])
      expect(approvalRouteFor('PATCH', p)?.key).toBe('payout');
    expect(approvalRouteFor('PATCH', '/api/admin/finance/payouts/ID/other')).toBeNull();
  });
});

describe('staff middleware', () => {
  const run = async (path: string) => {
    const staff: any = {
      verifyToken: () => ({ sub: 'a1', role: 'admin', typ: 'access', tokenVersion: 1 }),
      accessFor: async () => ({ isStaff: true, name: 'S', tokenVersion: 1, blocked: null, permissions: new Set<string>(), }),
      audit: jest.fn(),
    };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), on: jest.fn() };
    const next = jest.fn();
    await createStaffAccessMiddleware(staff)({ headers: { authorization: 'Bearer t' }, path, method: 'POST', ip: '1.1.1.1' }, res, next);
    return { status: res.status.mock.calls[0]?.[0], next: next.mock.calls.length };
  };
  it.each(['/api/admin/users', '/API/admin/users', '/Api/auth/admin/create-admin', '//api//admin//x', '/api/admin/finance/payouts/ID/approve/'])('%s is refused for staff without rights', async (p) => {
    expect(await run(p)).toEqual({ status: 403, next: 0 });
  });
  it('bad encoding -> 400', async () => expect((await run('/api/%E0%A4%A')).status).toBe(400));
  it('non-api path passes', async () => expect((await run('/robots.txt')).next).toBe(1));
});

describe('maintenance path matching', () => {
  const m = normalizeMaintenance({ enabled: true, scopes: ['checkout', 'feature:cart'] });
  it('checkout blocked in any spelling', () => {
    for (const p of ['/api/checkout/x', '/API/checkout', '/Api/Checkout/', '//api//checkout//x']) expect(blockingScope(m, 'POST', p)).toBe('checkout');
  });
  it('feature scope + exempt admin in any spelling', () => {
    expect(blockingScope(m, 'GET', '/API/Cart')).toBe('feature:cart');
    expect(blockingScope(m, 'GET', '/API/Admin/x')).toBeNull();
  });
});
