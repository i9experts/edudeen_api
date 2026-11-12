import { publicHoliday } from '../store/store-holiday.util';

/**
 * storeId -> public holiday ({enabled, returnDate, message, digitalStillSells}) for the stores of a page that are
 * on holiday right now. One query per page; stores without a holiday are simply absent.
 */
export async function resolveStoreHolidays(
  storeModel: { find: (filter: any) => { select: (f: string) => { lean: () => Promise<any[]> } } },
  storeIds: Array<string | null | undefined>,
): Promise<Map<string, NonNullable<ReturnType<typeof publicHoliday>>>> {
  const ids = [...new Set(storeIds.filter((id): id is string => !!id).map(String))];
  const out = new Map<string, NonNullable<ReturnType<typeof publicHoliday>>>();
  if (!ids.length) return out;
  const stores = await storeModel.find({ _id: { $in: ids }, 'holiday.enabled': true } as any).select('holiday').lean();
  for (const s of stores) {
    const h = publicHoliday(s);
    if (h) out.set(String(s._id), h);
  }
  return out;
}

/**
 * Batch-resolves store names for a page of products with ONE query
 * (never one per product). Returns storeId -> name; unknown ids are absent.
 */
export async function resolveStoreNames(
  storeModel: { find: (filter: any) => { select: (f: string) => { lean: () => Promise<any[]> } } },
  storeIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(storeIds.filter((id): id is string => !!id).map(String))];
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const stores = await storeModel.find({ _id: { $in: ids } }).select('name').lean();
  for (const s of stores) {
    if (s?.name) names.set(String(s._id), s.name);
  }
  return names;
}
