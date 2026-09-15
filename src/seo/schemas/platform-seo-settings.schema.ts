/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformSeoSettingsDocument = PlatformSeoSettings & Document;

/**
 * Platform-wide SEO configuration — a true singleton (one document, ever).
 * Singleton-ness is enforced application-side by `PlatformSeoService`
 * (`findOneAndUpdate({ key: 'global' }, ..., { upsert: true })`), the same
 * "singleton by convention + unique key" pattern used elsewhere in this
 * codebase (e.g. `PosSettings` is a per-store singleton keyed on `storeId`).
 */

@Schema({ _id: false })
export class SeoMetaTemplate {
  @Prop({ required: true }) key: string; // e.g. 'product', 'category', 'store'
  // Token-templated string, e.g. "{{productName}} — {{storeName}} | Edudeen".
  // Tokens are resolved by SeoResolutionService against the entity's own
  // fields; unresolved tokens fall back to an empty string, never left raw.
  @Prop({ required: true }) titleTemplate: string;
  @Prop({ type: String, default: null }) descriptionTemplate: string | null;
}
export const SeoMetaTemplateSchema = SchemaFactory.createForClass(SeoMetaTemplate);

@Schema({ _id: false })
export class SeoRuleConfig {
  // Matches one of SeoAuditService's fixed, code-defined check functions —
  // see Refinement #3 in the architecture plan: rules are config thresholds
  // for built-in checks, not a generic data-driven rule engine.
  @Prop({ required: true, enum: [
    'title_length', 'description_length', 'missing_alt_text', 'thin_content',
    'duplicate_meta', 'missing_canonical', 'broken_internal_link', 'missing_schema',
  ] })
  code: string;
  @Prop({ type: Boolean, default: true }) enabled: boolean;
  @Prop({ type: Object, default: () => ({}) }) thresholds: Record<string, number>; // e.g. { max: 60 } for title_length
  @Prop({ type: String, enum: ['info', 'warning', 'error'], default: 'warning' }) severity: string;
}
export const SeoRuleConfigSchema = SchemaFactory.createForClass(SeoRuleConfig);

@Schema({ timestamps: true })
export class PlatformSeoSettings {
  @Prop({ type: String, default: 'global', unique: true })
  key: string;

  // ── Homepage / marketplace meta ──────────────────────────────────────────
  @Prop({ type: String, default: null }) homepageTitle: string | null;
  @Prop({ type: String, default: null }) homepageDescription: string | null;
  @Prop({ type: String, default: null }) marketplaceTitle: string | null;
  @Prop({ type: String, default: null }) marketplaceDescription: string | null;

  // ── Global meta templates (fallback when an entity has no own override) ──
  @Prop({ type: [SeoMetaTemplateSchema], default: [] })
  metaTemplates: SeoMetaTemplate[];

  // ── Robots.txt ────────────────────────────────────────────────────────────
  // Raw, admin-editable robots.txt body (sitemap directives appended
  // automatically by SeoSitemapService, not stored here, so they always
  // reflect the live chunked sitemap list).
  @Prop({ type: String, default: 'User-agent: *\nDisallow: /api/\n' })
  robotsTxtBody: string;

  // ── JSON-LD structured data (Organization / Website / SearchAction) ──────
  @Prop({ type: Object, default: null }) organizationSchema: Record<string, any> | null;
  @Prop({ type: Object, default: null }) websiteSchema: Record<string, any> | null;
  @Prop({ type: Object, default: null }) searchActionSchema: Record<string, any> | null;

  // ── Global AI SEO settings ────────────────────────────────────────────────
  @Prop({ type: Boolean, default: false }) aiSeoEnabled: boolean; // platform-wide kill switch
  @Prop({ type: Object, default: () => ({}) }) aiSeoConfig: Record<string, any>;

  // ── SEO Rules (audit-check thresholds — see Refinement #3) ───────────────
  @Prop({ type: [SeoRuleConfigSchema], default: [] })
  rules: SeoRuleConfig[];

  @Prop({ type: String, default: null })
  updatedByAdminId: string | null;
}

export const PlatformSeoSettingsSchema = SchemaFactory.createForClass(PlatformSeoSettings);
PlatformSeoSettingsSchema.index({ key: 1 }, { unique: true });
