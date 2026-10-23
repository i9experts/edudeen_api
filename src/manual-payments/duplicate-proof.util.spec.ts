import { findDuplicates, proofFileHash, referenceKey } from './duplicate-proof.util';

describe('duplicate proof detection (advisory)', () => {
  it('hashes identical bytes to the same value and different bytes differently', () => {
    expect(proofFileHash(Buffer.from('abc'))).toBe(proofFileHash(Buffer.from('abc')));
    expect(proofFileHash(Buffer.from('abc'))).not.toBe(proofFileHash(Buffer.from('abd')));
    expect(proofFileHash(undefined)).toBeNull();
    expect(proofFileHash(Buffer.alloc(0))).toBeNull();
  });

  it('normalises references (case, spaces, dashes) and ignores ones too short to mean anything', () => {
    expect(referenceKey(' ab-12 34 cd ')).toBe('AB1234CD');
    expect(referenceKey('12345')).toBeNull();
    expect(referenceKey(null)).toBeNull();
  });

  const page = [{ _id: 'p1', checkoutId: 'c1', proofHash: 'H', transactionReferenceKey: 'REF123' }];

  it('flags another checkout that uses the same image or reference', () => {
    const hits = findDuplicates(page, [
      { _id: 'p2', checkoutId: 'c2', status: 'approved', proofHash: 'H' },
      { _id: 'p3', checkoutId: 'c3', status: 'pending', transactionReferenceKey: 'REF123' },
      { _id: 'p4', checkoutId: 'c4', status: 'pending', proofHash: 'OTHER' },
    ]);
    expect(hits.get('p1')).toEqual([
      { proofId: 'p2', reason: 'same_image', status: 'approved', checkoutId: 'c2' },
      { proofId: 'p3', reason: 'same_reference', status: 'pending', checkoutId: 'c3' },
    ]);
  });

  it('never flags itself or a proof from the same checkout (a re-upload is not a duplicate)', () => {
    const hits = findDuplicates(page, [
      { _id: 'p1', checkoutId: 'c1', status: 'pending', proofHash: 'H' },
      { _id: 'p9', checkoutId: 'c1', status: 'rejected', proofHash: 'H' },
    ]);
    expect(hits.size).toBe(0);
  });
});
