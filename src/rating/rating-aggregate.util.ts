/* eslint-disable prettier/prettier */
/**
 * Recompute-from-scratch rating aggregates, shared by RatingService (buyer /
 * seller / admin review deletes) and AdminModerationService (removing a
 * reported review) so every path that hides a review leaves
 * Product.averageRating and Store.averageRating/reviewCount correct.
 */

interface RatingRepos {
  ratingModel: { aggregate: (pipeline: any[]) => any };
  productModel: { findByIdAndUpdate: (id: any, update: any) => any };
  storeModel: { findByIdAndUpdate: (id: any, update: any) => any };
}

async function aggregateRatings(repos: RatingRepos, match: Record<string, unknown>) {
  const agg = await repos.ratingModel.aggregate([
    { $match: { ...match, isDelete: false, rating: { $ne: null } } },
    { $group: { _id: null, sum: { $sum: '$rating' }, count: { $sum: 1 } } },
  ]);
  const sum = agg[0]?.sum ?? 0;
  const count = agg[0]?.count ?? 0;
  const average = count > 0 ? parseFloat((sum / count).toFixed(2)) : 0;
  return { sum, count, average };
}

export async function recalcProductRating(repos: RatingRepos, productId: string) {
  const { sum, count, average } = await aggregateRatings(repos, { productId });
  await repos.productModel.findByIdAndUpdate(productId, {
    ratingSum: sum,
    averageRating: average,
    totalRatings: count,
  });
}

/** Scoped to Rating.storeId (denormalized from Product.storeId at review-create time). */
export async function recalcStoreRating(repos: RatingRepos, storeId: string | null | undefined) {
  if (!storeId) return;
  const { count, average } = await aggregateRatings(repos, { storeId });
  await repos.storeModel.findByIdAndUpdate(storeId, {
    averageRating: average,
    reviewCount: count,
  });
}
