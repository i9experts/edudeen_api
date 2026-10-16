/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { FaqService } from 'src/faqs/faq.service';
import { PlatformSeoService } from './platform-seo-settings.service';
import { SeoSchemaGeneratorService } from './seo-schema-generator.service';
import type { ResolvedSeoMeta } from './seo-resolution.service';

const ORIGIN = 'https://edudeen.com';
const DEFAULT_OG_IMAGE = `${ORIGIN}/og-default.png`;

export interface PrerenderPage {
  title: string;
  description: string;
  canonical: string;
  ogImage: string | null;
  ogType: string;
  noindex: boolean;
  jsonLd: Record<string, any>[];
  /** HTML placed inside <main> (already escaped). */
  body: string;
}

interface Card { name: string; slug: string; image: string | null; price: number | null; currency: string; store: string; storeSlug: string; rating: number; ratings: number }

export function esc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const trunc = (t: string | null | undefined, n: number) => (!t ? '' : t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}...`);
const plain = (t: string | null | undefined) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Static public pages that bots can fetch: slug -> path, title, description, intro. */
export const STATIC_PAGES: Record<string, { path: string; title: string; h1: string; description: string; intro: string }> = {
  about: { path: '/about', title: 'About Edudeen | Education marketplace', h1: 'About Edudeen', description: 'Edudeen is an education marketplace where teachers, scholars and publishers sell worksheets, books, digital downloads and courses.', intro: 'Edudeen is one education marketplace for teachers, scholars, academies and publishers. Every store is reviewed by our team and buyers always pay through Edudeen checkout.' },
  faq: { path: '/faq', title: 'Help Center and FAQs | Edudeen', h1: 'Frequently asked questions', description: 'Answers about orders, downloads, payments, refunds and selling on Edudeen.', intro: 'Find answers about orders, digital downloads, payments, refunds and selling on Edudeen.' },
  'contact-us': { path: '/contact-us', title: 'Contact Edudeen', h1: 'Contact us', description: 'Get in touch with the Edudeen team for help with orders, sellers or your account.', intro: 'Questions about an order, a seller or your account? Send us a message and the Edudeen team will reply.' },
  learn: { path: '/learn', title: 'Learn by grade and subject | Edudeen', h1: 'Learn by grade and subject', description: 'Browse worksheets, books and courses by grade level and subject for home and classroom.', intro: 'Browse educational resources by grade level and subject, from early learning to exam preparation.' },
  premium: { path: '/premium', title: 'Edudeen Premium | Member prices and perks', h1: 'Edudeen Premium', description: 'Edudeen Premium members get member prices from sellers, a monthly personal coupon, early access to sales and priority support.', intro: 'Edudeen Premium gives members lower prices on participating products, a monthly coupon, early access to sales and priority support.' },
  'become-a-seller': { path: '/become-a-seller', title: 'Sell on Edudeen | Open your education store', h1: 'Sell on Edudeen', description: 'Open a store on Edudeen and sell worksheets, books, courses and digital downloads to parents, teachers and schools.', intro: 'Open your education store, list digital and physical products, and get paid through Edudeen. Choose a plan that fits your store.' },
  'privacy-policy': { path: '/privacy-policy', title: 'Privacy Policy | Edudeen', h1: 'Privacy Policy', description: 'How Edudeen collects, uses and protects your personal information.', intro: 'How Edudeen collects, uses and protects your personal information.' },
  'terms-of-service': { path: '/terms-of-service', title: 'Terms of Service | Edudeen', h1: 'Terms of Service', description: 'The terms that apply when you buy or sell on Edudeen.', intro: 'The terms that apply when you buy or sell on Edudeen.' },
  'cookie-policy': { path: '/cookie-policy', title: 'Cookie Policy | Edudeen', h1: 'Cookie Policy', description: 'How Edudeen uses cookies and similar technologies.', intro: 'How Edudeen uses cookies and similar technologies.' },
};

/**
 * Builds the crawler HTML bodies (home, product, category, store, static pages) served by
 * `GET /seo-render/...` to bot user-agents. Real content + links + JSON-LD, no JavaScript needed.
 * People never see this; they get the SPA.
 */
@Injectable()
export class SeoPrerenderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly platformSeo: PlatformSeoService,
    private readonly schema: SeoSchemaGeneratorService,
    private readonly faqService: FaqService,
  ) {}

  // ── shared bits ─────────────────────────────────────────────────────────────

  private money(c: Card): string {
    if (c.price == null) return '';
    if (c.price <= 0) return 'Free';
    return `${c.currency} ${c.currency === 'PKR' ? Math.round(c.price) : c.price.toFixed(2)}`;
  }

  private cardHtml(c: Card): string {
    const price = this.money(c);
    return `<li><a href="${ORIGIN}/product/${esc(c.slug)}">${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" width="160" height="160" loading="lazy"> ` : ''}<span>${esc(c.name)}</span></a>${price ? ` - <span>${esc(price)}</span>` : ''}${c.store ? ` - <a href="${ORIGIN}/shop/${esc(c.storeSlug)}">${esc(c.store)}</a>` : ''}</li>`;
  }

  private listHtml(heading: string, cards: Card[], level = 2): string {
    if (!cards.length) return '';
    return `<section><h${level}>${esc(heading)}</h${level}><ul>${cards.map((c) => this.cardHtml(c)).join('')}</ul></section>`;
  }

  /** Live products (active, not test, store active) as cards. */
  private async cards(filter: Record<string, any>, sort: Record<string, 1 | -1>, limit: number): Promise<Card[]> {
    const { productModel, productVariantModel, storeModel } = this.db.repositories;
    const docs: any[] = await productModel
      .find({ status: 'active', isDelete: false, isTest: { $ne: true }, ...filter })
      .sort(sort).limit(limit * 2)
      .select('name slug images storeId averageRating totalRatings').lean();
    if (!docs.length) return [];
    const stores: any[] = await storeModel
      .find({ _id: { $in: [...new Set(docs.map((d) => String(d.storeId)))] }, status: 'active', isDelete: false })
      .select('name slug baseCurrency').lean();
    const storeById = new Map(stores.map((s) => [String(s._id), s]));
    const live = docs.filter((d) => storeById.has(String(d.storeId))).slice(0, limit);
    const variants: any[] = live.length
      ? await productVariantModel.find({ productId: { $in: live.map((d) => String(d._id)) }, isDelete: false }).select('productId price currency isDefault').lean()
      : [];
    const byProduct = new Map<string, any>();
    for (const v of variants) {
      const cur = byProduct.get(String(v.productId));
      if (!cur || (v.isDefault && !cur.isDefault)) byProduct.set(String(v.productId), v);
    }
    return live.map((d) => {
      const st = storeById.get(String(d.storeId));
      const v = byProduct.get(String(d._id));
      return {
        name: d.name, slug: d.slug, image: d.images?.[0] ?? null,
        price: typeof v?.price === 'number' ? v.price : null,
        currency: v?.currency || st?.baseCurrency || 'USD',
        store: st?.name ?? '', storeSlug: st?.slug ?? '',
        rating: d.averageRating ?? 0, ratings: d.totalRatings ?? 0,
      };
    });
  }

  private itemListLd(name: string, cards: Card[]): Record<string, any> {
    return {
      '@context': 'https://schema.org', '@type': 'ItemList', name,
      itemListElement: cards.map((c, i) => ({ '@type': 'ListItem', position: i + 1, url: `${ORIGIN}/product/${c.slug}`, name: c.name })),
    };
  }

  private async rootCategories() {
    const { categoryModel } = this.db.repositories;
    return (await categoryModel.find({ status: 'active', isDelete: false, $or: [{ parentId: null }, { parentId: { $exists: false } }], slug: { $exists: true, $ne: null } })
      .sort({ sortOrder: 1, name: 1 }).select('name slug image description').lean()) as any[];
  }

  private async faqs(limit = 30) {
    // NOTE: not db.repositories.faqModel - DatabaseService injects the User model under that name (existing bug), so use the FAQ service.
    try {
      const res: any = await this.faqService.findAllActive();
      return ((res?.data ?? []) as any[]).slice(0, limit).map((f) => ({ question: f.question, answer: f.answer }));
    } catch { return []; }
  }

  private faqLd(faqs: any[]): Record<string, any> | null {
    if (!faqs.length) return null;
    return {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: plain(f.answer) } })),
    };
  }

  private faqHtml(faqs: any[]): string {
    if (!faqs.length) return '';
    return `<section><h2>Frequently asked questions</h2>${faqs.map((f) => `<h3>${esc(f.question)}</h3><p>${esc(plain(f.answer))}</p>`).join('')}</section>`;
  }

  private async homeContent(): Promise<Record<string, any>> {
    try {
      const cfg: any = await this.db.repositories.platformConfigModel.findOne({}).select('homeContent').lean();
      return cfg?.homeContent ?? {};
    } catch { return {}; }
  }

  // ── pages ───────────────────────────────────────────────────────────────────

  async home(): Promise<PrerenderPage> {
    const [settings, hc, cats, featured, best, newest, faqs] = await Promise.all([
      this.platformSeo.getSettings().catch(() => ({} as any)),
      this.homeContent(),
      this.rootCategories(),
      this.cards({ isFeatured: true }, { updatedAt: -1 }, 12),
      this.cards({}, { purchaseCount: -1, viewCount: -1 }, 12),
      this.cards({}, { createdAt: -1 }, 12),
      this.faqs(8),
    ]);
    const free = await this.freeCards(12);
    const stores: any[] = await this.db.repositories.storeModel.find({ status: 'active', isDelete: false })
      .sort({ averageRating: -1 }).limit(12).select('name slug description').lean();

    const title = (settings as any).marketplaceTitle || 'Edudeen - Educational resources, books & courses from trusted sellers';
    const description = (settings as any).marketplaceDescription || 'Edudeen is an education marketplace: worksheets, books, digital downloads and courses for home and classroom from verified sellers.';
    const heroTitle = [hc.heroTitle, hc.heroHighlight].filter(Boolean).join(' ').trim();
    const heroText = hc.heroText || 'Worksheets, books, digital downloads and courses for home and classroom, from trusted sellers.';

    const body = `<h1>Edudeen - educational resources, books and courses</h1>
${heroTitle ? `<p><strong>${esc(heroTitle)}</strong></p>` : ''}<p>${esc(heroText)}</p>
${cats.length ? `<section><h2>Shop by category</h2><ul>${cats.map((c) => `<li><a href="${ORIGIN}/c/${esc(c.slug)}">${esc(c.name)}</a>${c.description ? ` - ${esc(trunc(plain(c.description), 120))}` : ''}</li>`).join('')}</ul></section>` : ''}
${this.listHtml('Featured resources', featured)}${this.listHtml('Bestsellers', best)}${this.listHtml('Free resources', free)}${this.listHtml('New arrivals', newest)}
${stores.length ? `<section><h2>Top sellers</h2><ul>${stores.map((s) => `<li><a href="${ORIGIN}/shop/${esc(s.slug)}">${esc(s.name)}</a>${s.description ? ` - ${esc(trunc(plain(s.description), 120))}` : ''}</li>`).join('')}</ul></section>` : ''}
${this.faqHtml(faqs)}`;

    const orgOverride = (settings as any).organizationSchema;
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Edudeen', url: `${ORIGIN}/`, logo: `${ORIGIN}/edudeen-logo.png`, ...(orgOverride ?? {}) };
    const site = (settings as any).searchActionSchema ?? {
      '@context': 'https://schema.org', '@type': 'WebSite', name: 'Edudeen', url: `${ORIGIN}/`,
      potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${ORIGIN}/?search={search_term_string}` }, 'query-input': 'required name=search_term_string' },
    };
    const jsonLd = [org, site, ...(featured.length ? [this.itemListLd('Featured resources', featured)] : []), ...(this.faqLd(faqs) ? [this.faqLd(faqs)!] : [])];
    return { title, description, canonical: `${ORIGIN}/`, ogImage: DEFAULT_OG_IMAGE, ogType: 'website', noindex: false, jsonLd, body };
  }

  private async freeCards(limit: number): Promise<Card[]> {
    const free: any[] = await this.db.repositories.productVariantModel.find({ price: 0, isDelete: false }).limit(60).select('productId').lean();
    const ids = [...new Set(free.map((v) => String(v.productId)))];
    if (!ids.length) return [];
    return this.cards({ _id: { $in: ids } }, { purchaseCount: -1 }, limit);
  }

  async page(slug: string): Promise<PrerenderPage> {
    const def = STATIC_PAGES[slug];
    if (!def) throw new NotFoundException('Unknown page.');
    const hc = await this.homeContent();
    let extra = '';
    const jsonLd: Record<string, any>[] = [this.schema.buildBreadcrumbSchema([{ name: 'Home', url: ORIGIN }, { name: def.h1, url: `${ORIGIN}${def.path}` }])];
    let intro = def.intro;

    if (slug === 'faq') {
      const faqs = await this.faqs(60);
      extra = this.faqHtml(faqs).replace('<h2>Frequently asked questions</h2>', '');
      const ld = this.faqLd(faqs);
      if (ld) jsonLd.push(ld);
    } else if (slug === 'about') {
      const a = hc.about ?? {};
      if (typeof a.intro === 'string' && a.intro) intro = a.intro;
    } else if (slug === 'learn' || slug === 'become-a-seller' || slug === 'premium') {
      const cats = slug === 'learn' ? await this.rootCategories() : [];
      extra = cats.length ? `<h2>Browse by subject</h2><ul>${cats.map((c) => `<li><a href="${ORIGIN}/c/${esc(c.slug)}">${esc(c.name)}</a></li>`).join('')}</ul>` : '';
    } else if (hc.legalPages?.[slug]?.text) {
      extra = String(hc.legalPages[slug].text).split(/\r?\n/).filter((l) => l.trim()).map((l) => (l.startsWith('## ') ? `<h2>${esc(l.slice(3))}</h2>` : `<p>${esc(l)}</p>`)).join('');
    }
    const body = `<h1>${esc(def.h1)}</h1><p>${esc(intro)}</p>${extra}`;
    return { title: def.title, description: def.description, canonical: `${ORIGIN}${def.path}`, ogImage: DEFAULT_OG_IMAGE, ogType: 'website', noindex: false, jsonLd, body };
  }

  async product(meta: ResolvedSeoMeta): Promise<PrerenderPage> {
    const { productModel, productVariantModel, storeModel, categoryModel } = this.db.repositories;
    const p: any = await productModel.findById(meta.entityId).lean();
    if (!p) throw new NotFoundException('Product not found.');
    const [store, category, variants] = await Promise.all([
      storeModel.findById(p.storeId).select('name slug baseCurrency').lean() as Promise<any>,
      p.categoryId ? (categoryModel.findById(p.categoryId).select('name slug').lean() as Promise<any>) : null,
      productVariantModel.find({ productId: String(p._id), isDelete: false }).select('price currency isDefault compareAtPrice').lean() as Promise<any[]>,
    ]);
    const v = variants.find((x) => x.isDefault) ?? variants[0];
    const card: Card = { name: p.name, slug: p.slug, image: p.images?.[0] ?? null, price: typeof v?.price === 'number' ? v.price : null, currency: v?.currency || store?.baseCurrency || 'USD', store: store?.name ?? '', storeSlug: store?.slug ?? '', rating: p.averageRating ?? 0, ratings: p.totalRatings ?? 0 };
    const related = p.categoryId ? (await this.cards({ categoryId: p.categoryId, _id: { $ne: p._id } }, { purchaseCount: -1 }, 8)) : [];
    const images: string[] = (p.images ?? []).slice(0, 6);
    const body = `<nav aria-label="Breadcrumb"><a href="${ORIGIN}/">Home</a>${category?.slug ? ` &gt; <a href="${ORIGIN}/c/${esc(category.slug)}">${esc(category.name)}</a>` : ''} &gt; ${esc(p.name)}</nav>
<h1>${esc(p.name)}</h1>
${images.map((src, i) => `<img src="${esc(src)}" alt="${esc(i === 0 ? p.name : `${p.name} - image ${i + 1}`)}" width="400" height="400">`).join('')}
${this.money(card) ? `<p><strong>${esc(this.money(card))}</strong></p>` : ''}
${card.ratings > 0 ? `<p>Rated ${esc(card.rating.toFixed(1))} out of 5 by ${esc(card.ratings)} buyers.</p>` : ''}
${store ? `<p>Sold by <a href="${ORIGIN}/shop/${esc(store.slug)}">${esc(store.name)}</a></p>` : ''}
<section><h2>About this resource</h2><p>${esc(plain(p.description))}</p></section>
${this.listHtml('More like this', related)}`;
    return { title: meta.title, description: meta.description, canonical: meta.canonicalUrl, ogImage: meta.ogImage, ogType: 'product', noindex: meta.noindex, jsonLd: meta.jsonLd, body };
  }

  async category(meta: ResolvedSeoMeta): Promise<PrerenderPage> {
    const { categoryModel } = this.db.repositories;
    const all: any[] = await categoryModel.find({ status: 'active', isDelete: false }).select('name slug parentId description').lean();
    const self = all.find((c) => String(c._id) === meta.entityId);
    if (!self) throw new NotFoundException('Category not found.');
    const children = all.filter((c) => String(c.parentId) === meta.entityId && c.slug);
    const ids = new Set<string>([meta.entityId]);
    let grew = true;
    while (grew) { grew = false; for (const c of all) if (c.parentId && ids.has(String(c.parentId)) && !ids.has(String(c._id))) { ids.add(String(c._id)); grew = true; } }
    const list = [...ids];
    const cards = await this.cards({ $or: [{ categoryId: { $in: list } }, { subCategoryId: { $in: list } }] }, { purchaseCount: -1, createdAt: -1 }, 24);
    const trail: any[] = [];
    for (let cur = self; cur?.parentId; ) { const par = all.find((c) => String(c._id) === String(cur.parentId)); if (!par) break; trail.unshift(par); cur = par; }
    const jsonLd = [
      this.schema.buildBreadcrumbSchema([{ name: 'Home', url: ORIGIN }, ...trail.filter((c) => c.slug).map((c) => ({ name: c.name, url: `${ORIGIN}/c/${c.slug}` })), { name: self.name, url: meta.canonicalUrl }]),
      ...(cards.length ? [this.itemListLd(self.name, cards)] : []),
    ];
    const body = `<nav aria-label="Breadcrumb"><a href="${ORIGIN}/">Home</a>${trail.filter((c) => c.slug).map((c) => ` &gt; <a href="${ORIGIN}/c/${esc(c.slug)}">${esc(c.name)}</a>`).join('')} &gt; ${esc(self.name)}</nav>
<h1>${esc(self.name)}</h1>${self.description ? `<p>${esc(plain(self.description))}</p>` : `<p>${esc(meta.description)}</p>`}
${children.length ? `<section><h2>Subcategories</h2><ul>${children.map((c) => `<li><a href="${ORIGIN}/c/${esc(c.slug)}">${esc(c.name)}</a></li>`).join('')}</ul></section>` : ''}
${this.listHtml(`${self.name} resources`, cards)}`;
    return { title: meta.title, description: meta.description, canonical: meta.canonicalUrl, ogImage: meta.ogImage ?? DEFAULT_OG_IMAGE, ogType: 'website', noindex: meta.noindex, jsonLd, body };
  }

  async store(meta: ResolvedSeoMeta): Promise<PrerenderPage> {
    const s: any = await this.db.repositories.storeModel.findById(meta.entityId).select('name slug description logo').lean();
    if (!s) throw new NotFoundException('Store not found.');
    const cards = await this.cards({ storeId: String(s._id) }, { purchaseCount: -1, createdAt: -1 }, 24);
    const jsonLd = [
      ...meta.jsonLd,
      this.schema.buildBreadcrumbSchema([{ name: 'Home', url: ORIGIN }, { name: s.name, url: meta.canonicalUrl }]),
      ...(cards.length ? [this.itemListLd(`${s.name} products`, cards)] : []),
    ];
    const body = `<nav aria-label="Breadcrumb"><a href="${ORIGIN}/">Home</a> &gt; ${esc(s.name)}</nav>
<h1>${esc(s.name)}</h1>${s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name)} logo" width="120" height="120">` : ''}
<p>${esc(plain(s.description) || meta.description)}</p>
${this.listHtml(`Products from ${s.name}`, cards)}`;
    return { title: meta.title, description: meta.description, canonical: meta.canonicalUrl, ogImage: meta.ogImage ?? DEFAULT_OG_IMAGE, ogType: 'website', noindex: meta.noindex, jsonLd, body };
  }

  // ── layout ──────────────────────────────────────────────────────────────────

  render(p: PrerenderPage): string {
    const ld = p.jsonLd.map((b) => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, '\\u003c')}</script>`).join('\n');
    const nav = [['/', 'Home'], ['/learn', 'Learn'], ['/about', 'About'], ['/faq', 'FAQ'], ['/contact-us', 'Contact'], ['/become-a-seller', 'Sell on Edudeen'], ['/premium', 'Premium']]
      .map(([h, l]) => `<a href="${ORIGIN}${h}">${l}</a>`).join(' | ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta name="robots" content="${p.noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large'}">
<link rel="canonical" href="${esc(p.canonical)}">
<meta property="og:site_name" content="Edudeen">
<meta property="og:type" content="${esc(p.ogType)}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(p.canonical)}">
${p.ogImage ? `<meta property="og:image" content="${esc(p.ogImage)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(p.title)}">
<meta name="twitter:description" content="${esc(p.description)}">
${p.ogImage ? `<meta name="twitter:image" content="${esc(p.ogImage)}">` : ''}
${ld}
</head>
<body>
<!-- Served to crawlers only (see vercel.json); people get the app. -->
<header><a href="${ORIGIN}/">Edudeen</a><nav aria-label="Main">${nav}</nav></header>
<main>
${p.body}
</main>
<footer><nav aria-label="Footer">${nav} | <a href="${ORIGIN}/privacy-policy">Privacy</a> | <a href="${ORIGIN}/terms-of-service">Terms</a></nav><p>Edudeen - an education marketplace.</p></footer>
</body>
</html>`;
  }

  notFoundHtml(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not found | Edudeen</title><meta name="robots" content="noindex"></head><body><main><h1>Page not found</h1><p><a href="${ORIGIN}/">Back to Edudeen</a></p></main></body></html>`;
  }
}
