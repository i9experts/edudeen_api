import { AdminConfigService } from './admin-config.service';

function makeService(stored: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const model = {
    updateOne: jest.fn().mockResolvedValue({}),
    findOneAndUpdate: jest.fn().mockImplementation(async (_f: any, update: any) => {
      calls.push(update);
      return { sellerPage: stored, homeContent: {}, socialLinks: {}, payoutConfig: {} };
    }),
  };
  const log = { log: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined) };
  const svc = new AdminConfigService({ repositories: { platformConfigModel: model } } as any, log as any);
  (svc as any).logChange = jest.fn().mockResolvedValue(undefined);
  return { svc, model, calls };
}

describe('AdminConfigService seller page', () => {
  it('exposes sellerPage in the public config (empty object by default)', async () => {
    const a = makeService({ hero: { title: 'Hi' } });
    expect(((await a.svc.getPublicConfig()).data as any).sellerPage).toEqual({ hero: { title: 'Hi' } });
    const b = makeService(undefined as any);
    expect(((await b.svc.getPublicConfig()).data as any).sellerPage).toEqual({});
  });

  it('updateSellerPage writes only sent sections, and records an audit entry', async () => {
    const { svc, calls } = makeService({});
    await svc.updateSellerPage({ faqs: [{ q: 'Q', a: 'A' }], hero: null }, { adminId: 'a1' });
    const upd = calls[calls.length - 1];
    expect(upd.$set).toEqual({ 'sellerPage.faqs': [{ q: 'Q', a: 'A' }] });
    expect(upd.$unset).toEqual({ 'sellerPage.hero': '' });
    expect((svc as any).logChange).toHaveBeenCalledWith('seller_page_updated', expect.stringContaining('faqs'), { adminId: 'a1' });
  });

  it('rejects an empty update', async () => {
    const { svc } = makeService();
    await expect(svc.updateSellerPage({ nothing: 1 }, { adminId: 'a1' })).rejects.toThrow();
  });
});
