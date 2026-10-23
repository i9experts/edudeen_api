import { AdminExportsService } from './admin-exports.service';
import { EXPORT_ROW_CAP } from '../common/csv-export.util';

const chain = (rows: any[]) => ({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(rows) });

function make(logged = true) {
  const repos: any = {
    userModel: { find: jest.fn().mockReturnValue(chain([{ _id: 'u1', name: '=cmd|calc', email: 'a@b.c', status: 'active', createdAt: new Date('2026-01-02') }])) },
    sellerModel: { find: jest.fn().mockReturnValue(chain([{ _id: 's1', name: 'Seller', email: 's@b.c', status: 'active', createdAt: new Date('2026-01-03') }])) },
    orderModel: { find: jest.fn().mockReturnValue(chain([])) },
    productModel: { find: jest.fn().mockReturnValue(chain([])) },
    storeModel: { find: jest.fn().mockReturnValue(chain([])) },
    manualPaymentProofModel: { find: jest.fn().mockReturnValue(chain(Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => ({ _id: `p${i}`, checkoutId: 'c', status: 'pending', amountUSD: 1, amountPKR: 280, createdAt: new Date() })))) },
  };
  const activity: any = { logExport: jest.fn().mockResolvedValue(logged) };
  return { svc: new AdminExportsService({ repositories: repos } as any, activity), repos, activity };
}

describe('AdminExportsService', () => {
  it('users export merges buyers and sellers, newest first, and defuses formula names', async () => {
    const { svc } = make();
    const csv = await svc.users({}, { id: 'a1', name: 'Admin' });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Id","Name","Email","Role","Status","Joined"');
    expect(lines[1]).toContain('"s1"'); // the seller joined later
    expect(csv).toContain(`"'=cmd|calc"`);
    expect(csv).not.toMatch(/password|otp|token/i);
  });

  it('every export is audited with the actor, kind and row count', async () => {
    const { svc, activity } = make();
    await svc.users({ role: 'buyer' }, { id: 'a1', name: 'Admin' });
    expect(activity.logExport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'users', rowCount: 1, truncated: false, actor: expect.objectContaining({ id: 'a1' }) }));
  });

  it('is refused when the audit entry cannot be written (fail closed)', async () => {
    const { svc } = make(false);
    await expect(svc.users({})).rejects.toThrow(/audit/);
  });

  it('marks a truncated export and still audits it as truncated', async () => {
    const { svc, activity } = make();
    const csv = await svc.paymentProofs({});
    expect(csv.split('\n')[0]).toMatch(/TRUNCATED/);
    expect(activity.logExport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'payment_proofs', rowCount: EXPORT_ROW_CAP, truncated: true }));
  });

  it('rejects an invalid date filter instead of exporting everything', async () => {
    const { svc } = make();
    await expect(svc.orders({ from: 'not-a-date' })).rejects.toThrow(/valid date/);
  });

  it('only honours known status values for proofs and never lets an operator object through', async () => {
    const { svc, repos } = make();
    await svc.paymentProofs({ status: { $ne: 'x' } as any }).catch(() => undefined);
    expect(repos.manualPaymentProofModel.find.mock.calls[0][0]).toEqual({});
  });
});
