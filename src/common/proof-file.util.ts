import { BadRequestException } from '@nestjs/common';

const PROOF_ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf']);

/** A payment proof is a screenshot/receipt photo or a PDF - nothing else (the generic private upload allows far more types). */
export function assertProofFile(file: Express.Multer.File): void {
  const ext = (file.originalname?.split('.').pop() ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  if (!PROOF_ALLOWED_EXT.has(ext) || !(mime.startsWith('image/') || mime === 'application/pdf' || mime === 'application/octet-stream')) {
    throw new BadRequestException('Please upload a screenshot or photo of your receipt (JPG, PNG, WEBP or PDF).');
  }
}