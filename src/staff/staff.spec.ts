import { DENY, effectivePermissions, permissionForRequest, PERMISSIONS, ROLE_TEMPLATES, sanitizePermissions } from './permissions';
import { base32Decode, base32Encode, newTotpSecret, totpAt, verifyTotp } from './totp.util';
import { staffBlockReason } from './staff.service';
import { accessWindowViolation, ipMatches, sanitizeIps, sanitizeWorkHours } from './access-window.util';
import { approvalRouteFor } from './approvals';

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

describe('access window (IPs and working hours)', () => {
  it('matches exact IPs and IPv4 ranges, and ignores the ::ffff: prefix', () => {
    expect(ipMatches('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipMatches('203.0.113.0/24', '203.0.113.200')).toBe(true);
    expect(ipMatches('203.0.113.0/24', '203.0.114.1')).toBe(false);
    expect(accessWindowViolation({ allowedIps: ['203.0.113.7'] }, '::ffff:203.0.113.7')).toBeNull();
    expect(accessWindowViolation({ allowedIps: ['203.0.113.7'] }, '198.51.100.9')).toMatch(/approved network/);
    expect(accessWindowViolation({ allowedIps: [] }, '198.51.100.9')).toBeNull();
  });
  it('enforces working days and hours in the chosen timezone (incl. overnight shifts)', () => {
    const wh = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', tz: 'Asia/Karachi' };
    // Mon 2026-10-19 10:00 PKT = 05:00 UTC
    expect(accessWindowViolation({ workHours: wh }, undefined, new Date('2026-10-19T05:00:00Z'))).toBeNull();
    expect(accessWindowViolation({ workHours: wh }, undefined, new Date('2026-10-19T14:00:00Z'))).toMatch(/09:00–18:00/); // 19:00 PKT
    expect(accessWindowViolation({ workHours: wh }, undefined, new Date('2026-10-18T05:00:00Z'))).toMatch(/working days/); // Sunday
    const night = { days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00', tz: 'UTC' };
    expect(accessWindowViolation({ workHours: night }, undefined, new Date('2026-10-19T23:30:00Z'))).toBeNull();
    expect(accessWindowViolation({ workHours: night }, undefined, new Date('2026-10-19T12:00:00Z'))).not.toBeNull();
  });
  it('sanitises input', () => {
    expect(sanitizeIps(['1.2.3.4', ' ', 'bad value!', '1.2.3.4'])).toEqual(['1.2.3.4']);
    expect(sanitizeWorkHours({ days: [1, 9], from: '9:00', to: '18:00' })).toBeNull();
    expect(sanitizeWorkHours({ days: [1, 1, 2], from: '09:00', to: '18:00', tz: 'Nope/Zone' })?.tz).toBe('Asia/Karachi');
  });
});

describe('two-person approvals', () => {
  it('flags only the sensitive money actions', () => {
    expect(approvalRouteFor('PATCH', '/api/admin/finance/payouts/abc/approve')?.key).toBe('payout');
    expect(approvalRouteFor('PATCH', '/api/refund-request/abc/approve')?.key).toBe('refund');
    expect(approvalRouteFor('PATCH', '/api/admin/manual-payments/abc/approve')?.key).toBe('payment_proof');
    expect(approvalRouteFor('GET', '/api/admin/finance/payouts/abc/approve')).toBeNull();
    expect(approvalRouteFor('PATCH', '/api/admin/finance/payouts/abc/reject')).toBeNull();
    expect(approvalRouteFor('PATCH', '/api/admin/orders/abc')).toBeNull();
  });
});