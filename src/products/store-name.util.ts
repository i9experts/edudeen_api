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
