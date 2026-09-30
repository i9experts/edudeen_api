/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Res, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { SeoResolutionService, SeoEntityType } from '../services/seo-resolution.service';

const VALID_ENTITY_TYPES: SeoEntityType[] = ['product', 'category', 'store'];

function assertValidEntityType(entityType: string): asserts entityType is SeoEntityType {
  if (!VALID_ENTITY_TYPES.includes(entityType as SeoEntityType)) {
    throw new BadRequestException(`entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}`);
  }
}

/**
 * Public, unauthenticated meta-delivery surface — see architecture plan
 * Refinement #1. Two consumers:
 *  - `GET /api/seo/meta/:entityType/:entityId` — JSON, for the React SPA to
 *    read client-side (react-helmet-style tag injection) and for any future
 *    SSR head-renderer to consume directly.
 *  - `GET /seo-render/:entityType/:slug` — a minimal server-rendered HTML
 *    fragment with real `<title>`/`<meta>`/JSON-LD tags, intended to be
 *    served to bot user-agents (Googlebot, facebookexternalhit, Twitterbot,
 *    LinkedInBot, Slackbot) via a reverse-proxy/CDN "dynamic rendering" rule
 *    instead of the SPA shell — the standard technique for getting correct
 *    social-share previews out of a client-side-rendered app without a full
 *    SSR migration.
 */
@ApiTags('SEO — Public Meta Delivery')
@Controller('api/seo')
export class SeoMetaController {
  constructor(private readonly resolution: SeoResolutionService) {}

  @Get('meta/:entityType/:entityId')
  async getMeta(@Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    assertValidEntityType(entityType);
    return this.resolution.resolve(entityType, entityId);
  }
}

@Controller('seo-render')
export class SeoRenderHtmlController {
  constructor(private readonly resolution: SeoResolutionService) {}

  @Get(':entityType/:slug')
  async renderHtml(@Param('entityType') entityType: string, @Param('slug') slug: string, @Res() res: Response) {
    assertValidEntityType(entityType);
    let meta;
    try {
      meta = await this.resolution.resolve(entityType, slug);
    } catch {
      throw new NotFoundException('Nothing to render for this entity.');
    }

    const jsonLdScripts = meta.jsonLd
      .map((block) => `<script type="application/ld+json">${JSON.stringify(block).replace(/</g, '\\u003c')}</script>`)
      .join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
${meta.noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}">
<meta property="og:title" content="${escapeHtml(meta.ogTitle)}">
<meta property="og:description" content="${escapeHtml(meta.ogDescription)}">
${meta.ogImage ? `<meta property="og:image" content="${escapeHtml(meta.ogImage)}">` : ''}
<meta property="og:url" content="${escapeHtml(meta.url)}">
<meta property="og:type" content="${meta.entityType === 'product' ? 'product' : 'website'}">
<meta name="twitter:card" content="${escapeHtml(String(meta.twitterCard ?? "summary"))}">
<meta name="twitter:title" content="${escapeHtml(meta.ogTitle)}">
<meta name="twitter:description" content="${escapeHtml(meta.ogDescription)}">
${meta.ogImage ? `<meta name="twitter:image" content="${escapeHtml(meta.ogImage)}">` : ''}
${jsonLdScripts}
<meta http-equiv="refresh" content="0; url=${escapeHtml(meta.url)}">
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(meta.url)}">${escapeHtml(meta.title)}</a>…</p>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
