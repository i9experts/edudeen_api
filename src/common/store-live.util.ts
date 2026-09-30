import { isValidObjectId, type Model } from 'mongoose';

/**
 * A store's public content (banners, pages, blog, theme, products) is only visible while the store itself is live.
 * Several public read services queried by storeId alone, so a pending / rejected / suspended / deleted store's
 * content stayed readable by anyone who knew or enumerated the id. A malformed id is simply "not live".
 */
export async function isStoreLive(
  storeModel: Model<any>,
  storeId: unknown,
): Promise<boolean> {
  if (typeof storeId !== 'string' || !isValidObjectId(storeId)) return false;
  return !!(await storeModel.exists({
    _id: storeId,
    status: 'active',
    isDelete: false,
  }));
}
