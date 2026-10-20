/* eslint-disable prettier/prettier */
import { listingApprovalRequired } from './product-input.util';

// Fields a seller can change on a live listing WITHOUT admin review (price / offers / visibility are handled by their own rules).
export const EDIT_IMMEDIATE_KEYS = ['status', 'scheduledAt', 'isListedOnEdudeen', 'campaignIds', 'premiumDiscountPercent', 'premiumOptOut'];

const LIVE = ['active', 'scheduled'];

const same = (a: unknown, b: unknown) => {
  try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); } catch { return false; }
};

/** True for an admin-approved listing that is live right now (its edits wait for approval). */
export function holdsEditsForReview(product: { status?: string | null; approvedAt?: Date | null }): boolean {
  return listingApprovalRequired() && (!!product.approvedAt || LIVE.includes(String(product.status))) && LIVE.includes(String(product.status));
}

/**
 * An approved listing that stays/goes live: content edits wait for the admin instead of changing what buyers see.
 * `held` only has keys whose value really differs from the live product (the edit form re-sends every field).
 */
export function splitEditForReview(
  product: { status?: string | null; approvedAt?: Date | null } & Record<string, unknown>,
  update: Record<string, unknown>,
): { immediate: Record<string, unknown>; held: Record<string, unknown>; hold: boolean } {
  const nextStatus = (update.status as string | undefined) ?? product.status ?? '';
  const approved = !!product.approvedAt || LIVE.includes(String(product.status));
  const hold = listingApprovalRequired() && approved && LIVE.includes(nextStatus);
  if (!hold) return { immediate: update, held: {}, hold: false };
  const immediate: Record<string, unknown> = {};
  const held: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(update)) {
    if (EDIT_IMMEDIATE_KEYS.includes(k)) immediate[k] = v;
    else if (!same(v, product[k])) held[k] = v;
  }
  return { immediate, held, hold: true };
}

/** The seller sees their own submitted edit in the form (the live fields are unchanged for buyers). */
export function overlayPendingEdit<T extends Record<string, any>>(product: T): T & { pendingEditInfo: { submittedAt: Date; fields: string[] } | null } {
  const pe = product?.pendingEdit as { changes?: Record<string, unknown>; submittedAt: Date; fields?: string[] } | null | undefined;
  const base: any = { ...product };
  delete base.pendingEdit;
  if (pe?.changes) Object.assign(base, pe.changes);
  delete base.__price; // variant-level; applied to the variant view by the caller
  delete base.__compareAtPrice;
  delete base.__variants;
  base.pendingEditInfo = pe?.changes ? { submittedAt: pe.submittedAt, fields: pe.fields ?? Object.keys(pe.changes) } : null;
  return base;
}

const LABELS: Record<string, string> = {
  name: 'Title', description: 'Description', images: 'Photos', tags: 'Tags', categoryId: 'Category', subCategoryId: 'Subcategory',
  educationLevel: 'Education level', customLevel: 'Custom level', digital: 'Files & delivery settings', classFrom: 'Class from', classTo: 'Class to',
  ageMin: 'Age from', ageMax: 'Age to', curricula: 'Curricula', deliveryFormat: 'Delivery format',
};
const HIDDEN = new Set(['slug', 'previousSlugs', 'normalizedCustomLevel', 'flags', 'contactMatches', 'flagReason']);

export const editFieldLabel = (k: string) => LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const text = (v: unknown): string => {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** Before / after rows for the admin review modal. */
export function buildEditDiff(
  product: Record<string, any>,
  changes: Record<string, unknown>,
  names: { category?: string; subCategory?: string; variant?: { price?: number | null; compareAtPrice?: number | null; currency?: string } | null; variants?: any[] } = {},
): Array<{ key: string; label: string; kind: 'text' | 'images' | 'files'; before: unknown; after: unknown }> {
  const rows: Array<{ key: string; label: string; kind: 'text' | 'images' | 'files'; before: unknown; after: unknown }> = [];
  for (const [k, after] of Object.entries(changes)) {
    if (HIDDEN.has(k)) continue;
    if (k === '__variants') {
      const cur = names.variant?.currency ?? '';
      const money = (v: unknown) => (v == null ? '—' : `${cur} ${Number(v).toLocaleString()}`.trim());
      for (const [vid, ch] of Object.entries((after ?? {}) as Record<string, { price?: number; compareAtPrice?: number | null }>)) {
        const v: any = (names.variants ?? []).find((x: any) => String(x._id) === vid);
        const opts = (v?.options ?? []).map((o: any) => o.value).join(' / ');
        const tag = opts ? ` (${opts})` : '';
        if (ch.price !== undefined) rows.push({ key: `${vid}.price`, label: `Price${tag}`, kind: 'text', before: money(v?.price), after: money(ch.price) });
        if ('compareAtPrice' in ch) rows.push({ key: `${vid}.compareAtPrice`, label: `Compare-at price${tag}`, kind: 'text', before: money(v?.compareAtPrice), after: money(ch.compareAtPrice) });
      }
      continue;
    }
    if (k === '__price' || k === '__compareAtPrice') {
      const cur = names.variant?.currency ?? '';
      const money = (v: unknown) => (v == null ? '—' : `${cur} ${Number(v).toLocaleString()}`.trim());
      rows.push({ key: k, label: k === '__price' ? 'Price' : 'Compare-at price', kind: 'text', before: money(k === '__price' ? names.variant?.price : names.variant?.compareAtPrice), after: money(after) });
      continue;
    }
    const before = product[k];
    if (k === 'images') { rows.push({ key: k, label: editFieldLabel(k), kind: 'images', before: before ?? [], after: after ?? [] }); continue; }
    if (k === 'digital') {
      const files = (d: any) => (d?.files ?? []).map((f: any) => f?.name).filter(Boolean);
      const settings = (d: any) => d ? `License: ${d.licenseType ?? '—'} · Downloads: ${d.downloadLimit ?? '—'} · PDF stamping: ${d.pdfStampingEnabled ? 'on' : 'off'} · Preview: ${d.preview?.enabled ? 'on' : 'off'} · Free sample: ${d.sampleFile?.name ?? 'none'}` : '—';
      rows.push({ key: 'digital.files', label: 'Files buyers get', kind: 'files', before: files(before), after: files(after) });
      rows.push({ key: 'digital.settings', label: 'Delivery settings', kind: 'text', before: settings(before), after: settings(after as any) });
      continue;
    }
    const label = editFieldLabel(k);
    if (k === 'categoryId' && names.category) { rows.push({ key: k, label, kind: 'text', before: text(before), after: names.category }); continue; }
    if (k === 'subCategoryId' && names.subCategory) { rows.push({ key: k, label, kind: 'text', before: text(before), after: names.subCategory }); continue; }
    rows.push({ key: k, label, kind: 'text', before: text(before), after: text(after) });
  }
  return rows;
}
