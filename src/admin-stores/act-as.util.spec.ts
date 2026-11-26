/* eslint-disable prettier/prettier */
import { actAsDeniedReason, createActAsMiddleware } from './act-as.util';

const run = async (mw: any, req: any) => {
  const res: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { res, nexted };
};
const payload = { sub: 's1', role: 'seller', typ: 'access', actAs: 'admin', actAsAdminId: 'a1', storeId: 'st1' };
const mk = (logOk = true, p: any = payload) => {
  const log = jest.fn().mockResolvedValue(logOk);
  return { log, mw: createActAsMiddleware({ verify: (t) => (t === 'act' ? p : t === 'plain' ? { sub: 's1', role: 'seller', typ: 'access' } : null), log }) };
};
const req = (over: any = {}) => ({ method: 'GET', path: '/api/products/x', headers: { authorization: 'Bearer act' }, query: {}, body: {}, ...over });

describe('actAsDeniedReason', () => {
  it('blocks money-out and account routes for writes', () => {
    for (const [m, p] of [
      ['POST', '/api/finance/abc/payouts/request'], ['POST', '/api/finance/abc/payout-methods'], ['PATCH', '/api/finance/abc/payout-schedule'],
      ['DELETE', '/api/finance/abc/payout-methods/1'], ['PUT', '/api/users/change-password'], ['DELETE', '/api/users/profile'],
      ['POST', '/api/auth/switch-to-buyer'], ['POST', '/api/auth/create-buyer-account'], ['GET', '/api/stripe-connect/status'],
      ['POST', '/api/platform-plans/change'], ['DELETE', '/api/store/abc'],
    ]) expect(actAsDeniedReason(m, p)).toBeTruthy();
  });
  it('lets an admin READ finance and do normal store work', () => {
    for (const [m, p] of [
      ['GET', '/api/finance/abc/earnings-summary'], ['GET', '/api/finance/abc/earnings-statement/download'], ['GET', '/api/users/profile'],
      ['POST', '/api/products/add-physical-product'], ['PUT', '/api/orders/update-status/1'], ['POST', '/api/auth/logout'],
      ['POST', '/api/finance/abc/tax-reports/generate'], ['PATCH', '/api/store/abc'],
    ]) expect(actAsDeniedReason(m, p)).toBeNull();
  });
});

describe('act-as middleware', () => {
  it('ignores normal tokens and anonymous requests', async () => {
    const { mw, log } = mk();
    expect((await run(mw, req({ headers: { authorization: 'Bearer plain' } }))).nexted).toBe(true);
    expect((await run(mw, req({ headers: {} }))).nexted).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
  it('refuses another store id in query or body', async () => {
    const { mw } = mk();
    const r = await run(mw, req({ query: { storeId: 'other' } }));
    expect(r.res.code).toBe(403); expect(r.res.body.code).toBe('ACT_AS_OTHER_STORE'); expect(r.nexted).toBe(false);
    expect((await run(mw, req({ method: 'POST', body: { storeId: 'other' } }))).res.code).toBe(403);
    expect((await run(mw, req({ query: { storeId: 'st1' } }))).nexted).toBe(true);
  });
  it('blocks denied routes with 403 and does not audit them', async () => {
    const { mw, log } = mk();
    const r = await run(mw, req({ method: 'POST', path: '/api/finance/st1/payouts/request' }));
    expect(r.res.code).toBe(403); expect(r.res.body.code).toBe('ACT_AS_FORBIDDEN'); expect(log).not.toHaveBeenCalled();
  });
  it('audits every write before it runs, as the admin, and never audits reads', async () => {
    const { mw, log } = mk();
    expect((await run(mw, req())).nexted).toBe(true);
    expect(log).not.toHaveBeenCalled();
    const r = await run(mw, req({ method: 'POST', path: '/api/products/add-physical-product' }));
    expect(r.nexted).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'a1', actorRole: 'admin', targetId: 'st1', storeId: 'st1', metadata: expect.objectContaining({ actAsSeller: true }) }));
  });
  it('refuses a write when the audit entry cannot be stored', async () => {
    const { mw } = mk(false);
    const r = await run(mw, req({ method: 'PUT', path: '/api/orders/update-status/1' }));
    expect(r.res.code).toBe(503); expect(r.nexted).toBe(false);
  });
  it('fails closed on an internal error and rejects bad paths', async () => {
    const log = jest.fn().mockRejectedValue(new Error('db'));
    const mw = createActAsMiddleware({ verify: () => payload, log });
    expect((await run(mw, req({ method: 'POST', path: '/api/products/x' }))).res.code).toBe(503);
    const { mw: mw2 } = mk();
    expect((await run(mw2, req({ path: '/api/%E0%A4%A' }))).res.code).toBe(400);
  });
});
