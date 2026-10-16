/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Res, NotFoundException, BadRequestException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { SeoResolutionService, SeoEntityType } from '../services/seo-resolution.service';
import { SeoPrerenderService, PrerenderPage } from '../services/seo-prerender.service';

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
 *    read client-side and for any future SSR head-renderer to consume directly.
 *  - `GET /seo-render/...` — server-rendered HTML (real <title>/<meta>/JSON-LD plus the
 *    page's content and links) served to bot user-agents by the Vercel rewrite in
 *    vercel.json, instead of the SPA shell. People still get the SPA.
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

const HTML_TTL_MS = 120_000;
const HTML_MAX = 400;

@SkipThrottle()
@Controller('seo-render')
export class SeoRenderHtmlController {
  private readonly cache = new Map<string, { at: number; html: string }>();

  constructor(
    private readonly resolution: SeoResolutionService,
    private readonly prerender: SeoPrerenderService,
  ) {}

  private async cached(key: string, build: () => Promise<PrerenderPage>): Promise<string> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < HTML_TTL_MS) return hit.html;
    const html = this.prerender.render(await build());
    if (this.cache.size >= HTML_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), html });
    return html;
  }

  private send(res: Response, html: string, status = 200) {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.send(html);
  }

  @Get('home')
  async home(@Res() res: Response) {
    this.send(res, await this.cached('home', () => this.prerender.home()));
  }

  @Get('page/:slug')
  async staticPage(@Param('slug') slug: string, @Res() res: Response) {
    try {
      this.send(res, await this.cached(`page:${slug}`, () => this.prerender.page(slug)));
    } catch (e) {
      if (e instanceof NotFoundException) return this.send(res, this.prerender.notFoundHtml(), 404);
      throw e;
    }
  }

  @Get(':entityType/:slug')
  async renderHtml(@Param('entityType') entityType: string, @Param('slug') slug: string, @Res() res: Response) {
    assertValidEntityType(entityType);
    // A renamed product: bots get a permanent redirect to the canonical URL instead of a duplicate page.
    if (entityType === 'product') {
      const current = await this.resolution.currentSlugForOldProductSlug(slug).catch(() => null);
      if (current) {
        res.redirect(301, `/product/${encodeURIComponent(current)}`);
        return;
      }
    }
    try {
      const html = await this.cached(`${entityType}:${slug}`, async () => {
        const meta = await this.resolution.resolve(entityType, slug);
        if (entityType === 'product') return this.prerender.product(meta);
        if (entityType === 'category') return this.prerender.category(meta);
        return this.prerender.store(meta);
      });
      this.send(res, html);
    } catch (e) {
      if (e instanceof NotFoundException) return this.send(res, this.prerender.notFoundHtml(), 404);
      throw e;
    }
  }
}
