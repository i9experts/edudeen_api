/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from 'src/common/store-ownership.util';
import { cleanAiText } from '../ai-output.util';
import { AiService } from '../core/ai.service';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// ---------------------------------------------------------------- worksheet HTML (print / save as PDF)

export interface WorksheetOut { title: string; sections: Array<{ instructions?: string; questions: Array<{ prompt: string; type?: string; choices?: string[]; answer?: string }> }> }

/** Pure: printable, self-contained HTML (RTL-aware). Users print it / "Save as PDF" from the browser. No heavy PDF dependency. */
export function renderWorksheetHtml(ws: WorksheetOut, opts: { includeAnswers?: boolean; brand?: string } = {}): string {
  let n = 0;
  const rtl = /[؀-ۿ]/.test(`${ws.title} ${ws.sections?.[0]?.questions?.[0]?.prompt ?? ''}`);
  const body = (ws.sections ?? []).map((s) => `
    <section>${s.instructions ? `<p class="ins">${esc(s.instructions)}</p>` : ''}
    ${(s.questions ?? []).map((q) => {
      n++;
      const choices = q.choices?.length ? `<ol class="ch" type="A">${q.choices.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>` : '';
      const lines = !q.choices?.length && q.type !== 'true_false' ? '<div class="line"></div><div class="line"></div>' : q.type === 'true_false' ? '<p class="tf">True &nbsp;/&nbsp; False</p>' : '';
      return `<div class="q"><p><b>${n}.</b> ${esc(q.prompt)}</p>${choices}${lines}</div>`;
    }).join('')}</section>`).join('');
  let k = 0;
  const key = opts.includeAnswers
    ? `<section class="key"><h2>Answer key</h2><ol>${(ws.sections ?? []).flatMap((s) => s.questions ?? []).map((q) => { k++; return `<li value="${k}">${esc(q.answer ?? '-')}</li>`; }).join('')}</ol></section>`
    : '';
  return `<!doctype html><html lang="${rtl ? 'ur' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(ws.title)}</title>
<style>body{font-family:Georgia,'Noto Nastaliq Urdu',serif;max-width:760px;margin:24px auto;padding:0 20px;color:#141413}h1{font-size:24px;border-bottom:2px solid #174771;padding-bottom:8px}
.meta{display:flex;justify-content:space-between;color:#555;font-size:13px;margin:8px 0 18px}.ins{font-style:italic;color:#444}.q{margin:14px 0;break-inside:avoid}.line{border-bottom:1px solid #999;height:26px}
.ch{margin:6px 0 0 18px}.key{page-break-before:always}.foot{margin-top:30px;font-size:11px;color:#888;text-align:center}@media print{body{margin:0}}</style></head><body>
<h1>${esc(ws.title)}</h1><div class="meta"><span>Name: ____________________</span><span>Date: ____________</span></div>${body}${key}
<p class="foot">${esc(opts.brand ?? 'Made with Edudeen AI Studio')}</p></body></html>`;
}

// ---------------------------------------------------------------- generated product cover (code layout)

export interface CoverSpec { headline: string; subtitle: string; badge: string; theme: 'royal' | 'emerald' | 'amber' | 'rose' | 'slate' }
const THEMES: Record<CoverSpec['theme'], [string, string, string]> = {
  royal: ['#0F3354', '#174771', '#F6E7C1'], emerald: ['#0B4D3A', '#14705A', '#F2E9C9'], amber: ['#7A4A07', '#B8741A', '#FFF3D6'],
  rose: ['#6B1F3A', '#A13560', '#FDE8EF'], slate: ['#1F2933', '#3E4C59', '#F0F4F8'],
};

export function normalizeCover(raw: any, fallbackTitle: string): CoverSpec {
  return {
    headline: (cleanAiText(raw?.headline, 48) ?? fallbackTitle).slice(0, 48),
    subtitle: cleanAiText(raw?.subtitle, 70) ?? '',
    badge: cleanAiText(raw?.badge, 20) ?? '',
    theme: (Object.keys(THEMES) as CoverSpec['theme'][]).includes(raw?.theme) ? raw.theme : 'royal',
  };
}

function wrap(text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean); const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** Pure: 1200x1200 SVG cover. Layout is code; the model only suggested the text + theme. */
export function buildCoverSvg(spec: CoverSpec, brand = 'Edudeen'): string {
  const [c1, c2, accent] = THEMES[spec.theme];
  const lines = wrap(spec.headline, 18, 4);
  const startY = 520 - (lines.length - 1) * 60;
  const rtl = /[؀-ۿ]/.test(spec.headline);
  const font = rtl ? "'Noto Nastaliq Urdu','Edudeen Urdu',serif" : "Georgia,'Times New Roman',serif";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="1200" height="1200" fill="url(#g)"/><circle cx="1050" cy="150" r="260" fill="${accent}" opacity="0.08"/><circle cx="120" cy="1080" r="300" fill="${accent}" opacity="0.07"/>
<rect x="70" y="70" width="1060" height="1060" rx="36" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="4"/>
${spec.badge ? `<rect x="110" y="120" width="${Math.max(160, spec.badge.length * 26 + 60)}" height="64" rx="32" fill="${accent}"/><text x="${110 + Math.max(160, spec.badge.length * 26 + 60) / 2}" y="163" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="${c1}">${esc(spec.badge)}</text>` : ''}
<g font-family="${font}" fill="#fff" font-size="104" font-weight="700" text-anchor="middle">${lines.map((l, i) => `<text x="600" y="${startY + i * 124}">${esc(l)}</text>`).join('')}</g>
${spec.subtitle ? `<text x="600" y="${startY + lines.length * 124 + 20}" text-anchor="middle" font-family="${font}" font-size="46" fill="${accent}">${esc(spec.subtitle)}</text>` : ''}
<text x="600" y="1090" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" letter-spacing="6" fill="${accent}" opacity="0.9">${esc(brand.toUpperCase())}</text></svg>`;
}

@Injectable()
export class StudioExtrasService {
  constructor(private readonly db: DatabaseService, private readonly ai: AiService) {}
  private get r() { return this.db.repositories; }

  async worksheetHtml(sellerId: string, storeId: string, generationId: string, includeAnswers: boolean) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const g: any = await this.r.aiGenerationModel.findOne({ _id: generationId, storeId, toolType: 'worksheet_builder', status: 'succeeded' }).lean();
    if (!g?.outputPayload) throw new NotFoundException('Worksheet not found');
    return { success: true, data: { html: renderWorksheetHtml(g.outputPayload, { includeAnswers }), title: g.outputPayload.title } };
  }

  /** Alt-text + photo quality check (Claude vision). Claude cannot edit images. TODO(owner): plug a real enhancement provider into image-enhance.service.ts. */
  async imageCheck(sellerId: string, storeId: string, imageUrl: string, productName?: string) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    if (!/^https:\/\//i.test(imageUrl ?? '') || imageUrl.length > 1000) throw new BadRequestException('imageUrl must be an https URL');
    const data = await this.ai.withCredits('image_check', storeId, sellerId, async () => {
      const out = await this.ai.generate({
        feature: 'image_check', tier: 'standard', storeId, sellerId, maxTokens: 500,
        schema: { type: 'object', properties: { altText: { type: 'string' }, qualityScore: { type: 'integer' }, issues: { type: 'array', items: { type: 'string' } }, suggestions: { type: 'array', items: { type: 'string' } } }, required: ['altText', 'qualityScore', 'issues', 'suggestions'], additionalProperties: false },
        system: 'You check product photos for an education marketplace. altText: a factual description under 125 characters (no "image of"). qualityScore 1-10 (sharpness, lighting, framing, background, readable cover text). issues/suggestions: short and concrete. Judge only what is visible.',
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: `Product: ${productName ?? 'unknown'}` }] }],
      });
      return {
        altText: cleanAiText(out.json?.altText, 160) ?? '', qualityScore: Math.min(10, Math.max(1, Number(out.json?.qualityScore) || 5)),
        issues: (out.json?.issues ?? []).map((s: any) => cleanAiText(s, 160)).filter(Boolean).slice(0, 6),
        suggestions: (out.json?.suggestions ?? []).map((s: any) => cleanAiText(s, 160)).filter(Boolean).slice(0, 6),
      };
    });
    return { success: true, data };
  }

  async coverFor(sellerId: string, storeId: string, productId: string) {
    const store: any = await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const p: any = await this.r.productModel.findOne({ _id: productId, storeId, isDelete: false }).select('name description educationLevel productType').lean();
    if (!p) throw new NotFoundException('Product not found in this store');
    const spec = await this.ai.withCredits('product_cover', storeId, sellerId, async () => {
      const out = await this.ai.generate({
        feature: 'product_cover', tier: 'fast', storeId, sellerId, maxTokens: 300,
        schema: { type: 'object', properties: { headline: { type: 'string' }, subtitle: { type: 'string' }, badge: { type: 'string' }, theme: { type: 'string', enum: ['royal', 'emerald', 'amber', 'rose', 'slate'] } }, required: ['headline', 'subtitle', 'badge', 'theme'], additionalProperties: false },
        system: 'Suggest text for a product cover image. headline: max 40 characters, the product name shortened if needed (keep the language of the title). subtitle: max 60 characters (grade / subject / format). badge: max 18 characters like "Grade 5" or "Worksheets" (or empty). theme: pick a fitting colour theme. Never invent claims.',
        messages: [{ role: 'user', content: `Title: ${p.name}\nLevel: ${p.educationLevel ?? ''}\nType: ${p.productType}\nDescription: ${String(p.description ?? '').slice(0, 500)}` }],
      });
      return normalizeCover(out.json, p.name);
    });
    return { success: true, data: { spec, svg: buildCoverSvg(spec, store.name ?? 'Edudeen') } };
  }
}
