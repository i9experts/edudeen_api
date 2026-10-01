import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { AddReviewDto } from './dto/add-review.dto';
import { EditReviewDto } from './dto/edit-review.dto';
import { SellerReplyDto } from './dto/seller-reply.dto';
import { LoyaltyService } from 'src/loyalty/loyalty.service';

import { clampInt } from 'src/common/query-safety.util';
import { checkVerifiedPurchase } from './verified-purchase.util';

@Injectable()
export class RatingService {
  constructor(
    private databaseService: DatabaseService,
    private loyaltyService: LoyaltyService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────

  // Admins can moderate any store's reviews; sellers only their own.
  private async verifyStoreAccess(
    storeId: string,
    userId: string,
    role: string,
  ) {
    const { storeModel } = this.r;
    const filter: any = { _id: storeId, isDelete: false };
    if (role !== 'admin') filter.sellerId = userId;

    const store = await storeModel.findOne(filter);
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async findReviewOrThrow(reviewId: string) {
    const { ratingModel } = this.r;
    const review = await ratingModel.findOne({
      _id: reviewId,
      isDelete: false,
    });
    if (!review) throw new NotFoundException('Review not found');
    return review;
  }

  // Recomputes from scratch instead of incrementing — avoids drift after
  // edits/deletes and keeps Product.averageRating/ratingSum always correct.
  private async recalcProductRating(productId: string) {
    const { productModel, ratingModel } = this.r;

    const agg = await ratingModel.aggregate([
      { $match: { productId, isDelete: false, rating: { $ne: null } } },
      { $group: { _id: null, sum: { $sum: '$rating' }, count: { $sum: 1 } } },
    ]);

    const sum = agg[0]?.sum ?? 0;
    const count = agg[0]?.count ?? 0;
    const average = count > 0 ? parseFloat((sum / count).toFixed(2)) : 0;

    await productModel.findByIdAndUpdate(productId, {
      ratingSum: sum,
      averageRating: average,
      totalRatings: count,
    });
  }

  // Same recompute-from-scratch approach as recalcProductRating, but scoped
  // to Rating.storeId (denormalized from Product.storeId at review-create
  // time) so Store.averageRating/reviewCount stay correct across stores that
  // sell many products.
  private async recalcStoreRating(storeId: string | null | undefined) {
    if (!storeId) return;
    const { storeModel, ratingModel } = this.r;

    const agg = await ratingModel.aggregate([
      { $match: { storeId, isDelete: false, rating: { $ne: null } } },
      { $group: { _id: null, sum: { $sum: '$rating' }, count: { $sum: 1 } } },
    ]);

    const sum = agg[0]?.sum ?? 0;
    const count = agg[0]?.count ?? 0;
    const average = count > 0 ? parseFloat((sum / count).toFixed(2)) : 0;

    await storeModel.findByIdAndUpdate(storeId, {
      averageRating: average,
      reviewCount: count,
    });
  }

  // A review is a "Verified Purchase" if the reviewer has a non-deleted order
  // containing this product (and variant, if given) with an item that was
  // actually delivered/completed — not just placed.
  // The rule lives in verified-purchase.util.ts so the UI's `canReview` flags use exactly the same code.
  private checkVerifiedPurchase(
    userId: string,
    productId: string,
    productVariantId: string | null,
    orderId?: string | null,
  ) {
    return checkVerifiedPurchase(this.r.orderModel, userId, productId, productVariantId, orderId);
  }

  // ── BUYER: WRITE ──────────────────────────────────────────────────────────

  async addReview(userId: string, dto: AddReviewDto) {
    const {
      productId,
      productVariantId,
      orderId,
      rating,
      comment,
      isAnonymous,
      media,
    } = dto;

    const { productModel, ratingModel } = this.r;

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product) throw new BadRequestException('Product not found');

    const existing = await ratingModel.findOne({
      userId,
      productId,
      isDelete: false,
    });

    if (existing) {
      if (
        rating !== undefined ||
        media !== undefined ||
        isAnonymous !== undefined
      ) {
        throw new BadRequestException(
          'Rating, media and isAnonymous can only be set once — use edit instead',
        );
      }
      if (!comment)
        throw new BadRequestException(
          'Only comment can be added to an existing review',
        );

      await ratingModel.findByIdAndUpdate(existing._id, {
        $push: { comments: { text: comment, createdAt: new Date() } },
      });

      return {
        success: true,
        message: 'Comment added',
        data: await ratingModel.findById(existing._id).lean(),
      };
    }

    const isVerifiedPurchase = await this.checkVerifiedPurchase(
      userId,
      productId,
      productVariantId ?? null,
      orderId,
    );

    // Education marketplaces (e.g. TPT) only accept reviews from buyers —
    // otherwise any account can review-bomb a competitor's resource, since
    // every rating counts toward Product.averageRating.
    if (!isVerifiedPurchase) {
      throw new ForbiddenException('Only customers who purchased this product can review it');
    }

    const reviewData: any = {
      userId,
      productId,
      storeId: product.storeId || null,
      productVariantId: productVariantId || null,
      orderId: orderId || null,
      rating: rating ?? null,
      media: media || [],
      isAnonymous: isAnonymous ?? false,
      isVerifiedPurchase,
      comments: [],
    };

    if (comment) {
      reviewData.comments.push({ text: comment, createdAt: new Date() });
    }

    const review = await ratingModel.create(reviewData);

    if (rating) {
      await this.recalcProductRating(productId);
      await this.recalcStoreRating(product.storeId);
    }

    if (isVerifiedPurchase && rating && product.storeId) {
      this.loyaltyService
        .awardReviewPoints(product.storeId, userId)
        .catch(() => {});
    }

    return { success: true, message: 'Review added', data: review };
  }

  async editReview(userId: string, reviewId: string, dto: EditReviewDto) {
    const { ratingModel } = this.r;

    const review = await this.findReviewOrThrow(reviewId);
    if (review.userId !== userId)
      throw new ForbiddenException('You can only edit your own review');

    const update: any = {};
    if (dto.rating !== undefined) update.rating = dto.rating;
    if (dto.media !== undefined) update.media = dto.media;

    if (dto.comment !== undefined) {
      if (review.comments.length > 0) {
        update['comments.0.text'] = dto.comment;
        update['comments.0.createdAt'] = review.comments[0].createdAt;
      } else {
        update.comments = [{ text: dto.comment, createdAt: new Date() }];
      }
    }

    if (Object.keys(update).length === 0)
      throw new BadRequestException('Nothing to update');

    await ratingModel.findByIdAndUpdate(reviewId, { $set: update });

    if (dto.rating !== undefined) {
      await this.recalcProductRating(review.productId);
      await this.recalcStoreRating(review.storeId);
    }

    return {
      success: true,
      message: 'Review updated',
      data: await ratingModel.findById(reviewId).lean(),
    };
  }

  async deleteReview(userId: string, reviewId: string) {
    const { ratingModel } = this.r;

    const review = await this.findReviewOrThrow(reviewId);
    if (review.userId !== userId)
      throw new ForbiddenException('You can only delete your own review');

    await ratingModel.findByIdAndUpdate(reviewId, { isDelete: true });

    if (review.rating) {
      await this.recalcProductRating(review.productId);
      await this.recalcStoreRating(review.storeId);
    }

    return { success: true, message: 'Review deleted' };
  }

  async getMyReviews(userId: string, query: any) {
    const { ratingModel, productModel } = this.r;

    const page = clampInt(query.page, 1, 1, 100000);
    const limit = 10;
    const skip = (page - 1) * limit;

    const filter = { userId, isDelete: false };
    const total = await ratingModel.countDocuments(filter);
    const reviews = await ratingModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const list = await Promise.all(
      reviews.map(async (r: any) => {
        const product = await productModel
          .findById(r.productId)
          .select('name images')
          .lean();
        return {
          reviewId: r._id,
          product: product
            ? {
                productId: product._id,
                name: (product as any).name,
                image: (product as any).images?.[0] ?? null,
              }
            : null,
          rating: r.rating,
          comments: r.comments,
          media: r.media,
          isVerifiedPurchase: r.isVerifiedPurchase,
          sellerReply: r.sellerReply || null,
          createdAt: r.createdAt,
        };
      }),
    );

    return {
      success: true,
      data: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        reviews: list,
      },
    };
  }

  // ── PUBLIC / BUYER-FACING: READ ───────────────────────────────────────────

  async getProductReviews(
    productId: string,
    query: any,
    viewerId: string | null = null,
  ) {
    const { ratingModel, userModel } = this.r;

    const page = clampInt(query.page, 1, 1, 100000);
    const limit = clampInt(query.limit, 10, 1, 100);
    const skip = (page - 1) * limit;

    const filter: any = { productId, isDelete: false };
    if (query.rating) filter.rating = parseInt(query.rating);
    if (query.hasMedia === 'true') filter.media = { $exists: true, $ne: [] };
    if (query.verifiedOnly === 'true') filter.isVerifiedPurchase = true;

    const sortMap: Record<string, any> = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      highest_rating: { rating: -1, createdAt: -1 },
      lowest_rating: { rating: 1, createdAt: -1 },
      most_helpful: { createdAt: -1 }, // re-sorted in-memory below (array length isn't sortable in Mongo without a stored count)
    };
    const sort = sortMap[query.sort] ?? sortMap.newest;

    const total = await ratingModel.countDocuments(filter);
    let reviews = await ratingModel
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();
    if (query.sort === 'most_helpful') {
      reviews = reviews.sort(
        (a: any, b: any) =>
          (b.helpfulUserIds?.length ?? 0) - (a.helpfulUserIds?.length ?? 0),
      );
    }

    const allForStats = await ratingModel
      .find({ productId, isDelete: false, rating: { $ne: null } })
      .select('rating')
      .lean();
    const ratingBreakdown: Record<string, number> = {
      '5': 0,
      '4': 0,
      '3': 0,
      '2': 0,
      '1': 0,
    };
    let sum = 0;
    for (const r of allForStats) {
      ratingBreakdown[String(r.rating)] =
        (ratingBreakdown[String(r.rating)] || 0) + 1;
      sum += r.rating as number;
    }
    const averageRating =
      allForStats.length > 0
        ? parseFloat((sum / allForStats.length).toFixed(2))
        : 0;

    const list = await Promise.all(
      reviews.map(async (r: any) => {
        const isOwn = !!viewerId && r.userId === viewerId;
        const user =
          r.isAnonymous && !isOwn
            ? null
            : await userModel.findById(r.userId).select('name').lean();
        return {
          reviewId: r._id,
          customerName: isOwn
            ? 'You'
            : r.isAnonymous
              ? 'Anonymous'
              : (user as any)?.name || 'Unknown',
          isOwn,
          rating: r.rating,
          comments: r.comments,
          media: r.media,
          isVerifiedPurchase: r.isVerifiedPurchase,
          sellerReply: r.sellerReply || null,
          helpfulCount: r.helpfulUserIds?.length ?? 0,
          helpfulByMe:
            !!viewerId && (r.helpfulUserIds ?? []).includes(viewerId),
          createdAt: r.createdAt,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          averageRating,
          totalReviews: allForStats.length,
          ratingBreakdown,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        reviews: list,
      },
    };
  }

  /** Toggle the caller's "helpful" vote on a review — idempotent, no self-vote block (own-review voting is harmless). */
  async toggleHelpful(userId: string, reviewId: string) {
    const { ratingModel } = this.r;
    const review = await this.findReviewOrThrow(reviewId);

    const alreadyVoted = (review.helpfulUserIds ?? []).includes(userId);
    await ratingModel.findByIdAndUpdate(
      reviewId,
      alreadyVoted
        ? { $pull: { helpfulUserIds: userId } }
        : { $addToSet: { helpfulUserIds: userId } },
    );

    const updated = await ratingModel
      .findById(reviewId)
      .select('helpfulUserIds')
      .lean();
    return {
      success: true,
      message: alreadyVoted ? 'Removed helpful vote' : 'Marked as helpful',
      data: {
        helpfulCount: (updated as any)?.helpfulUserIds?.length ?? 0,
        helpfulByMe: !alreadyVoted,
      },
    };
  }

  // ── SELLER / ADMIN: MANAGE ────────────────────────────────────────────────

  async getStoreReviews(
    sellerId: string,
    role: string,
    storeId: string,
    query: any,
  ) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { ratingModel, userModel } = this.r;
    await this.verifyStoreAccess(storeId, sellerId, role);

    const page = clampInt(query.page, 1, 1, 100000);
    const limit = 10;
    const skip = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.rating && query.rating !== 'all')
      filter.rating = parseInt(query.rating);
    if (query.productId && query.productId !== 'all')
      filter.productId = query.productId;

    const totalReviews = await ratingModel.countDocuments(filter);
    const totalPages = Math.ceil(totalReviews / limit);

    const reviews = await ratingModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // stats
    const allReviews = await ratingModel
      .find({ storeId, isDelete: false })
      .lean();

    const ratingBreakdown: Record<string, number> = {
      '5': 0,
      '4': 0,
      '3': 0,
      '2': 0,
      '1': 0,
    };
    let ratingSum = 0;
    let ratingCount = 0;
    let flaggedCount = 0;
    let repliedCount = 0;
    let totalResponseMs = 0;
    let responseTimeCount = 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let reviewsThisMonth = 0;

    for (const r of allReviews) {
      if (r.rating) {
        ratingBreakdown[String(r.rating)] =
          (ratingBreakdown[String(r.rating)] || 0) + 1;
        ratingSum += r.rating;
        ratingCount++;
      }
      if (r.isFlagged) flaggedCount++;
      if (r.sellerReply) {
        repliedCount++;
        const replyCreatedAt = new Date(r.sellerReply.createdAt).getTime();
        const reviewCreatedAt = new Date(r.createdAt).getTime();
        const replyTime = replyCreatedAt - reviewCreatedAt;
        if (!isNaN(replyTime) && replyTime >= 0) {
          totalResponseMs += replyTime;
          responseTimeCount++;
        }
      }
      if (new Date(r.createdAt) >= monthStart) reviewsThisMonth++;
    }

    const averageRating =
      ratingCount > 0 ? parseFloat((ratingSum / ratingCount).toFixed(1)) : 0;
    const fiveStarRate =
      ratingCount > 0
        ? parseFloat(((ratingBreakdown['5'] / ratingCount) * 100).toFixed(1))
        : 0;
    const responseRate =
      allReviews.length > 0
        ? parseFloat(((repliedCount / allReviews.length) * 100).toFixed(1))
        : 0;
    const avgResponseHrs =
      responseTimeCount > 0
        ? parseFloat((totalResponseMs / responseTimeCount / 3600000).toFixed(1))
        : 0;

    const breakdownPercent: Record<string, string> = {};
    for (const star of ['5', '4', '3', '2', '1']) {
      breakdownPercent[star] =
        ratingCount > 0
          ? `${parseFloat(((ratingBreakdown[star] / ratingCount) * 100).toFixed(1))}%`
          : '0%';
    }

    const list = await Promise.all(
      reviews.map(async (r: any) => {
        const user = await userModel
          .findById(r.userId)
          .select('name email')
          .lean();
        return {
          reviewId: r._id,
          customer: {
            name: r.isAnonymous
              ? 'Anonymous'
              : (user as any)?.name || 'Unknown',
            email: r.isAnonymous ? null : (user as any)?.email || null,
          },
          productId: r.productId,
          productVariantId: r.productVariantId || null,
          rating: r.rating,
          comments: r.comments,
          media: r.media,
          isVerifiedPurchase: r.isVerifiedPurchase,
          sellerReply: r.sellerReply || null,
          isFlagged: r.isFlagged,
          createdAt: r.createdAt,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          averageRating,
          totalReviews: allReviews.length,
          ratingBreakdown: breakdownPercent,
          reviewsThisMonth,
          flaggedReviews: flaggedCount,
          fiveStarRate: `${fiveStarRate}%`,
          responseRate: `${responseRate}%`,
          avgResponseTime: `${avgResponseHrs} hrs`,
        },
        pagination: { page, limit, totalPages, total: totalReviews },
        reviews: list,
      },
    };
  }

  async replyToReview(
    sellerId: string,
    role: string,
    reviewId: string,
    dto: SellerReplyDto,
  ) {
    const { ratingModel } = this.r;

    const review = await this.findReviewOrThrow(reviewId);
    await this.verifyStoreAccess(review.storeId as string, sellerId, role);

    if (review.sellerReply)
      throw new BadRequestException(
        'Already replied. Use edit-reply to update.',
      );

    await ratingModel.findByIdAndUpdate(reviewId, {
      sellerReply: {
        text: dto.text,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return { success: true, message: 'Reply added' };
  }

  async editReply(
    sellerId: string,
    role: string,
    reviewId: string,
    dto: SellerReplyDto,
  ) {
    const { ratingModel } = this.r;

    const review = await this.findReviewOrThrow(reviewId);
    await this.verifyStoreAccess(review.storeId as string, sellerId, role);

    if (!review.sellerReply)
      throw new BadRequestException('No reply exists. Use reply first.');

    await ratingModel.findByIdAndUpdate(reviewId, {
      'sellerReply.text': dto.text,
      'sellerReply.updatedAt': new Date(),
    });

    return { success: true, message: 'Reply updated' };
  }

  async flagReview(sellerId: string, role: string, reviewId: string) {
    const { ratingModel } = this.r;

    const review = await this.findReviewOrThrow(reviewId);
    await this.verifyStoreAccess(review.storeId as string, sellerId, role);

    if (review.isFlagged)
      throw new BadRequestException('Review is already flagged');

    await ratingModel.findByIdAndUpdate(reviewId, { isFlagged: true });

    return { success: true, message: 'Review flagged' };
  }

  async unflagReview(sellerId: string, role: string, reviewId: string) {
    const { ratingModel } = this.r;

    const review = await this.findReviewOrThrow(reviewId);
    await this.verifyStoreAccess(review.storeId as string, sellerId, role);

    if (!review.isFlagged)
      throw new BadRequestException('Review is not flagged');

    await ratingModel.findByIdAndUpdate(reviewId, { isFlagged: false });

    return { success: true, message: 'Review unflagged' };
  }

  async moderateDeleteReview(sellerId: string, role: string, reviewId: string) {
    const review = await this.findReviewOrThrow(reviewId);
    await this.verifyStoreAccess(review.storeId as string, sellerId, role);

    await this.r.ratingModel.findByIdAndUpdate(reviewId, { isDelete: true });

    if (review.rating) {
      await this.recalcProductRating(review.productId);
      await this.recalcStoreRating(review.storeId);
    }

    return { success: true, message: 'Review removed' };
  }
}
