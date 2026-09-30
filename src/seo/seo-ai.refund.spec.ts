/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy tests */
import { SeoAiService } from './services/seo-ai.service';

function build(providerImpl: () => Promise<unknown>) {
  const aiCredits: any = {
    deduct: jest.fn().mockResolvedValue(undefined),
    grant: jest.fn().mockResolvedValue(undefined),
  };
  const seoContent: any = {
    getEntityContext: jest.fn().mockResolvedValue({
      sellerId: 'seller1',
      storeId: 'store1',
      name: 'Worksheet',
    }),
    applySeoSuggestion: jest.fn().mockResolvedValue(undefined),
  };
  const provider: any = {
    generateSuggestion: jest.fn().mockImplementation(providerImpl),
  };
  const platform: any = {
    getSettings: jest.fn().mockResolvedValue({ aiSeoEnabled: true }),
  };
  const db: any = {
    repositories: { seoAiSuggestionLogModel: { create: jest.fn() } },
  };
  const svc = new SeoAiService(
    db,
    { log: jest.fn() } as any,
    { assertFeatureAllowed: jest.fn() } as any,
    aiCredits,
    seoContent,
    provider,
    platform,
    {} as any,
  );
  return { svc, aiCredits };
}

describe('SeoAiService.generate — credits', () => {
  it('gives the credits back when the provider fails, then surfaces the error', async () => {
    const { svc, aiCredits } = build(async () => {
      throw new Error('provider down');
    });
    await expect(
      svc.generate('product', 'p1', 'seller1', { id: 'seller1' }),
    ).rejects.toThrow('provider down');
    expect(aiCredits.deduct).toHaveBeenCalledTimes(1);
    expect(aiCredits.grant).toHaveBeenCalledTimes(1);
    expect(aiCredits.grant.mock.calls[0][2]).toBe(
      aiCredits.deduct.mock.calls[0][2],
    ); // the same amount comes back
  });

  it('keeps the charge on success', async () => {
    const { svc, aiCredits } = build(async () => ({ metaTitle: 't' }));
    await svc.generate('product', 'p1', 'seller1', { id: 'seller1' });
    expect(aiCredits.grant).not.toHaveBeenCalled();
  });
});
