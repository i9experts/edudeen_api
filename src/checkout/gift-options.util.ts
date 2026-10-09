/** Gift options a buyer can add to a physical order: a short note and gift wrapping (free). */
export const GIFT_MESSAGE_MAX = 300;

export interface GiftOptions {
  giftMessage: string | null;
  giftWrap: boolean;
}

export class GiftOptionsError extends Error {}

/** Validates + cleans buyer input: control characters and angle brackets are removed, length is capped. */
export function sanitizeGiftOptions(input: { giftMessage?: unknown; giftWrap?: unknown } | null | undefined): GiftOptions {
  const rawMsg = input?.giftMessage;
  if (rawMsg !== undefined && rawMsg !== null && typeof rawMsg !== 'string') throw new GiftOptionsError('Gift message must be text');
  if (input?.giftWrap !== undefined && typeof input.giftWrap !== 'boolean') throw new GiftOptionsError('giftWrap must be true or false');
  const cleaned = (rawMsg ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .trim();
  if (cleaned.length > GIFT_MESSAGE_MAX) throw new GiftOptionsError(`Gift message can be at most ${GIFT_MESSAGE_MAX} characters`);
  return { giftMessage: cleaned || null, giftWrap: input?.giftWrap === true };
}
