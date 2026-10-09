import { cleanNetTerms, cleanPurchaseOrder, QuoteTermsError } from './quote-terms.util';

describe('cleanNetTerms', () => {
  it('defaults to payment on acceptance', () => {
    expect(cleanNetTerms(undefined)).toBe('none');
    expect(cleanNetTerms('')).toBe('none');
  });
  it('accepts the known terms and rejects anything else', () => {
    expect(cleanNetTerms('net_30')).toBe('net_30');
    expect(() => cleanNetTerms('net_90')).toThrow(QuoteTermsError);
    expect(() => cleanNetTerms(30)).toThrow(QuoteTermsError);
  });
});

describe('cleanPurchaseOrder', () => {
  const ok = 'https://res.cloudinary.com/demo/raw/upload/v1/uploads/documents/po.pdf';
  it('needs a number or a file', () => {
    expect(() => cleanPurchaseOrder({})).toThrow(/PO number or upload/);
    expect(cleanPurchaseOrder({ purchaseOrderNumber: ' PO-2026/17 ' })).toEqual({ purchaseOrderNumber: 'PO-2026/17', purchaseOrderUrl: null });
    expect(cleanPurchaseOrder({ purchaseOrderUrl: ok })).toEqual({ purchaseOrderNumber: '', purchaseOrderUrl: ok });
  });
  it('only links files from our own storage', () => {
    expect(() => cleanPurchaseOrder({ purchaseOrderUrl: 'https://evil.example/po.pdf' })).toThrow(QuoteTermsError);
    expect(() => cleanPurchaseOrder({ purchaseOrderUrl: 'http://res.cloudinary.com/demo/x.pdf' })).toThrow(QuoteTermsError);
    expect(() => cleanPurchaseOrder({ purchaseOrderUrl: 'javascript:alert(1)' })).toThrow(QuoteTermsError);
  });
  it('limits the PO number', () => {
    expect(() => cleanPurchaseOrder({ purchaseOrderNumber: 'x'.repeat(41) })).toThrow(/at most 40/);
    expect(cleanPurchaseOrder({ purchaseOrderNumber: '<b>12</b>' }).purchaseOrderNumber).toBe('b12/b');
  });
});
