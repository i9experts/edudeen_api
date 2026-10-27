/* eslint-disable prettier/prettier */
import { createHash, createHmac } from 'crypto';

/**
 * Minimal Cloudflare R2 (S3-compatible) client: SigV4 query-string presigning only, no SDK.
 * R2 holds the SOLD (private) files because Cloudinary's free plan caps raw files at 10 MB.
 * A stored publicId for an R2 object is `r2/<key>` (see R2_ID_PREFIX); everything else is Cloudinary.
 */
export const R2_ID_PREFIX = 'r2/';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
  /** Signing region: 'auto' for R2; S3-compatible hosts (Backblaze B2, AWS) need theirs, e.g. 'us-west-004'. */
  region?: string;
}

export function isR2Id(publicId: unknown): publicId is string {
  return typeof publicId === 'string' && publicId.startsWith(R2_ID_PREFIX);
}

/** `r2/private/x` -> `private/x`; other ids unchanged. Folder checks must run on this form. */
export function stripStorageId(publicId: string): string {
  return isR2Id(publicId) ? publicId.slice(R2_ID_PREFIX.length) : publicId;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

export function presignR2Url(
  cfg: R2Config,
  method: 'GET' | 'PUT',
  key: string,
  expirySeconds: number,
  extraQuery: Record<string, string> = {},
  now: Date = new Date(),
): string {
  const host = cfg.endpoint ? new URL(cfg.endpoint).host : `${cfg.accountId}.r2.cloudflarestorage.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260101T000000Z
  const date = amzDate.slice(0, 8);
  const region = cfg.region || 'auto';
  const scope = `${date}/${region}/s3/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.max(1, Math.min(expirySeconds, 604800))),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  const path = `/${cfg.bucket}/${key.split('/').map(enc).join('/')}`;
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretAccessKey, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
