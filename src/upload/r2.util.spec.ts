import { isR2Id, presignR2Url, stripStorageId } from './r2.util';

const cfg = { accountId: 'acc123', accessKeyId: 'AKID', secretAccessKey: 'SECRET', bucket: 'edudeen-files' };

describe('r2.util', () => {
  it('builds a deterministic SigV4 presigned URL', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const a = presignR2Url(cfg, 'GET', 'private/digital-products/x y.pdf', 300, { 'response-content-disposition': 'attachment' }, now);
    const b = presignR2Url(cfg, 'GET', 'private/digital-products/x y.pdf', 300, { 'response-content-disposition': 'attachment' }, now);
    expect(a).toBe(b);
    expect(a.startsWith('https://acc123.r2.cloudflarestorage.com/edudeen-files/private/digital-products/x%20y.pdf?')).toBe(true);
    expect(a).toContain('X-Amz-Date=20260102T030405Z');
    expect(a).toContain('X-Amz-Expires=300');
    expect(a).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    expect(presignR2Url(cfg, 'PUT', 'k', 300, {}, now)).not.toBe(presignR2Url(cfg, 'GET', 'k', 300, {}, now));
  });

  it('recognises and strips the r2 id prefix', () => {
    expect(isR2Id('r2/private/a')).toBe(true);
    expect(isR2Id('private/a')).toBe(false);
    expect(stripStorageId('r2/private/a')).toBe('private/a');
    expect(stripStorageId('private/a')).toBe('private/a');
  });
});
