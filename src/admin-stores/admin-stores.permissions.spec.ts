/* eslint-disable prettier/prettier */
import { DENY, PERMISSIONS, permissionForRequest } from '../staff/permissions';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';

describe('stores.manage permission', () => {
  it('is in the catalog and marked sensitive', () => {
    expect(PERMISSIONS.find((p) => p.key === 'stores.manage')?.sensitive).toBe(true);
  });
  it('guards every /api/admin/stores route (reads and writes), also with odd casing', () => {
    expect(permissionForRequest('POST', '/api/admin/stores')).toBe('stores.manage');
    // Operating a store as the seller is its own right (the service also checks the store is assigned).
    expect(permissionForRequest('POST', '/api/admin/stores/abc/manage-session')).toBe('stores.operate');
    expect(permissionForRequest('GET', '/api/admin/stores')).toBe('stores.manage');
    expect(permissionForRequest('POST', '/api/admin/stores/abc/other')).not.toBe(DENY);
  });
});

describe('JwtStrategy actAs claims', () => {
  const s = new JwtStrategy({ get: () => 'secret' } as any);
  it('passes the manage-session claims through', async () => {
    const u: any = await s.validate({ sub: 's1', role: 'seller', typ: 'access', actAs: 'admin', storeId: 'st1', actAsAdminId: 'a1', tokenVersion: 2 });
    expect(u).toMatchObject({ role: 'seller', actAs: 'admin', storeId: 'st1', actAsAdminId: 'a1', tokenVersion: 2 });
  });
  it('a normal token carries no actAs claim and a refresh token is still refused', async () => {
    expect(((await s.validate({ sub: 's1', role: 'seller', typ: 'access' })) as any).actAs).toBeUndefined();
    await expect(s.validate({ sub: 's1', typ: 'refresh', actAs: 'admin' })).rejects.toThrow();
  });
});
