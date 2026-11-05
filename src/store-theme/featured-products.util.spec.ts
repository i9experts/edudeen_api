import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { assertFeaturedOwned, normalizeFeaturedIds, publishedHighlights } from './featured-products.util';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);
const STORE = '1'.repeat(24);
const OTHER = '2'.repeat(24);
const row = (id: string, over: Record<string, unknown> = {}) => ({ _id: id, storeId: STORE, status: 'active', isDelete: false, isTest: false, ...over });

describe('featured products', () => {
  it('keeps order and drops duplicates', () => {
    expect(normalizeFeaturedIds([B, A, B])).toEqual([B, A]);
  });
  it('rejects bad ids and more than 8', () => {
    expect(() => normalizeFeaturedIds(['nope'])).toThrow(BadRequestException);
    expect(() => normalizeFeaturedIds(Array.from({ length: 9 }, (_, i) => String(i).repeat(24).slice(0, 24)))).toThrow(BadRequestException);
  });
  it("another seller's product = 403", () => {
    expect(() => assertFeaturedOwned([A, B], [row(A), row(B, { storeId: OTHER })], STORE)).toThrow(ForbiddenException);
  });
  it('unknown product = 403 (same answer as foreign)', () => {
    expect(() => assertFeaturedOwned([A, C], [row(A)], STORE)).toThrow(ForbiddenException);
  });
  it('own but inactive / test / deleted = 400', () => {
    for (const over of [{ status: 'draft' }, { isTest: true }, { isDelete: true }]) {
      expect(() => assertFeaturedOwned([A], [row(A, over)], STORE)).toThrow(BadRequestException);
    }
  });
  it('own active products pass', () => {
    expect(() => assertFeaturedOwned([A, B], [row(A), row(B)], STORE)).not.toThrow();
  });
  it('published config: legacy pinned list only when nothing was ever published', () => {
    expect(publishedHighlights(undefined, [A, B])).toEqual({ featuredProductIds: [A, B], showNewArrivals: false, showBestSellers: false });
    expect(publishedHighlights({ featuredProductIds: [], showNewArrivals: true }, [A])).toEqual({ featuredProductIds: [], showNewArrivals: true, showBestSellers: false });
  });
});
