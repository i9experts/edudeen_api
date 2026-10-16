import { SeoResolutionService } from './seo-resolution.service';

describe('old product slugs redirect bots to the current slug', () => {
  const make = (exists: boolean, found: any) => {
    const svc: any = Object.create(SeoResolutionService.prototype);
    svc.db = { repositories: { productModel: { exists: jest.fn().mockResolvedValue(exists ? { _id: 'x' } : null), findOne: jest.fn(() => ({ select: () => ({ lean: async () => found }) })) } } };
    return svc;
  };
  it('returns the current slug for a renamed-away slug', async () => {
    expect(await make(false, { slug: 'new-full-title' }).currentSlugForOldProductSlug('old-title')).toBe('new-full-title');
  });
  it('null when the slug is itself current, unknown, or an id', async () => {
    expect(await make(true, null).currentSlugForOldProductSlug('live-slug')).toBeNull();
    expect(await make(false, null).currentSlugForOldProductSlug('nothing')).toBeNull();
    expect(await make(false, { slug: 'x' }).currentSlugForOldProductSlug('507f1f77bcf86cd799439011')).toBeNull();
  });
});