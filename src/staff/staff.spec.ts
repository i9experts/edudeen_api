import { DENY, effectivePermissions, permissionForRequest, PERMISSIONS, ROLE_TEMPLATES, sanitizePermissions } from './permissions';
import { base32Decode, base32Encode, newTotpSecret, totpAt, verifyTotp } from './totp.util';
import { staffBlockReason } from './staff.service';

describe('staff permissions', () => {
  it('every role template only uses real permissions and never owner-only ones', () => {
    for (const t of ROLE_TEMPLATES) expect(sanitizePermissions(t.permissions)).toEqual(t.permissions);
    expect(sanitizePermissions(['staff.manage', 'orders.view', 'nope'])).toEqual(['orders.view']);
  });
  it('maps routes to permissions (read vs write)', () => {
    expect(permissionForRequest('GET', '/api/admin/orders')).toBe('orders.view');
    expect(permissionForRequest('PATCH', '/api/admin/orders/1')).toBe('orders.manage');
    expect(permissionForRequest('PATCH', '/api/admin/finance/payouts/1/approve')).toBe('finance.payouts');
    expect(permissionForRequest('PUT', '/api/admin/platform-config/fx')).toBe('config.manage');
    expect(permissionForRequest('PATCH', '/api/admin/manual-payments/1/approve')).toBe('payments.approve');
    expect(permissionForRequest('POST', '/api/banners')).toBe('content.manage');
    expect(permissionForRequest('POST', '/api/admin/staff/invite')).toBe('staff.manage');
  });
  it('denies unmapped admin routes and unmapped writes, allows public reads and own-session routes', () => {
    expect(permissionForRequest('GET', '/api/admin/some-new-thing')).toBe(DENY);
    expect(permissionForRequest('POST', '/api/some-unmapped')).toBe(DENY);
    expect(permissionForRequest('GET', '/api/products/products-by-category')).toBeNull();
    expect(permissionForRequest('POST', '/api/auth/logout')).toBeNull();
    expect(permissionForRequest('GET', '/api/admin/staff/me')).toBeNull();
  });
  it('effective = role + extras - removals, only known keys', () => {
    expect(effectivePermissions(['orders.view', 'orders.refund'], ['users.view', 'bogus'], ['orders.refund']).sort()).toEqual(['orders.view', 'users.view']);
  });
  it('catalog keys are unique', () => { expect(new Set(PERMISSIONS.map((p) => p.key)).size).toBe(PERMISSIONS.length); });
});

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 test vector (secret "12345678901234567890", t=59 -> 287082)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('accepts the current and adjacent steps only', () => {
    const s = newTotpSecret(); const now = 1_700_000_000_000;
    expect(verifyTotp(s, totpAt(s, now), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 120_000), now)).toBe(false);
    expect(verifyTotp(s, '12345', now)).toBe(false);
  });
});

describe('staff sign-in blocking', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  it('owners are never blocked here', () => { expect(staffBlockReason({ isStaff: false, staffStatus: 'suspended' }, now)).toBeNull(); });
  it('blocks suspended, not-yet-invited, expired and locked-out staff', () => {
    expect(staffBlockReason({ isStaff: true, staffStatus: 'suspended' }, now)).toMatch(/suspended/);
    expect(staffBlockReason({ isStaff: true, staffStatus: 'invited' }, now)).toMatch(/setting up/);
    expect(staffBlockReason({ isStaff: true, staffStatus: 'active', accessExpiresAt: new Date('2026-10-01') }, now)).toMatch(/ended/);
    expect(staffBlockReason({ isStaff: true, staffStatus: 'active', totpLockedUntil: new Date('2026-10-16T12:10:00Z') }, now)).toMatch(/Too many/);
    expect(staffBlockReason({ isStaff: true, staffStatus: 'active', accessExpiresAt: new Date('2027-01-01') }, now)).toBeNull();
  });
});
