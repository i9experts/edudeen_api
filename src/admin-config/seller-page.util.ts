import { BadRequestException } from '@nestjs/common';

/**
 * Sanitiser for PlatformConfig.sellerPage - the admin-editable content of the public
 * /become-a-seller page. Only known keys survive, text is trimmed and length-capped,
 * lists are capped, links are validated. Each top-level section is replaced as a whole
 * when sent; a section left out of the request keeps its stored value; `null` clears a
 * section (the page then shows its built-in default).
 */
export const SELLER_PAGE_ICONS = ['star', 'book', 'users', 'store', 'chart', 'bell', 'headphones', 'shield', 'wallet', 'sparkles', 'globe', 'check', 'heart', 'graduation'] as const;
export const SELLER_PAGE_MOCKS = ['store', 'sales', 'followers', 'none'] as const;
export const SELLER_PAGE_VISIBLE_KEYS = ['hero', 'stats', 'plans', 'steps', 'featureRows', 'benefits', 'whoSells', 'supportCards', 'faqs', 'finalCta'] as const;
const HEADING_KEYS = ['plans', 'plansHighlight', 'steps', 'featureRows', 'whoSells', 'support', 'faqs', 'benefits'] as const;

export const SELLER_PAGE_LIMITS = { steps: 8, featureRows: 8, benefits: 9, whoSells: 9, supportCards: 6, faqs: 20, bullets: 6 } as const;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const icon = (v: unknown) => ((SELLER_PAGE_ICONS as readonly string[]).includes(v as string) ? (v as string) : 'star');

function imageUrl(v: unknown, field: string): string {
  const s = str(v, 500);
  if (s && !/^https?:\/\/\S+$/i.test(s)) throw new BadRequestException(`${field} must be a full https:// link`);
  return s;
}
function link(v: unknown, field: string): string {
  const s = str(v, 500);
  if (s && !/^(\/(?!\/)\S*|https?:\/\/\S+)$/i.test(s)) throw new BadRequestException(`${field} must start with / or https://`);
  return s;
}

export interface SellerPageUpdate {
  set: Record<string, unknown>;
  unset: Record<string, ''>;
}

export function sanitizeSellerPage(body: Record<string, unknown> | undefined | null): SellerPageUpdate {
  const src = body && typeof body === 'object' ? body : {};
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  const P = 'sellerPage.';
  const L = SELLER_PAGE_LIMITS;

  const section = (key: string, build: (v: any) => unknown) => {
    const v = (src as any)[key];
    if (v === undefined) return;
    if (v === null) { unset[P + key] = ''; return; }
    set[P + key] = build(v);
  };

  section('hero', (h: any) => ({
    eyebrow: str(h?.eyebrow, 120), title: str(h?.title, 200), highlight: str(h?.highlight, 200), text: str(h?.text, 600),
    primaryCta: str(h?.primaryCta, 60), secondaryCta: str(h?.secondaryCta, 60), imageUrl: imageUrl(h?.imageUrl, 'hero.imageUrl'),
  }));
  section('stats', (s: any) => ({ buyers: str(s?.buyers, 100), stores: str(s?.stores, 100), sales: str(s?.sales, 100) }));
  section('finalCta', (f: any) => ({ title: str(f?.title, 200), text: str(f?.text, 400), button: str(f?.button, 60) }));
  section('headings', (h: any) => {
    const out: Record<string, string> = {};
    for (const k of HEADING_KEYS) out[k] = str(h?.[k], 200);
    return out;
  });
  const titleText = (x: any, withIcon = true) => ({ title: str(x?.title, 120), text: str(x?.text, 600), ...(withIcon ? { icon: icon(x?.icon) } : {}) });
  section('steps', (a: any) => arr(a).map(x => titleText(x)).filter(x => x.title).slice(0, L.steps));
  section('benefits', (a: any) => arr(a).map(x => titleText(x)).filter(x => x.title).slice(0, L.benefits));
  section('whoSells', (a: any) => arr(a).map(x => titleText(x)).filter(x => x.title).slice(0, L.whoSells));
  section('featureRows', (a: any) => arr(a).map(x => ({
    ...titleText(x, false),
    imageUrl: imageUrl(x?.imageUrl, 'featureRows.imageUrl'),
    mockKind: (SELLER_PAGE_MOCKS as readonly string[]).includes(x?.mockKind) ? x.mockKind : 'none',
    bullets: arr(x?.bullets).map(b => str(b, 120)).filter(Boolean).slice(0, L.bullets),
  })).filter(x => x.title).slice(0, L.featureRows));
  section('supportCards', (a: any) => arr(a).map(x => ({
    title: str(x?.title, 120), text: str(x?.text, 400), ctaLabel: str(x?.ctaLabel, 60), ctaLink: link(x?.ctaLink, 'supportCards.ctaLink'),
  })).filter(x => x.title).slice(0, L.supportCards));
  section('faqs', (a: any) => arr(a).map(x => ({ q: str(x?.q, 200), a: str(x?.a, 1500) })).filter(x => x.q && x.a).slice(0, L.faqs));

  if (src.visible !== undefined) {
    const vis = src.visible as Record<string, unknown> | null;
    if (vis && typeof vis === 'object') {
      for (const k of SELLER_PAGE_VISIBLE_KEYS) if (typeof vis[k] === 'boolean') set[`${P}visible.${k}`] = vis[k];
    }
  }
  return { set, unset };
}
