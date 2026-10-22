/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { ForbiddenException, BadRequestException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminReauthGuard, REQUIRE_REAUTH_KEY, RequireReauth } from './admin-reauth.guard';
import { AdminFinanceController } from '../admin-finance/admin-finance.controller';
import { AdminFxController } from '../exchange-rate/exchange-rate.controller';
import { AdminPremiumController } from '../premium/premium.controller';
import { AdminConfigController } from '../admin-config/admin-config.controller';
import { OrdersController } from '../orders/orders.controller';
import { GrantPremiumDto } from '../premium/premium.dto';
import { APPROVAL_ROUTES, REQUIRED_APPROVAL_KEYS, approvalRouteFor } from '../staff/approvals';
import { permissionForRequest } from '../staff/permissions';
import { auditDiff } from '../admin-config/config-audit.util';
import { OrdersService } from '../orders/orders.service';

class Strict { @RequireReauth() go() { return 1; } plain() { return 2; } }

function ctx(handler: any, req: any): ExecutionContext {
  return { getHandler: () => handler, getClass: () => Strict, switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('AdminReauthGuard strict mode', () => {
  const reauth: any = { isValid: jest.fn(async (id: string, tok: string) => id === 'a1' && tok === 'good') };
  const guard = new AdminReauthGuard(reauth, new Reflector());
  const strictCtx = (req: any) => ctx(Strict.prototype.go, req);

  it('admin without token is refused even without X-Inline-Edit', async () => {
    await expect(guard.canActivate(strictCtx({ user: { userId: 'a1', role: 'admin' }, headers: {} }))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('admin with a wrong token is refused', async () => {
    await expect(guard.canActivate(strictCtx({ user: { userId: 'a1', role: 'admin' }, headers: { 'x-admin-reauth': 'bad' } }))).rejects.toThrow(/Password confirmation/);
  });
  it('admin with a valid token passes (no inline header needed)', async () => {
    await expect(guard.canActivate(strictCtx({ user: { userId: 'a1', role: 'admin' }, headers: { 'x-admin-reauth': 'good' } }))).resolves.toBe(true);
  });
  it('a seller on a shared route is not asked', async () => {
    await expect(guard.canActivate(strictCtx({ user: { userId: 's1', role: 'seller' }, headers: {} }))).resolves.toBe(true);
  });
  it('non-strict routes still need the header to trigger', async () => {
    await expect(guard.canActivate(ctx(Strict.prototype.plain, { user: { userId: 'a1', role: 'admin' }, headers: {} }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(Strict.prototype.plain, { user: { userId: 'a1', role: 'admin' }, headers: { 'x-inline-edit': '1' } }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('money routes are marked RequireReauth and carry the guard', () => {
  const guards = (c: any, m: string) => [...(Reflect.getMetadata('__guards__', c.prototype[m]) ?? []), ...(Reflect.getMetadata('__guards__', c) ?? [])];
  const cases: [any, string[]][] = [
    [AdminFinanceController, ['createManualPayout', 'retryCreditJob', 'triggerClearingBalances', 'runMonthlySettlement', 'verifyPayoutMethod']],
    [AdminFxController, ['override']],
    [AdminPremiumController, ['grant', 'approve']],
    [AdminConfigController, ['updateManualPaymentConfig', 'updatePlatformFees', 'updatePayoutConfig', 'updateFxConfig']],
    [OrdersController, ['markPaid']],
  ];
  for (const [c, ms] of cases) for (const m of ms) {
    it(`${c.name}.${m}`, () => {
      expect(Reflect.getMetadata(REQUIRE_REAUTH_KEY, c.prototype[m])).toBe(true);
      expect(guards(c, m)).toContain(AdminReauthGuard);
    });
  }
  it('class-level guards run Jwt before the reauth guard (so req.user exists)', () => {
    for (const c of [AdminFinanceController, AdminFxController, AdminPremiumController]) {
      const list = Reflect.getMetadata('__guards__', c) as any[];
      expect(list.map((g) => g.name)).toEqual(['JwtAuthGuard', 'RolesGuard', 'AdminReauthGuard']);
    }
  });
});

describe('staff: approvals + permissions for money routes', () => {
  const cases: [string, string, string][] = [
    ['PUT', '/api/orders/mark-paid/abc', 'order_mark_paid'],
    ['PUT', '/api/admin/platform-config/manual-payment', 'manual_payment_account'],
    ['POST', '/api/admin/finance/sellers/s1/payouts/manual', 'manual_payout'],
    ['POST', '/api/admin/finance/monthly-settlement/run', 'monthly_settlement'],
    ['PATCH', '/api/admin/finance/sellers/s1/payout-methods/m1/verify', 'payout_method_verify'],
    ['POST', '/api/admin/finance/process-clearing', 'process_clearing'],
    ['POST', '/api/admin/finance/credit-jobs/j1/retry', 'credit_job_retry'],
    ['PATCH', '/api/admin/premium/payments/p1/approve', 'premium_payment'],
    ['POST', '/api/admin/premium/members/grant', 'premium_grant'],
    ['POST', '/api/admin/fx/override', 'fx_override'],
    ['PUT', '/API/orders/mark-paid/abc/', 'order_mark_paid'],
  ];
  for (const [m, p, key] of cases) it(`${m} ${p} -> ${key}`, () => expect(approvalRouteFor(m, p)?.key).toBe(key));
  it('new routes are required (older saved settings cannot switch them off)', () => {
    for (const [, , key] of cases) expect(REQUIRED_APPROVAL_KEYS).toContain(key);
    expect(APPROVAL_ROUTES.find((r) => r.key === 'payout')?.required).toBeUndefined();
  });
  it('mark-paid needs payments.approve for staff (not orders.manage)', () => {
    expect(permissionForRequest('PUT', '/api/orders/mark-paid/abc')).toBe('payments.approve');
    expect(permissionForRequest('PUT', '/api/orders/update-status')).toBe('orders.manage');
  });
});

describe('config audit diff', () => {
  it('masks account numbers to the last 4 and lists only real changes', () => {
    const d = auditDiff({ accountNumber: '1234567890123', bankName: 'HBL', enabled: true }, { accountNumber: '9999888877776', bankName: 'HBL', enabled: true });
    expect(d.changed).toEqual(['accountNumber']);
    expect(d.before).toEqual({ accountNumber: '****0123' });
    expect(d.after).toEqual({ accountNumber: '****7776' });
    expect(JSON.stringify(d)).not.toContain('9999888877776');
  });
  it('plain values stay readable', () => {
    expect(auditDiff({ usdToPkrRate: 280 }, { usdToPkrRate: 290 })).toEqual({ before: { usdToPkrRate: 280 }, after: { usdToPkrRate: 290 }, changed: ['usdToPkrRate'] });
  });
});

describe('Premium grant duration cap', () => {
  const check = async (days: number) => validate(plainToInstance(GrantPremiumDto, { userId: '507f1f77bcf86cd799439011', planId: '507f1f77bcf86cd799439012', days }));
  it('366 ok, 367 rejected', async () => {
    expect(await check(366)).toHaveLength(0);
    expect((await check(367)).length).toBeGreaterThan(0);
  });
});

describe('admin mark-paid on a bank-transfer order', () => {
  function build(proofExists: boolean) {
    const order: any = { _id: 'o1', isPaid: false, paymentType: 'manual_bank_transfer', sellerOrders: [{ storeId: 's', sellerId: 'u', status: 'pending', items: [{}] }] };
    const orderModel: any = { findOne: jest.fn().mockResolvedValue(order), findOneAndUpdate: jest.fn().mockResolvedValue(order), findByIdAndUpdate: jest.fn().mockResolvedValue(order) };
    const proofs: any = { exists: jest.fn().mockResolvedValue(proofExists ? { _id: 'p' } : null) };
    const finance: any = { recordSaleDurable: jest.fn().mockResolvedValue({ creditStatus: 'credited' }) };
    const svc = new OrdersService({ repositories: { orderModel, manualPaymentProofModel: proofs, storeModel: {} } } as any, {} as any, {} as any, {} as any, finance,
      { log: jest.fn().mockResolvedValue(undefined) } as any, { awardPurchasePoints: jest.fn() } as any, { getActiveBenefits: jest.fn().mockResolvedValue(null), getLoyaltyMultiplier: jest.fn() } as any, { notify: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any);
    return { svc, orderModel, finance, proofs };
  }
  it('refused without an approved proof; nothing credited', async () => {
    const t = build(false);
    await expect(t.svc.markPaid('o1', { userId: 'a', role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(t.finance.recordSaleDurable).not.toHaveBeenCalled();
    expect(t.proofs.exists).toHaveBeenCalledWith({ orderIds: 'o1', status: 'approved' });
  });
  it('allowed once an approved proof exists', async () => {
    const t = build(true);
    await expect(t.svc.markPaid('o1', { userId: 'a', role: 'admin' })).resolves.toBeDefined();
  });
});