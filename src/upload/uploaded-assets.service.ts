/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import type { UploadedAssetKind } from './schemas/uploaded-asset.schema';
import { stripStorageId } from './r2.util';

/** Folders that must NEVER be referenced as a product file, whatever the client claims. */
const NEVER_A_PRODUCT_FILE = [
  'private/kyc-documents',
  'private/payment-proofs',
  'private/digital-preview-sources',
];

@Injectable()
export class UploadedAssetsService {
  constructor(private readonly db: DatabaseService) {}

  private get model() {
    return this.db.repositories.uploadedAssetModel;
  }

  async record(input: {
    publicId: string;
    ownerId: string;
    ownerRole: string;
    kind: UploadedAssetKind;
    resourceType: string;
    fileName?: string | null;
    fileSize?: number | null;
    mimeType?: string | null;
  }) {
    await this.model.updateOne(
      { publicId: input.publicId },
      {
        $setOnInsert: {
          ...input,
          fileName: input.fileName ?? null,
          fileSize: input.fileSize ?? null,
          mimeType: input.mimeType ?? null,
        },
      },
      { upsert: true },
    );
  }

  /**
   * Where a private file can be in use: any product's digital files / free sample / preview source (deleted products
   * included - past buyers still download through them) and any course lesson file.
   */
  async isReferenced(publicId: string): Promise<boolean> {
    const { productModel, courseModel } = this.db.repositories;
    const [product, course] = await Promise.all([
      productModel.exists({ $or: [{ 'digital.files.url': publicId }, { 'digital.sampleFile.url': publicId }, { 'digital.preview.previewSourceUrl': publicId }] }),
      courseModel.exists({ 'sections.lessons.file.url': publicId }),
    ]);
    return !!product || !!course;
  }

  /**
   * Owner-scoped delete of an UNUSED private upload (test / abandoned uploads). Only the uploader, only product files
   * (verification documents are never deleted here), and never while a product or course references it (409). The
   * ownership row goes first so the file cannot be newly referenced while it is being deleted; it is put back if a
   * reference appeared meanwhile or storage refuses. Returns the deleted row's facts for the audit entry.
   */
  async deleteOwnedUnreferenced(
    ownerId: string,
    publicId: unknown,
    removeFromStorage: (publicId: string, resourceType: string) => Promise<void>,
  ): Promise<{ publicId: string; fileName: string | null; fileSize: number | null }> {
    if (typeof publicId !== 'string' || !publicId.trim() || publicId.length > 500) throw new BadRequestException('publicId is required');
    const row: any = await this.model.findOne({ publicId }).lean();
    // Someone else's file answers exactly like a missing one (no probing other sellers' uploads).
    if (!row || row.ownerId !== ownerId) throw new NotFoundException('File not found');
    if (row.kind !== 'digital_product') throw new BadRequestException('This file cannot be deleted here');
    const inUse = new ConflictException('This file is used by a product or course. Remove it there first.');
    if (await this.isReferenced(publicId)) throw inUse;
    const { _id, ...restore } = row;
    await this.model.deleteOne({ publicId, ownerId });
    const putBack = () => this.model.updateOne({ publicId }, { $setOnInsert: restore }, { upsert: true }).catch(() => undefined);
    if (await this.isReferenced(publicId)) {
      await putBack();
      throw inUse;
    }
    try {
      await removeFromStorage(publicId, row.resourceType ?? 'raw');
    } catch {
      await putBack();
      throw new ConflictException('The file could not be deleted from storage right now. Please try again.');
    }
    return { publicId, fileName: row.fileName ?? null, fileSize: row.fileSize ?? null };
  }

  /** True only for an asset this owner uploaded for this purpose. */
  async isOwnedBy(
    ownerId: string,
    publicId: string,
    kind: UploadedAssetKind,
  ): Promise<boolean> {
    if (typeof publicId !== 'string' || !publicId) return false;
    return !!(await this.model.exists({ publicId, ownerId, kind }));
  }

  /**
   * Validates a client-supplied publicId before it is stored as a reference. Returns the trusted
   * server-side facts (resourceType, mime type, size, name) so callers can overwrite whatever
   * the client sent. `alreadyReferenced` lets an unchanged pre-existing reference (uploaded before
   * ownership tracking existed) keep working without a backfill.
   */
  async assertOwned(
    ownerId: string,
    publicId: unknown,
    kind: UploadedAssetKind,
    opts: { alreadyReferenced?: boolean } = {},
  ): Promise<{
    publicId: string;
    resourceType: string | null;
    mimeType: string | null;
    fileSize: number | null;
    fileName: string | null;
  } | null> {
    if (typeof publicId !== 'string' || !publicId.trim())
      throw new BadRequestException('A file reference (publicId) is required');
    // A product file may never live in another purpose's folder; a KYC document must live in the KYC folder.
    const folderId = stripStorageId(publicId); // R2 ids carry an `r2/` prefix
    if (
      kind === 'digital_product' &&
      NEVER_A_PRODUCT_FILE.some((prefix) => folderId.startsWith(prefix))
    ) {
      throw new BadRequestException('This file cannot be used here');
    }
    if (
      kind === 'kyc_document' &&
      !folderId.startsWith('private/kyc-documents')
    ) {
      throw new BadRequestException(
        'This is not a verification document upload',
      );
    }
    const row = await this.model
      .findOne({ publicId, kind })
      .lean<{
        ownerId: string;
        resourceType: string;
        mimeType: string | null;
        fileSize: number | null;
        fileName: string | null;
      }>();
    if (row) {
      if (row.ownerId !== ownerId)
        throw new BadRequestException('This file was not uploaded by you');
      return {
        publicId,
        resourceType: row.resourceType,
        mimeType: row.mimeType,
        fileSize: row.fileSize,
        fileName: row.fileName,
      };
    }
    if (opts.alreadyReferenced) return null; // legacy, untracked, but already part of THIS record — leave as is
    throw new BadRequestException(
      'Unknown file — upload it through the private upload endpoint first',
    );
  }
}
