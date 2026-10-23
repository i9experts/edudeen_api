import { SENSITIVE_READS } from './staff-access.middleware';

const hit = (p: string) => SENSITIVE_READS.some((re) => re.test(p));

describe('staff read audit (SENSITIVE_READS)', () => {
  it.each([
    '/api/admin/users/buyer/64b0000000000000000000a1',
    '/api/admin/orders/64b0000000000000000000a1',
    '/api/messaging/admin/conversations/64b0000000000000000000a1',
    '/api/admin/finance/payouts/64b0000000000000000000a1/destination',
  ])('audits %s', (p) => expect(hit(p)).toBe(true));

  it.each([
    '/api/admin/users', '/api/admin/users/stats', '/api/admin/orders', '/api/messaging/admin/conversations',
    '/api/admin/marketplace/listings', '/api/admin/finance/overview',
  ])('does not audit lists / dashboards: %s', (p) => expect(hit(p)).toBe(false));
});