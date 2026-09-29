/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import * as streamifier from 'streamifier';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
  PREVIEW_PDF_PAGE_COUNT,
  PREVIEW_CLIP_SECONDS,
  PREVIEW_IMAGE_MAX_WIDTH,
  PREVIEW_WATERMARK_TEXT,
  PREVIEW_URL_TTL_SECONDS,
  PREVIEW_SOURCE_FOLDER,
} from '../products/constants/preview.constants';

// Public uploads are served inline from Cloudinary, so anything that a
// browser would execute or render as active content (SVG, HTML, JS) is
// excluded. Private (sold) files are only ever delivered as attachments with
// `nosniff`, so the list is wider — the formats teachers actually sell.
const PUBLIC_UPLOAD_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic',
  'mp4', 'webm', 'mov', 'mp3', 'm4a', 'wav',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv',
]);
const PRIVATE_UPLOAD_EXTENSIONS = new Set([
  ...PUBLIC_UPLOAD_EXTENSIONS,
  'epub', 'zip', 'svg', 'odt', 'ods', 'odp', 'rtf', 'key', 'pages', 'numbers', 'ogg',
]);
const PUBLIC_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const BLOCKED_MIME = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/javascript', 'text/javascript']);

function assertUploadAllowed(file: Express.Multer.File, kind: 'public' | 'private'): void {
  const ext = (file.originalname?.split('.').pop() ?? '').toLowerCase();
  const allowedExt = kind === 'public' ? PUBLIC_UPLOAD_EXTENSIONS : PRIVATE_UPLOAD_EXTENSIONS;
  if (!ext || !allowedExt.has(ext)) {
    throw new BadRequestException(`File type ".${ext || '?'}" is not allowed`);
  }
  const mime = (file.mimetype ?? '').toLowerCase();
  if (kind === 'public') {
    if (BLOCKED_MIME.has(mime)) throw new BadRequestException('This file type is not allowed');
    const mimeOk =
      PUBLIC_MIME_PREFIXES.some((p) => mime.startsWith(p)) ||
      mime === 'application/pdf' ||
      mime === 'text/plain' ||
      mime === 'text/csv' ||
      mime === 'application/msword' ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'application/vnd.ms-powerpoint' ||
      mime.startsWith('application/vnd.openxmlformats-officedocument.') ||
      mime === 'application/octet-stream'; // some clients send this for office files; extension already checked
    if (!mimeOk) throw new BadRequestException('This file type is not allowed');
  } else if (mime === 'text/html' || mime.includes('javascript') || mime === 'application/x-msdownload') {
    throw new BadRequestException('This file type is not allowed');
  }
}

@Injectable()
export class UploadService {
  constructor(private readonly configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  // ── PUBLIC upload ──
  // `options` lets a caller that needs Cloudinary-side resize/optimization (e.g.
  // promotional creatives, which used to go through a separate CloudinaryStorage
  // multer path just for this) opt in without changing the default behavior for
  // every other existing caller of this method.
  async uploadFile(
    file: Express.Multer.File,
    options?: { folder?: string; maxDimension?: number },
  ): Promise<{ url: string; publicId: string; resourceType: string; width?: number; height?: number }> {
    assertUploadAllowed(file, 'public');
    const resourceType = this.getResourceType(file.mimetype);
    const folder = options?.folder ?? (resourceType === 'raw' ? 'uploads/documents' : `uploads/${resourceType}s`);
    const transformation =
      options?.maxDimension && resourceType === 'image'
        ? [{ width: options.maxDimension, height: options.maxDimension, crop: 'limit' }, { quality: 'auto' }, { fetch_format: 'auto' }]
        : undefined;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: resourceType as any,
          type: 'upload',
          ...(transformation ? { transformation } : {}),
        },
        (error, result) => {
          if (error || !result) return reject(new BadRequestException(error?.message || 'Upload failed'));
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            resourceType,
            width: result.width,
            height: result.height,
          });
        },
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  // ── PRIVATE upload (digital products, and other sensitive files e.g. KYC
  // documents — `folder` defaults to the original digital-products path so
  // every existing caller is unaffected) ──
  async uploadPrivateFile(
    file: Express.Multer.File,
    folder: string = 'private/digital-products',
  ): Promise<{ publicId: string; resourceType: string; fileName: string; fileSize: number; mimeType: string }> {
    assertUploadAllowed(file, 'private');
    const mimeType = this.getMimeTypeFromExtension(file.originalname) || file.mimetype;
    const resourceType = this.getResourceType(mimeType);
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: resourceType as any,
          type: 'private',
        },
        (error, result) => {
          if (error || !result) return reject(new BadRequestException(error?.message || 'Private upload failed'));
          resolve({
            publicId: result.public_id,
            resourceType,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType,
          });
        },
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  // ── SIGNED URL generate ──
  generateSignedUrl(publicId: string, resourceType: string = 'raw', expirySeconds: number = 3600, fileName?: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
    const safeFileName = fileName
      ? fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      : undefined;
    return cloudinary.url(publicId, {
      sign_url: true,
      secure: true,
      type: 'private',
      resource_type: resourceType as any,
      expires_at: expiresAt,
      flags: safeFileName ? `attachment:${safeFileName}` : 'attachment',
    });
  }

  // ── Private buffer download from Cloudinary (generic) ──
  async downloadPrivateFileBuffer(publicId: string, resourceType: string = 'raw'): Promise<Buffer> {
    const signedUrl = this.generateSignedUrl(publicId, resourceType, 300); // 5 min — sirf download ke liye
    const response = await fetch(signedUrl);
    if (!response.ok) throw new BadRequestException('Failed to download file from storage');
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ── PDF buffer download from Cloudinary (private) ──
  async downloadPrivatePdfBuffer(publicId: string): Promise<Buffer> {
    return this.downloadPrivateFileBuffer(publicId, 'raw');
  }

  // ── PDF Stamping ──
  async stampPdf(publicId: string, userEmail: string, orderNumber: string): Promise<Buffer> {
    const pdfBuffer = await this.downloadPrivatePdfBuffer(publicId);

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();

    const stampText = `Licensed to: ${userEmail} | Order: ${orderNumber}`;

    for (const page of pages) {
      const { width, height } = page.getSize();

      // bottom stamp
      page.drawText(stampText, {
        x: 20,
        y: 15,
        size: 8,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity: 0.6,
      });

      // diagonal watermark (center)
      page.drawText(userEmail, {
        x: width / 2 - 100,
        y: height / 2,
        size: 30,
        font,
        color: rgb(0.85, 0.85, 0.85),
        opacity: 0.15,
        rotate: { type: 'degrees' as any, angle: 45 },
      });
    }

    const stampedBytes = await pdfDoc.save();
    return Buffer.from(stampedBytes);
  }

  // ── Preview: signed, transformation-scoped URLs (never the original file) ──
  private signedTransformUrl(
    publicId: string,
    resourceType: string,
    transformation: any[],
    expirySeconds: number,
    extra: Record<string, any> = {},
  ): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
    return cloudinary.url(publicId, {
      resource_type: resourceType as any,
      type: 'private',
      sign_url: true,
      secure: true,
      expires_at: expiresAt,
      transformation,
      ...extra,
    });
  }

  private previewWatermarkOverlay(fontSize: number) {
    return {
      overlay: {
        font_family: 'Arial',
        font_size: fontSize,
        font_weight: 'bold',
        text: PREVIEW_WATERMARK_TEXT,
      },
      gravity: 'center',
      color: '#FFFFFF',
      opacity: 40,
    };
  }

  // ── Preview: lazily create a transform-capable shadow copy for raw-stored pdf/audio ──
  // Cloudinary can only rasterize PDF pages / trim clips on 'image'/'video' resource
  // types, but pdf/audio digital-product files are stored as 'raw' (see getResourceType
  // below — intentionally left unchanged so the paid download path never regresses).
  async ensurePreviewSourceAsset(
    publicId: string,
    originalResourceType: string,
    targetResourceType: 'image' | 'video',
  ): Promise<string> {
    if (originalResourceType === targetResourceType) return publicId;
    const buffer = await this.downloadPrivateFileBuffer(publicId, originalResourceType);
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: PREVIEW_SOURCE_FOLDER, resource_type: targetResourceType, type: 'private' },
        (error, result) => {
          if (error || !result) return reject(new BadRequestException(error?.message || 'Preview source preparation failed'));
          resolve(result.public_id);
        },
      );
      streamifier.createReadStream(buffer).pipe(uploadStream);
    });
  }

  generatePreviewImageUrl(publicId: string, expirySeconds: number = PREVIEW_URL_TTL_SECONDS): string {
    return this.signedTransformUrl(
      publicId,
      'image',
      [{ width: PREVIEW_IMAGE_MAX_WIDTH, crop: 'limit' }, this.previewWatermarkOverlay(48)],
      expirySeconds,
      { format: 'jpg' },
    );
  }

  generatePreviewPdfPageUrls(
    publicId: string,
    pageCount: number = PREVIEW_PDF_PAGE_COUNT,
    expirySeconds: number = PREVIEW_URL_TTL_SECONDS,
  ): string[] {
    return Array.from({ length: pageCount }, (_, i) =>
      this.signedTransformUrl(
        publicId,
        'image',
        [{ page: i + 1 }, { width: PREVIEW_IMAGE_MAX_WIDTH, crop: 'limit' }, this.previewWatermarkOverlay(48)],
        expirySeconds,
        { format: 'jpg' },
      ),
    );
  }

  generatePreviewVideoUrl(publicId: string, clipSeconds: number = PREVIEW_CLIP_SECONDS, expirySeconds: number = PREVIEW_URL_TTL_SECONDS): string {
    return this.signedTransformUrl(
      publicId,
      'video',
      [
        { start_offset: 0, end_offset: clipSeconds },
        { overlay: { font_family: 'Arial', font_size: 32, font_weight: 'bold', text: PREVIEW_WATERMARK_TEXT }, gravity: 'south_east', x: 20, y: 20, color: '#FFFFFF', opacity: 60 },
      ],
      expirySeconds,
    );
  }

  generatePreviewAudioUrl(publicId: string, clipSeconds: number = PREVIEW_CLIP_SECONDS, expirySeconds: number = PREVIEW_URL_TTL_SECONDS): string {
    // Cloudinary stores/transforms audio under resource_type 'video' — no separate 'audio' type.
    return this.signedTransformUrl(publicId, 'video', [{ start_offset: 0, end_offset: clipSeconds }], expirySeconds);
  }

  private getResourceType(mimetype: string): string {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    return 'raw';
  }

  resolveMimeType(fileName: string, fallback: string): string {
    return this.getMimeTypeFromExtension(fileName) ?? fallback;
  }

  private getMimeTypeFromExtension(fileName: string): string | null {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      epub: 'application/epub+zip',
      zip: 'application/zip',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
      csv: 'text/csv',
    };
    return ext ? (map[ext] ?? null) : null;
  }
}
