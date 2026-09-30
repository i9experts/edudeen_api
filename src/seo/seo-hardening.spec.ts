/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { BadRequestException } from '@nestjs/common';
import { assertSafeSeoDestination, pickSeoMeta } from './services/seo-url-safety.util';
import { SeoRedirectsService } from './services/seo-redirects.service';
import { SeoCanonicalService } from './services/seo-canonical.service';
import { SeoIntegrationsService } from './services/seo-integrations.service';
import { SeoAuditService } from './services/seo-audit.service';
import { SeoResolutionService } from './services/seo-resolution.service';

describe('assertSafeSeoDestination', () => {
  it.each(['/\\evil.com', '/%5cevil.com', '/%2f/evil.com', '/\t/evil.com', '/\n/evil.com', '//evil.com', '/a b', 'javascript:alert(1)', 'data:text/html,x', 'http://edudeen.com/x', 'https://evil.com/x', 'https://edudeen.com@evil.com/', 'https://evil.com\\@edudeen.com/'])(
    'rejects %j',
    (value) => {
      expect(() => assertSafeSeoDestination(value)).toThrow(BadRequestException);
    },
  );

  it.each(['/', '/product/algebra-pack', '/store/math-hub?ref=a#top', '/c/books%20and%20more', 'https://edudeen.com/a', 'https://staging.edudeen.com/x'])('accepts %j', (value) => {
    expect(() => assertSafeSeoDestination(value)).not.toThrow();
  });

  it('rejects an over-long value', () => {
    expect(() => assertSafeSeoDestination('/' + 'a'.repeat(2100))).toThrow(BadRequestException);
  });
});

describe('pickSeoMeta', () => {
  it('drops unknown keys, so the SEO sub-document cannot be polluted (checklist, pages, storeId...)', () => {
    const out = pickSeoMeta({ metaTitle: 'T', checklist: { done: true }, pages: { x: 1 }, storeId: 'other', $set: { a: 1 } } as any);
    expect(out).toEqual({ metaTitle: 'T' });
  });

  it('types and bounds the values that end up in <meta> tags', () => {
    expect(() => pickSeoMeta({ ogImage: 'javascript:alert(1)' })).toThrow(/https URL/);
    expect(() => pickSeoMeta({ twitterCard: '"><script>' })).toThrow(/twitterCard/);
    expect(() => pickSeoMeta({ noindex: 'yes' })).toThrow(/noindex/);
    expect(() => pickSeoMeta({ keywords: Array.from({ length: 21 }, () => 'k') })).toThrow(/keywords/);
    expect(() => pickSeoMeta({ metaTitle: { $ne: 1 } })).toThrow(BadRequestException);
    expect(pickSeoMeta({ ogImage: 'https://cdn.x/y.png', twitterCard: 'summary', keywords: ['a'], noindex: true })).toMatchObject({ noindex: true });
  });
});

describe('redirects / canonical rules: no mass assignment', () => {
  const doc = (over: object) => ({ storeId: 's1', source: '/a', destination: '/b', statusCode: 301, isActive: true, isDelete: false, hitCount: 9, save: jest.fn().mockResolvedValue(undefined), ...over });
  const actor = { id: 'a1' };

  it('a seller PATCH cannot null the storeId (platform-wide redirect) or touch isDelete / hitCount', async () => {
    const redirect: any = doc({});
    const svc: any = new SeoRedirectsService({ repositories: {} } as any, { log: jest.fn() } as any);
    jest.spyOn(svc, 'findOwned').mockResolvedValue(redirect);
    await svc.update('s1', 'r1', { destination: '/c', storeId: null, isDelete: true, hitCount: 0 } as any, actor);
    expect(redirect.storeId).toBe('s1');
    expect(redirect.isDelete).toBe(false);
    expect(redirect.hitCount).toBe(9);
    expect(redirect.destination).toBe('/c');
  });

  it('a redirect cannot point at itself', async () => {
    const svc: any = new SeoRedirectsService({ repositories: {} } as any, { log: jest.fn() } as any);
    jest.spyOn(svc, 'findOwned').mockResolvedValue(doc({ source: '/a', destination: '/b' }));
    await expect(svc.update('s1', 'r1', { destination: '/a' } as any, actor)).rejects.toThrow(/itself/);
  });

  it('canonical rule updates only touch the declared fields', async () => {
    const rule: any = { storeId: 's1', pathPattern: '/x', canonicalUrl: '/y', isActive: true, isDelete: false, save: jest.fn().mockResolvedValue(undefined) };
    const svc: any = new SeoCanonicalService({ repositories: {} } as any, { log: jest.fn() } as any);
    jest.spyOn(svc, 'findOwned').mockResolvedValue(rule);
    await svc.update('s1', 'c1', { canonicalUrl: '/z', storeId: null, isDelete: true } as any, actor);
    expect(rule.storeId).toBe('s1');
    expect(rule.isDelete).toBe(false);
    expect(rule.canonicalUrl).toBe('/z');
  });
});

describe('SEO integrations', () => {
  const svc: any = new SeoIntegrationsService({ repositories: {} } as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any);

  it('redirect_uri must be one of our origins (https), never an attacker URL', () => {
    delete process.env.SEO_OAUTH_REDIRECT_URIS;
    for (const bad of ['https://evil.com/cb', 'http://edudeen.com/cb', 'https://edudeen.com.evil.com/cb', 'https://user:pw@edudeen.com/cb', 'javascript:alert(1)', 'nope']) {
      expect(() => svc.assertAllowedRedirectUri(bad)).toThrow(BadRequestException);
    }
    expect(() => svc.assertAllowedRedirectUri('https://edudeen.com/seo/integrations/callback')).not.toThrow();
    process.env.SEO_OAUTH_REDIRECT_URIS = 'https://app.partner.example/cb';
    expect(() => svc.assertAllowedRedirectUri('https://app.partner.example/other')).not.toThrow();
    delete process.env.SEO_OAUTH_REDIRECT_URIS;
  });

  it('GA4 / Merchant Center identifiers are validated before being put into an API path', async () => {
    const s: any = new SeoIntegrationsService({ repositories: {} } as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any);
    s.providers = { ga4: {}, merchant_center: {} };
    await expect(s.connect({ scope: 'store', storeId: 's' }, 'ga4', 'c', 'https://edudeen.com/cb', '../../evil', { id: 'a' })).rejects.toThrow(/properties/);
    await expect(s.connect({ scope: 'store', storeId: 's' }, 'merchant_center', 'c', 'https://edudeen.com/cb', '1/../2', { id: 'a' })).rejects.toThrow(/numeric/);
  });
});

describe('SEO audit queue', () => {
  it('repeated run requests inside 5 minutes share a job id (no stacked full-catalogue audits)', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const svc: any = new SeoAuditService({ repositories: {} } as any, {} as any, {} as any, {} as any, {} as any, { add } as any);
    await svc.enqueueRun('s1'); await svc.enqueueRun('s1');
    expect(add.mock.calls[0][2].jobId).toBe(add.mock.calls[1][2].jobId);
    await svc.enqueueRun('s2');
    expect(add.mock.calls[2][2].jobId).not.toBe(add.mock.calls[0][2].jobId);
  });
});

describe('SEO meta cache', () => {
  it('invalidate() also drops the slug-keyed entry, so an unpublished entity stops being served immediately', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const productModel: any = { findById: () => ({ select: () => ({ lean: async () => ({ slug: 'algebra-pack' }) }) }) };
    const svc: any = new SeoResolutionService({ repositories: { productModel } } as any, { del } as any, {} as any, {} as any);
    await svc.invalidate('product', '64f0c0ffee0c0ffee0c0ff01');
    expect(del).toHaveBeenCalledWith('seo:meta:product:64f0c0ffee0c0ffee0c0ff01');
    expect(del).toHaveBeenCalledWith('seo:meta:product:algebra-pack');
  });
});
