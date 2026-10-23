/* eslint-disable prettier/prettier */
import { createHash } from 'crypto';

/** sha256 (hex) of the uploaded proof file - identical screenshots reused for two payments share it. */
export function proofFileHash(buffer: Buffer | undefined | null): string | null {
  return buffer && buffer.length ? createHash('sha256').update(buffer).digest('hex') : null;
}

/** Reference numbers compare ignoring case and spacing/dashes; too short to be meaningful (< 6 chars) = null. */
export function referenceKey(ref: string | null | undefined): string | null {
  const k = (ref ?? '').toUpperCase().replace(/[\s\-_.]/g, '');
  return k.length >= 6 ? k : null;
}

export interface DuplicateHit { proofId: string; reason: 'same_image' | 'same_reference'; status: string; checkoutId: string }

/**
 * Pure matcher: for each proof on the page, which OTHER proofs (different checkout) share its image hash or
 * reference key. Purely advisory - the admin decides.
 */
export function findDuplicates(
  page: { _id: unknown; checkoutId: string; proofHash?: string | null; transactionReferenceKey?: string | null }[],
  candidates: { _id: unknown; checkoutId: string; status: string; proofHash?: string | null; transactionReferenceKey?: string | null }[],
): Map<string, DuplicateHit[]> {
  const out = new Map<string, DuplicateHit[]>();
  for (const p of page) {
    const hits: DuplicateHit[] = [];
    for (const c of candidates) {
      if (String(c._id) === String(p._id) || c.checkoutId === p.checkoutId) continue;
      if (p.proofHash && c.proofHash === p.proofHash) hits.push({ proofId: String(c._id), reason: 'same_image', status: c.status, checkoutId: c.checkoutId });
      else if (p.transactionReferenceKey && c.transactionReferenceKey === p.transactionReferenceKey) hits.push({ proofId: String(c._id), reason: 'same_reference', status: c.status, checkoutId: c.checkoutId });
    }
    if (hits.length) out.set(String(p._id), hits.slice(0, 5));
  }
  return out;
}
