/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { UploadedAssetsService } from '../upload/uploaded-assets.service';
import { assertSellerStatus, parseScheduledAt, cleanDigitalSettings, assertStringArray } from './product-input.util';

describe('product-input.util', () => {
  const now = new Date('2026-10-01T00:00:00Z');

  it('parseScheduledAt: rejects missing, invalid, past and >1 year dates; accepts a near-future date', () => {
    expect(() => parseScheduledAt(undefined, now)).toThrow(/required/);
    expect(() => parseScheduledAt('garbage', now)).toThrow(/valid date/);
    expect(() => parseScheduledAt('2026-09-01T00:00:00Z', now)).toThrow(/future/);
    expect(() => parseScheduledAt('2028-01-01T00:00:00Z', now)).toThrow(/within one year/);
    expect(parseScheduledAt('2026-10-15T00:00:00Z', now).toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('assertSellerStatus only allows the schema statuses', () => {
    for (const ok of ['active', 'inactive', 'draft', 'scheduled']) expect(() => assertSellerStatus(ok)).not.toThrow();
    for (const bad of ['foo', '', null, { $ne: 'x' }, 5]) expect(() => assertSellerStatus(bad)).toThrow(BadRequestException);
  });

  it('cleanDigitalSettings bounds linkExpiryDays (was: 0, negatives, NaN, 1e9 accepted on edit)', () => {
    for (const bad of [0, -3, 1.5, 4000, NaN, 1e9, '7', {}]) {
      expect(() => cleanDigitalSettings({ linkExpiryDays: bad })).toThrow(/linkExpiryDays/);
    }
    expect(cleanDigitalSettings({ linkExpiryDays: 30 }).linkExpiryDays).toBe(30);
    expect(cleanDigitalSettings({ linkExpiryDays: null }).linkExpiryDays).toBeNull();
  });

  it('cleanDigitalSettings validates enums and caps the delivery message, dropping unknown/server-managed keys', () => {
    expect(() => cleanDigitalSettings({ downloadLimit: '99' })).toThrow(/downloadLimit/);
    expect(() => cleanDigitalSettings({ licenseType: 'free-for-all' })).toThrow(/licenseType/);
    expect(() => cleanDigitalSettings({ buyerDeliveryMessage: 'x'.repeat(2001) })).toThrow(/at most 2000/);
    const out = cleanDigitalSettings({ preview: { enabled: true, sourceFileIndex: 1, previewSourcePublicId: 'private/victim/file' }, isFeatured: true } as any);
    expect(out.preview).toEqual({ enabled: true, sourceFileIndex: 1 }); // previewSource* can never be forged
    expect(out).not.toHaveProperty('isFeatured');
  });

  it('edits keep existing settings that the request does not mention', () => {
    const out = cleanDigitalSettings({}, { downloadLimit: '3' as any, linkExpiryDays: 14, licenseType: 'school' as any, pdfStampingEnabled: true, buyerDeliveryMessage: 'hi' });
    expect(out).toMatchObject({ downloadLimit: '3', linkExpiryDays: 14, licenseType: 'school', pdfStampingEnabled: true, buyerDeliveryMessage: 'hi' });
  });

  it('assertStringArray rejects non-strings, blanks, oversize items and too many items', () => {
    const o = { maxItems: 3, maxLength: 5 };
    expect(() => assertStringArray('x', 'tags', o)).toThrow(/array/);
    expect(() => assertStringArray([1], 'tags', o)).toThrow();
    expect(() => assertStringArray([' '], 'tags', o)).toThrow();
    expect(() => assertStringArray(['toolong'], 'tags', o)).toThrow();
    expect(() => assertStringArray(['a', 'b', 'c', 'd'], 'tags', o)).toThrow(/at most 3/);
    expect(assertStringArray(['a', 'b'], 'tags', o)).toEqual(['a', 'b']);
  });
});

describe('UploadedAssetsService.assertOwned', () => {
  const build = (row: any) => {
    const model: any = { findOne: () => ({ lean: async () => row }) };
    return new UploadedAssetsService({ repositories: { uploadedAssetModel: model } } as any);
  };

  it('accepts a file the caller uploaded and returns the trusted facts', async () => {
    const svc = build({ ownerId: 'sellerA', resourceType: 'raw', mimeType: 'application/pdf', fileSize: 123, fileName: 'a.pdf' });
    await expect(svc.assertOwned('sellerA', 'private/digital-products/a', 'digital_product')).resolves.toMatchObject({ mimeType: 'application/pdf', fileSize: 123 });
  });

  it("rejects another seller's file", async () => {
    const svc = build({ ownerId: 'sellerB', resourceType: 'raw', mimeType: null, fileSize: null, fileName: null });
    await expect(svc.assertOwned('sellerA', 'private/digital-products/b', 'digital_product')).rejects.toThrow(/not uploaded by you/);
  });

  it('rejects an untracked id unless it is already part of the same record (legacy data keeps working)', async () => {
    const svc = build(null);
    await expect(svc.assertOwned('sellerA', 'private/digital-products/x', 'digital_product')).rejects.toThrow(/Unknown file/);
    await expect(svc.assertOwned('sellerA', 'private/digital-products/x', 'digital_product', { alreadyReferenced: true })).resolves.toBeNull();
  });

  it('a product file can never point into the KYC / payment-proof / preview-source folders — even if tracked and owned', async () => {
    const svc = build({ ownerId: 'sellerA', resourceType: 'raw' });
    for (const folder of ['private/kyc-documents/id', 'private/payment-proofs/p', 'private/digital-preview-sources/s']) {
      await expect(svc.assertOwned('sellerA', folder, 'digital_product', { alreadyReferenced: true })).rejects.toThrow(/cannot be used here/);
    }
  });

  it('a KYC document must live in the KYC folder and be owned by the seller', async () => {
    const svc = build({ ownerId: 'sellerA', resourceType: 'raw' });
    await expect(svc.assertOwned('sellerA', 'private/digital-products/paid-file', 'kyc_document')).rejects.toThrow(/verification document/);
    await expect(svc.assertOwned('sellerA', 'private/kyc-documents/id', 'kyc_document')).resolves.toBeDefined();
  });

  it('non-string / empty ids are rejected without touching the database', async () => {
    const svc = build({ ownerId: 'sellerA' });
    for (const bad of [undefined, null, '', { $ne: null }, 5]) await expect(svc.assertOwned('sellerA', bad, 'digital_product')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProductsService digital config + sub-category', () => {
  const make = (row: any, sub: any = null) => {
    const assets = build(row);
    const svc: any = Object.create(ProductsService.prototype);
    svc.uploadedAssets = assets;
    svc.databaseService = { repositories: { categoryModel: { findOne: jest.fn().mockResolvedValue(sub) } } };
    svc.prepareDigitalPreview = jest.fn().mockImplementation(async (_e: unknown, d: unknown) => d);
    return svc;
    function build(r: any) { return new UploadedAssetsService({ repositories: { uploadedAssetModel: { findOne: () => ({ lean: async () => r }) } } } as any); }
  };

  it("a seller cannot attach another seller's private file, and the client's mimeType is ignored", async () => {
    const svc = make({ ownerId: 'sellerB', resourceType: 'raw', mimeType: 'application/pdf' });
    await expect(svc.buildDigitalConfig('sellerA', { files: [{ url: 'private/digital-products/b', name: 'x.pdf', mimeType: 'image/png' }] }, null)).rejects.toThrow(/not uploaded by you/);
  });

  it('an owned file is stored with the SERVER-recorded mime type and size, not the client-supplied ones', async () => {
    const svc = make({ ownerId: 'sellerA', resourceType: 'raw', mimeType: 'application/pdf', fileSize: 5000 });
    const out = await svc.buildDigitalConfig('sellerA', { files: [{ url: 'private/digital-products/a', name: 'a.pdf', mimeType: 'image/png', size: 1 }] }, null);
    expect(out.files[0]).toEqual({ url: 'private/digital-products/a', name: 'a.pdf', size: 5000, mimeType: 'application/pdf' });
  });

  it('an edit that leaves an existing legacy (untracked) file in place keeps working', async () => {
    const svc = make(null);
    const existing = { files: [{ url: 'private/digital-products/old', name: 'old.pdf', size: 9, mimeType: 'application/pdf' }], linkExpiryDays: 7 };
    const out = await svc.buildDigitalConfig('sellerA', { linkExpiryDays: 30 }, existing);
    expect(out.files).toEqual(existing.files);
    expect(out.linkExpiryDays).toBe(30);
  });

  it('rejects more than 30 files and a non-object digital value', async () => {
    const svc = make({ ownerId: 'sellerA', resourceType: 'raw' });
    await expect(svc.buildDigitalConfig('sellerA', { files: Array.from({ length: 31 }, (_, i) => ({ url: `f${i}`, name: 'n' })) }, null)).rejects.toThrow(/at most 30/);
    await expect(svc.buildDigitalConfig('sellerA', 'oops', null)).rejects.toThrow(/must be an object/);
  });

  it('subCategoryId must be an active child of the product\'s root category', async () => {
    const good = make(null, { _id: '64f0c0ffee0c0ffee0c0ff01' });
    await expect(good.resolveSubCategoryId('root1', '64f0c0ffee0c0ffee0c0ff01')).resolves.toBe('64f0c0ffee0c0ffee0c0ff01');
    expect(good.databaseService.repositories.categoryModel.findOne).toHaveBeenCalledWith({ _id: '64f0c0ffee0c0ffee0c0ff01', parentId: 'root1', status: 'active', isDelete: false });
    const bad = make(null, null);
    await expect(bad.resolveSubCategoryId('root1', '64f0c0ffee0c0ffee0c0ff02')).rejects.toThrow(/active subcategory/);
    await expect(bad.resolveSubCategoryId('root1', 'not-an-id')).rejects.toThrow(/valid category id/);
    await expect(bad.resolveSubCategoryId('root1', { $ne: null })).rejects.toThrow(BadRequestException);
    await expect(bad.resolveSubCategoryId('root1', null)).resolves.toBeNull();
  });
});
