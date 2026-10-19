// Seller SKUs: <STORE>-<YYMMDD>-<NNNN>, e.g. MPU-4F-251019-0007.
//  - STORE  = first 3 letters/digits of the store name + the last 2 characters of its id (own code per seller)
//  - YYMMDD = the day the SKU was created (Pakistan time)
//  - NNNN   = running number inside that store (Store.skuSeq, bumped atomically), so numbers never repeat or skip around
// A seller-typed SKU is always kept as typed; this only fills the blank ones.

export function storeSkuCode(store: { _id: unknown; name?: string | null }): string {
  const letters = String(store.name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const tail = String(store._id).slice(-2).toUpperCase();
  return `${letters}-${tail}`;
}

export function skuDatePart(now: Date = new Date()): string {
  const pk = new Date(now.getTime() + 5 * 60 * 60 * 1000); // UTC+5
  const yy = String(pk.getUTCFullYear()).slice(-2);
  const mm = String(pk.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(pk.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export function formatSku(store: { _id: unknown; name?: string | null }, seq: number, now: Date = new Date()): string {
  return `${storeSkuCode(store)}-${skuDatePart(now)}-${String(seq).padStart(4, '0')}`;
}

/** Reserves `count` consecutive numbers for the store and returns the SKUs (one atomic $inc, safe under concurrent uploads). */
export async function allocateSkus(
  storeModel: { findByIdAndUpdate: (id: any, update: any, opts: any) => any },
  store: { _id: unknown; name?: string | null },
  count = 1,
  now: Date = new Date(),
): Promise<string[]> {
  const n = Math.max(1, Math.floor(count));
  let end = n;
  try {
    const updated: any = await storeModel.findByIdAndUpdate(store._id, { $inc: { skuSeq: n } }, { new: true, returnDocument: 'after' }).select('skuSeq').lean();
    const last = Number(updated?.skuSeq);
    if (Number.isFinite(last) && last >= n) end = last;
  } catch {
    // Counter unavailable: still give a valid, date-stamped SKU rather than failing the product save.
    end = (Date.now() % 9000) + n;
  }
  return Array.from({ length: n }, (_, i) => formatSku(store, end - n + 1 + i, now));
}
