/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { paidSeatFilter } from './course.util';

/**
 * Live-class seats. A seat is claimed with ONE conditional update on the product
 * (`seatsTaken + qty <= capacity` and not cancelled), so two buyers can never both
 * take the last seat, however many orders are created at the same moment.
 * Pure functions over the Mongoose models so they can be unit-tested against any Mongo.
 */

export interface SeatLine { productId: string; quantity: number; type?: string }
export interface ClaimedSeat { productId: string; quantity: number }

type ProductModelLike = { find: (...a: any[]) => any; updateOne: (...a: any[]) => any; findOneAndUpdate: (...a: any[]) => any };
type OrderModelLike = { countDocuments: (...a: any[]) => any };

/** Live-class products among the lines (one query). */
async function liveProducts(productModel: ProductModelLike, lines: SeatLine[]): Promise<Map<string, any>> {
  const ids = [...new Set(lines.filter(l => l.type !== 'physical' && l.productId).map(l => String(l.productId)))];
  if (!ids.length || typeof productModel?.find !== 'function') return new Map();
  const rows: any[] = await productModel.find({ _id: { $in: ids }, deliveryFormat: 'live_class' }).select('_id name liveSession.capacity liveSession.seatsTaken liveSession.status').lean();
  return new Map(rows.map(r => [String(r._id), r]));
}

/**
 * Lifts `seatsTaken` up to the number of paid seats when it is lower (classes sold before the counter existed,
 * or edited since). Only ever raises it, so it can never free a seat that is really taken.
 */
async function reconcile(productModel: ProductModelLike, orderModel: OrderModelLike, productId: string) {
  const paid: number = await orderModel.countDocuments(paidSeatFilter(productId));
  if (paid > 0) await productModel.updateOne({ _id: productId, 'liveSession.seatsTaken': { $not: { $gte: paid } } }, { $set: { 'liveSession.seatsTaken': paid } });
}

/**
 * Atomically claims a seat per live-class line. If any line is full (or the class was cancelled),
 * every seat claimed so far is given back and a BadRequestException is thrown.
 * Call it once per order creation (createOrder already returns existing orders for a checkout, so retries do not claim twice).
 */
export async function claimLiveSeats(productModel: ProductModelLike, orderModel: OrderModelLike, lines: SeatLine[]): Promise<ClaimedSeat[]> {
  const live = await liveProducts(productModel, lines);
  if (!live.size) return [];
  const claimed: ClaimedSeat[] = [];
  for (const line of lines) {
    const product = live.get(String(line.productId));
    if (!product || line.type === 'physical') continue;
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    const capacity = product.liveSession?.capacity ?? null;
    if (capacity) await reconcile(productModel, orderModel, String(product._id));
    const filter: any = { _id: product._id, deliveryFormat: 'live_class', 'liveSession.status': { $ne: 'cancelled' } };
    if (capacity) filter.$expr = { $lte: [{ $add: [{ $ifNull: ['$liveSession.seatsTaken', 0] }, qty] }, '$liveSession.capacity'] };
    const won = await productModel.findOneAndUpdate(filter, { $inc: { 'liveSession.seatsTaken': qty } }, { returnDocument: 'after' }).select('_id').lean();
    if (!won) {
      await releaseLiveSeats(productModel, claimed.map(c => ({ ...c, type: 'digital' })), true);
      throw new BadRequestException(product.liveSession?.status === 'cancelled'
        ? `"${product.name}" was cancelled`
        : `"${product.name}" is full - no seats left`);
    }
    claimed.push({ productId: String(product._id), quantity: qty });
  }
  return claimed;
}

/** Gives seats back (cancelled / refunded order, failed order creation). Never goes below zero. `known` skips the product lookup. */
export async function releaseLiveSeats(productModel: ProductModelLike, lines: SeatLine[], known = false): Promise<void> {
  const live = known ? new Map(lines.map(l => [String(l.productId), true])) : await liveProducts(productModel, lines);
  for (const line of lines) {
    if (!live.has(String(line.productId)) || line.type === 'physical') continue;
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    await productModel.updateOne({ _id: line.productId, 'liveSession.seatsTaken': { $gte: qty } }, { $inc: { 'liveSession.seatsTaken': -qty } });
  }
}

/** Seats in use: the larger of the atomic counter and the paid-order count (classes sold before the counter existed). */
export const capacityUsed = (seatsTaken: number | null | undefined, paidCount: number) => Math.max(Number(seatsTaken) || 0, paidCount);

/** Seats still free: capacity minus the larger of the atomic counter and the paid-order count. null = unlimited. */
export function seatsLeft(capacity: number | null | undefined, seatsTaken: number | null | undefined, paidCount: number): number | null {
  if (!capacity) return null;
  return Math.max(0, capacity - Math.max(Number(seatsTaken) || 0, paidCount));
}
