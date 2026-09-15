import type { BusinessType, VerificationDocumentType, VerificationLevel } from './schemas/store.schema';

// ── ONE central source of truth for "what does this seller need to submit?" ──
// Both `StoreService.getVerificationRequirements` (what the frontend renders)
// and `StoreService.submitVerification` (what the backend independently
// re-validates) call the same function here — there is no second copy of
// this logic anywhere, by design (a frontend-only requirement list would be
// a security bypass, see StoreService.submitVerification).

export interface VerificationRequirementSet {
  country: string;
  businessType: BusinessType | null;
  verificationLevel: VerificationLevel;
  /** Dot-paths into the seller's verification data, e.g. 'authorizedContact.email'. */
  requiredFields: string[];
  requiredDocuments: VerificationDocumentType[];
  optionalDocuments: VerificationDocumentType[];
}

const BASIC_REQUIRED_FIELDS = [
  'legalBusinessName', 'businessAddress', 'idDocumentType',
  'authorizedContact.name', 'authorizedContact.email', 'authorizedContact.phone',
];
const BUSINESS_EXTRA_FIELDS = ['registrationNumber', 'taxId'];

const BASIC_REQUIRED_DOCS: VerificationDocumentType[] = ['owner_id', 'address_proof'];
const BUSINESS_EXTRA_DOCS: VerificationDocumentType[] = ['business_registration', 'tax_registration'];
const OPTIONAL_DOCS: VerificationDocumentType[] = ['authorization_proof'];

// Per-country overrides — none are configured yet. Edudeen doesn't have a
// confirmed, real legal requirement that differs by country beyond the ID
// document type a seller already picks (CNIC/passport/national ID), so
// every country currently resolves to the same base rule set below rather
// than inventing an unconfigured jurisdiction's rules. The moment a real
// country-specific requirement is confirmed, it's a one-entry addition
// here (e.g. `AU: { requiredDocuments: [...] }`) — no other code changes.
const COUNTRY_OVERRIDES: Record<string, Partial<Pick<VerificationRequirementSet, 'requiredFields' | 'requiredDocuments' | 'optionalDocuments'>>> = {};

/** Pure function of (country, businessType) — `enhanced` level is
 *  architecturally supported by the type system and this function's
 *  signature, but nothing in Edudeen's real business rules assigns it yet,
 *  so it's never returned here (see determineVerificationLevel). */
export function getVerificationRequirements(country: string, businessType: BusinessType | null, level: VerificationLevel): VerificationRequirementSet {
  const requiredFields = [...BASIC_REQUIRED_FIELDS];
  const requiredDocuments = [...BASIC_REQUIRED_DOCS];
  const optionalDocuments = [...OPTIONAL_DOCS];

  if (level === 'business') {
    requiredFields.push(...BUSINESS_EXTRA_FIELDS);
    requiredDocuments.push(...BUSINESS_EXTRA_DOCS);
  }
  // level === 'enhanced': no additional real requirements exist yet — see
  // module comment above. Falls through to the base set unchanged.

  const override = COUNTRY_OVERRIDES[country];
  return {
    country,
    businessType,
    verificationLevel: level,
    requiredFields: override?.requiredFields ?? requiredFields,
    requiredDocuments: override?.requiredDocuments ?? requiredDocuments,
    optionalDocuments: override?.optionalDocuments ?? optionalDocuments,
  };
}

/** Reads a dot-path (e.g. 'authorizedContact.email') off the verification
 *  data blob and reports whether it's a non-empty value. */
export function isFieldSatisfied(verification: Record<string, any>, path: string): boolean {
  const value = path.split('.').reduce<any>((acc, key) => acc?.[key], verification);
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}
