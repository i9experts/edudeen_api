/** School-quote terms: payment terms offered by the seller and the buyer's purchase order reference. */
export const NET_TERMS = ['none', 'net_15', 'net_30', 'net_45'] as const;
export type NetTerms = (typeof NET_TERMS)[number];

export const NET_TERMS_LABEL: Record<NetTerms, string> = {
  none: 'Payment on acceptance',
  net_15: 'Net 15 (pay within 15 days)',
  net_30: 'Net 30 (pay within 30 days)',
  net_45: 'Net 45 (pay within 45 days)',
};

export class QuoteTermsError extends Error {}

export function cleanNetTerms(v: unknown): NetTerms {
  if (v === undefined || v === null || v === '') return 'none';
  if (typeof v !== 'string' || !(NET_TERMS as readonly string[]).includes(v)) throw new QuoteTermsError('Choose a valid payment term');
  return v as NetTerms;
}

/** Only files uploaded through Edudeen's own storage may be linked as a purchase order document. */
const PO_URL = /^https:\/\/res\.cloudinary\.com\/[\w.-]+\/[\w\-./%]+$/;

export function cleanPurchaseOrder(input: { purchaseOrderNumber?: unknown; purchaseOrderUrl?: unknown } | null | undefined): { purchaseOrderNumber: string; purchaseOrderUrl: string | null } {
  const num = input?.purchaseOrderNumber;
  if (num !== undefined && num !== null && typeof num !== 'string') throw new QuoteTermsError('PO number must be text');
  const purchaseOrderNumber = ((num as string | undefined) ?? '').replace(/[\u0000-\u001f<>]/g, '').trim();
  if (purchaseOrderNumber.length > 40) throw new QuoteTermsError('PO number can be at most 40 characters');
  const url = input?.purchaseOrderUrl;
  let purchaseOrderUrl: string | null = null;
  if (url !== undefined && url !== null && url !== '') {
    if (typeof url !== 'string' || url.length > 500 || !PO_URL.test(url)) throw new QuoteTermsError('Upload the purchase order file again (the link is not valid)');
    purchaseOrderUrl = url;
  }
  if (!purchaseOrderNumber && !purchaseOrderUrl) throw new QuoteTermsError('Enter a PO number or upload the purchase order');
  return { purchaseOrderNumber, purchaseOrderUrl };
}
