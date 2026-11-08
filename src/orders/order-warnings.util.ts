/**
 * Seller order warnings. Computed on read, never stored, never changes an order:
 *  - possible duplicate (same buyer + same store + same product set within 24 h)
 *  - shipping-address warnings (short line, no street/area, bad PK postal code, phone mismatch)
 * COD risk scoring (ai-studio) and checkout validation are separate and untouched.
 */

export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound of candidate orders read by ONE duplicate query. */
export const DUPLICATE_POOL_LIMIT = 500;

export interface WarningReason { code: string; text: string }

// ── Phone ────────────────────────────────────────────────────────────────────

/** Pakistan mobile numbers compare equal in 03xx…, +923xx…, 923xx… and 00923xx… form. Returns null when blank. */
export function normalizePkPhone(raw: unknown): string | null {
  if (raw == null) return null;
  let d = String(raw).replace(/\D+/g, '');
  if (!d) return null;
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length >= 11) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d || null;
}

/** True when the two numbers differ; unknown/blank on either side is NOT a mismatch (nothing to compare). */
export function phonesMismatch(a: unknown, b: unknown): boolean {
  const x = normalizePkPhone(a);
  const y = normalizePkPhone(b);
  if (!x || !y) return false;
  return x !== y;
}

// ── Address ──────────────────────────────────────────────────────────────────

const UNIT_WORDS = new Set([
  'house', 'hno', 'h', 'no', 'number', 'flat', 'plot', 'apartment', 'apt', 'shop', 'room', 'floor', 'unit', 'near', 'opposite', 'pakistan',
]);

export interface AddressInput {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  zipCode?: string | null;
  phoneNumber?: string | null;
}

/** Street/area words left after removing numbers and generic unit words ('House 12' -> none). */
function hasStreetOrArea(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.some(w => w.length >= 3 && !UNIT_WORDS.has(w));
}

export const isValidPkPostal = (zip: unknown) => /^\d{5}$/.test(String(zip ?? '').trim());

export const SHORT_ADDRESS_MIN = 8;

export function addressWarnings(addr: AddressInput | null | undefined, buyerPhone: unknown): WarningReason[] {
  if (!addr) return [];
  const out: WarningReason[] = [];
  const line1 = (addr.addressLine1 ?? '').trim();
  const street = `${line1} ${(addr.addressLine2 ?? '').trim()}`.trim();

  if (line1.length < SHORT_ADDRESS_MIN) {
    out.push({ code: 'short_address', text: 'Address line is very short (under 8 characters).' });
  }
  if (!hasStreetOrArea(street)) {
    out.push({ code: 'no_area', text: 'Address has no street or area name.' });
  }
  if (!isValidPkPostal(addr.zipCode)) {
    out.push({ code: 'bad_postal', text: 'Postal code is not a valid 5-digit Pakistan code.' });
  }
  if (phonesMismatch(buyerPhone, addr.phoneNumber)) {
    out.push({ code: 'phone_mismatch', text: 'Delivery phone is different from the buyer’s account phone.' });
  }
  return out;
}

// ── Possible duplicate ───────────────────────────────────────────────────────

export interface DupCandidate {
  orderId: string;
  orderNumber: string;
  userId: string;
  storeId: string;
  createdAt: number; // epoch ms
  /** Package status; cancelled never counts. */
  status: string;
  /** Sorted, de-duplicated product ids of the package's not-cancelled items. */
  productKey: string;
}

export interface DuplicateRef { orderId: string; orderNumber: string }

const idOf = (v: unknown) => (v == null ? '' : String(v));

/** Shapes a lean order doc into a candidate for ONE store's package; null if the store has no package or no items. */
export function toDupCandidate(order: any, storeId: string): DupCandidate | null {
  if (!order || order.isFreeClaim === true) return null;
  const so = (order.sellerOrders ?? []).find((s: any) => idOf(s.storeId) === storeId);
  if (!so) return null;
  const ids = (so.items ?? [])
    .filter((it: any) => it?.status !== 'cancelled')
    .map((it: any) => idOf(it.productId))
    .filter(Boolean);
  const productKey = Array.from(new Set<string>(ids)).sort().join('|');
  const t = new Date(order.createdAt).getTime();
  if (!productKey || Number.isNaN(t)) return null;
  return {
    orderId: idOf(order._id),
    orderNumber: order.orderNumber ?? '',
    userId: idOf(order.userId),
    storeId,
    createdAt: t,
    status: so.status ?? '',
    productKey,
  };
}

/** Same buyer + store + product set, both live, placed within 24 h of each other (24 h exactly still counts). */
export function isDuplicatePair(a: DupCandidate, b: DupCandidate): boolean {
  if (a.orderId === b.orderId) return false;
  if (a.status === 'cancelled' || b.status === 'cancelled') return false;
  if (a.userId !== b.userId || a.storeId !== b.storeId) return false;
  if (a.productKey !== b.productKey) return false;
  return Math.abs(a.createdAt - b.createdAt) <= DUPLICATE_WINDOW_MS;
}

/** For every target: the closest other order it duplicates (if any). */
export function buildDuplicateMap(targets: DupCandidate[], pool: DupCandidate[]): Map<string, DuplicateRef> {
  const map = new Map<string, DuplicateRef>();
  for (const t of targets) {
    let best: DupCandidate | null = null;
    for (const p of pool) {
      if (!isDuplicatePair(t, p)) continue;
      if (!best || Math.abs(p.createdAt - t.createdAt) < Math.abs(best.createdAt - t.createdAt)) best = p;
    }
    if (best) map.set(t.orderId, { orderId: best.orderId, orderNumber: best.orderNumber });
  }
  return map;
}

/**
 * ONE bounded query for a whole page (or a single order): the buyers' orders in this store around the
 * targets' dates. `orders` are lean order docs already loaded. Never throws: a failure means "no chips".
 */
export async function findPossibleDuplicates(
  orderModel: { find: (f: any) => any },
  orders: any[],
  storeIdFor: (order: any) => string | null,
): Promise<Map<string, DuplicateRef>> {
  try {
    const targets: DupCandidate[] = [];
    for (const o of orders) {
      const sid = storeIdFor(o);
      const c = sid ? toDupCandidate(o, sid) : null;
      if (c && c.status !== 'cancelled') targets.push(c);
    }
    if (!targets.length) return new Map();

    const storeIds = Array.from(new Set(targets.map(t => t.storeId)));
    const userIds = Array.from(new Set(targets.map(t => t.userId)));
    const times = targets.map(t => t.createdAt);
    const from = new Date(Math.min(...times) - DUPLICATE_WINDOW_MS);
    const to = new Date(Math.max(...times) + DUPLICATE_WINDOW_MS);

    const docs: any[] = await orderModel
      .find({
        userId: { $in: userIds },
        'sellerOrders.storeId': { $in: storeIds },
        createdAt: { $gte: from, $lte: to },
        isDelete: false,
        isFreeClaim: { $ne: true },
      })
      .select('orderNumber userId createdAt isFreeClaim sellerOrders.storeId sellerOrders.status sellerOrders.items.productId sellerOrders.items.status')
      .limit(DUPLICATE_POOL_LIMIT)
      .lean();

    const pool: DupCandidate[] = [];
    for (const d of docs) {
      for (const sid of storeIds) {
        const c = toDupCandidate(d, sid);
        if (c) pool.push(c);
      }
    }
    return buildDuplicateMap(targets, pool);
  } catch {
    return new Map();
  }
}

/**
 * Same signal as `findPossibleDuplicates`, but for a view that spans every store
 * on an order (the admin order console) instead of one seller's own stores.
 * Builds one target per (order, store) pair — an order with 3 seller packages
 * yields 3 independent duplicate checks — then runs the same single pooled
 * query as the seller path. Keyed by `${orderId}:${storeId}` so a multi-store
 * order can flag one package as a duplicate without implicating the others.
 */
export async function findPossibleDuplicatesAcrossStores(
  orderModel: { find: (f: any) => any },
  orders: any[],
): Promise<Map<string, DuplicateRef>> {
  try {
    const targets: DupCandidate[] = [];
    for (const o of orders) {
      for (const so of o.sellerOrders ?? []) {
        const sid = idOf(so.storeId);
        if (!sid) continue;
        const c = toDupCandidate(o, sid);
        if (c && c.status !== 'cancelled') targets.push(c);
      }
    }
    if (!targets.length) return new Map();

    const storeIds = Array.from(new Set(targets.map(t => t.storeId)));
    const userIds = Array.from(new Set(targets.map(t => t.userId)));
    const times = targets.map(t => t.createdAt);
    const from = new Date(Math.min(...times) - DUPLICATE_WINDOW_MS);
    const to = new Date(Math.max(...times) + DUPLICATE_WINDOW_MS);

    const docs: any[] = await orderModel
      .find({
        userId: { $in: userIds },
        'sellerOrders.storeId': { $in: storeIds },
        createdAt: { $gte: from, $lte: to },
        isDelete: false,
        isFreeClaim: { $ne: true },
      })
      .select('orderNumber userId createdAt isFreeClaim sellerOrders.storeId sellerOrders.status sellerOrders.items.productId sellerOrders.items.status')
      .limit(DUPLICATE_POOL_LIMIT)
      .lean();

    const pool: DupCandidate[] = [];
    for (const d of docs) {
      for (const sid of storeIds) {
        const c = toDupCandidate(d, sid);
        if (c) pool.push(c);
      }
    }

    // Keyed by (order, store) rather than plain orderId (see `buildDuplicateMap`)
    // so a multi-store order's packages are judged independently.
    const byKey = new Map<string, DuplicateRef>();
    for (const t of targets) {
      let best: DupCandidate | null = null;
      for (const p of pool) {
        if (!isDuplicatePair(t, p)) continue;
        if (!best || Math.abs(p.createdAt - t.createdAt) < Math.abs(best.createdAt - t.createdAt)) best = p;
      }
      if (best) byKey.set(`${t.orderId}:${t.storeId}`, { orderId: best.orderId, orderNumber: best.orderNumber });
    }
    return byKey;
  } catch {
    return new Map();
  }
}

/** Per-item return flags for the seller detail (read straight from the existing order fields). */
export function itemReturnFlags(it: any) {
  return {
    returnStatus: it?.returnStatus ?? 'none',
    returnReason: it?.returnReason ?? null,
    returnRequestedAt: it?.returnRequestedAt ?? null,
    returnRejectReason: it?.returnRejectReason ?? null,
  };
}
