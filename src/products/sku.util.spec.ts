import { allocateSkus, cleanSku, formatSku, skuDatePart, storeSkuCode } from './sku.util';

describe('seller SKUs', () => {
  const store = { _id: '64f0a1b2c3d4e5f6a7b8c94f', name: 'M.Publishers' };
  const day = new Date('2026-10-19T08:00:00Z');

  it('builds a per-store code from the name and id', () => {
    expect(storeSkuCode(store)).toBe('MPU-4F');
    expect(storeSkuCode({ _id: 'abc12', name: '' })).toBe('XXX-12');
  });

  it('uses the Pakistan date (UTC+5)', () => {
    expect(skuDatePart(day)).toBe('261019');
    expect(skuDatePart(new Date('2026-10-19T20:00:00Z'))).toBe('261020');
  });

  it('formats date + 4-digit running number', () => {
    expect(formatSku(store, 7, day)).toBe('MPU-4F-261019-0007');
  });

  it('cleans typed SKUs (no empty segments)', () => {
    expect(cleanSku('UZAIR--001')).toBe('UZAIR-001');
    expect(cleanSku('  -ab  cd_ef- ')).toBe('ab-cd-ef');
    expect(cleanSku('---')).toBe('');
    expect(cleanSku(undefined)).toBe('');
  });

  it('reserves consecutive numbers atomically', async () => {
    const model = { findByIdAndUpdate: jest.fn().mockReturnValue({ select: () => ({ lean: async () => ({ skuSeq: 12 }) }) }) };
    const skus = await allocateSkus(model, store, 3, day);
    expect(skus).toEqual(['MPU-4F-261019-0010', 'MPU-4F-261019-0011', 'MPU-4F-261019-0012']);
    expect(model.findByIdAndUpdate).toHaveBeenCalledWith(store._id, { $inc: { skuSeq: 3 } }, expect.anything());
  });

  it('still returns SKUs if the counter fails', async () => {
    const model = { findByIdAndUpdate: () => { throw new Error('db down'); } };
    const skus = await allocateSkus(model, store, 2, day);
    expect(skus).toHaveLength(2);
    expect(skus[0]).toMatch(/^MPU-4F-261019-\d{4}$/);
  });
});
