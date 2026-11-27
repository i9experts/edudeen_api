/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { encryptSeoCredential, decryptSeoCredential } from 'src/common/seo-token-encryption.util';

export const KYC_STATUSES = ['not_started', 'pending', 'approved', 'rejected'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const KYC_SELLER_TYPES = ['individual', 'company'] as const;
export type KycSellerType = (typeof KYC_SELLER_TYPES)[number];

export const KYC_ID_TYPES = ['cnic', 'passport', 'national_id', 'driving_licence'] as const;
export type KycIdType = (typeof KYC_ID_TYPES)[number];

export const KYC_DOCUMENT_TYPES = ['id_front', 'id_back', 'registration_certificate', 'bank_proof'] as const;
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

/** Shown wherever a payout is refused because the seller is not verified yet. */
export const KYC_PAYOUT_BLOCK_MESSAGE = 'Complete identity verification (KYC) to withdraw your earnings.';

// draft → pending (submit) → approved | rejected; rejected → pending (resubmit); approved → rejected (admin revoke).
const TRANSITIONS: Record<KycStatus, KycStatus[]> = {
  not_started: ['pending'],
  pending: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: ['pending'],
};

export function assertKycTransition(from: KycStatus, to: KycStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new BadRequestException(`Verification cannot move from "${from}" to "${to}".`);
  }
}

/** The seller can only change their details while drafting or after a rejection. */
export function isKycEditable(status: KycStatus): boolean {
  return status === 'not_started' || status === 'rejected';
}

export interface KycDraftShape {
  sellerType?: KycSellerType | null;
  address?: { country?: string | null; state?: string | null; city?: string | null; line?: string | null } | null;
  idType?: KycIdType | null;
  fullName?: string | null;
  idNumberEnc?: string | null;
  taxNumberEnc?: string | null;
  legalBusinessName?: string | null;
  registrationNumber?: string | null;
  bankAccountHolder?: string | null;
  bankName?: string | null;
  documents?: { type: KycDocumentType }[];
}

/** Everything still missing before this KYC can be submitted (empty = ready). The backend's own copy — never trust the form. */
export function missingKycRequirements(k: KycDraftShape): string[] {
  const missing: string[] = [];
  const has = (v?: string | null) => typeof v === 'string' && v.trim().length > 0;
  const docs = new Set((k.documents ?? []).map((d) => d.type));
  const company = k.sellerType === 'company';

  if (!k.sellerType) missing.push('Seller type');
  if (!has(k.address?.country)) missing.push('Country');
  if (!has(k.address?.state)) missing.push('Province / state');
  if (!has(k.address?.city)) missing.push('City');
  if (!has(k.address?.line)) missing.push('Address');
  if (!k.idType) missing.push('ID type');
  if (!docs.has('id_front')) missing.push('ID front photo');
  // A passport has a single photo page.
  if (k.idType !== 'passport' && !docs.has('id_back')) missing.push('ID back photo');
  if (!has(k.fullName)) missing.push('Full name (as on ID)');
  if (!has(k.idNumberEnc)) missing.push('ID / passport number');
  if (company) {
    if (!has(k.taxNumberEnc)) missing.push('National tax number');
    if (!has(k.legalBusinessName)) missing.push('Legal business name');
    if (!has(k.registrationNumber)) missing.push('Registration number');
    if (!docs.has('registration_certificate')) missing.push('Registration certificate');
  }
  if (!has(k.bankAccountHolder)) missing.push('Bank account holder name');
  if (!docs.has('bank_proof')) missing.push('Bank statement or cheque');
  return missing;
}

/** "ab12345678" → "••••5678". Never returns more than the last 4 characters. */
export function maskTail(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const tail = plain.slice(-4);
  return `••••${tail}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Same loose rule as payout methods: equal, or one contains the other (ignores case, dots, extra spaces). */
export function namesRoughlyMatch(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return true;
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

// Same key chain as payout account numbers (FinanceService): a dedicated key if set, else JWT_SECRET.
const keyCandidates = () => [process.env.PAYOUT_ENCRYPTION_KEY, process.env.SEO_TOKEN_ENCRYPTION_KEY, process.env.JWT_SECRET]
  .filter((k, i, a): k is string => !!k && a.indexOf(k) === i);

export function encryptKycValue(plain: string): string {
  const [key] = keyCandidates();
  if (!key) throw new BadRequestException('Server encryption key is not configured — contact support.');
  return encryptSeoCredential(plain, key);
}

export function decryptKycValue(payload: string | null | undefined): string | null {
  if (!payload) return null;
  for (const key of keyCandidates()) {
    try { return decryptSeoCredential(payload, key); } catch { /* try the next key */ }
  }
  return null;
}
