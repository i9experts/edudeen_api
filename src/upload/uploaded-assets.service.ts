/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import type { UploadedAssetKind } from './schemas/uploaded-asset.schema';

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
    if (
      kind === 'digital_product' &&
      NEVER_A_PRODUCT_FILE.some((prefix) => publicId.startsWith(prefix))
    ) {
      throw new BadRequestException('This file cannot be used here');
    }
    if (
      kind === 'kyc_document' &&
      !publicId.startsWith('private/kyc-documents')
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
