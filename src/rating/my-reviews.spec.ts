/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
/** App backend gap #7: my-reviews rows include usedFor and photos (additive; media stays). */
import { RatingService } from './rating.service';

function make(rows: any[]) {
  const chain: any = { sort: () => chain, skip: () => chain, limit: () => chain, lean: () => Promise.resolve(rows) };
  const ratingModel = { countDocuments: jest.fn().mockResolvedValue(rows.length), find: jest.fn(() => chain) };
  const productModel = { findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'p1', name: 'Phonics Book', images: ['https://x/1.jpg'] }) }) })) };
  return new RatingService({ repositories: { ratingModel, productModel } } as any, {} as any);
}

describe('GET my-reviews', () => {
  it('returns usedFor and photos next to the existing fields', async () => {
    const svc = make([
      { _id: 'r1', productId: 'p1', rating: 5, comments: [{ text: 'Great' }], media: ['https://x/a.jpg', 'https://x/b.jpg'], usedFor: 'classroom', isVerifiedPurchase: true, createdAt: new Date(0) },
      { _id: 'r2', productId: 'p1', rating: 4, comments: [], createdAt: new Date(0) },
    ]);
    const res: any = await svc.getMyReviews('u1', { page: 1 });
    const [a, b] = res.data.reviews;
    expect(a).toMatchObject({ reviewId: 'r1', usedFor: 'classroom', photos: ['https://x/a.jpg', 'https://x/b.jpg'], media: ['https://x/a.jpg', 'https://x/b.jpg'] });
    expect(b).toMatchObject({ reviewId: 'r2', usedFor: null, photos: [] });
  });
});
