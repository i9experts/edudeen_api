/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Block, BlockSchema } from '../../common/schemas/block.schema';

export type StoreThemeDocument = HydratedDocument<StoreTheme>;

@Schema({ _id: false })
export class StorefrontColors {
  @Prop({ type: String, default: '#D97757' }) primaryColor: string;
  @Prop({ type: String, default: '#FAF9F5' }) bgColor: string;
  @Prop({ type: String, default: '#2C2A28' }) textColor: string;
  @Prop({ type: String, default: '#B95A3A' }) accentColor: string;
  @Prop({ type: String, default: 'Poppins' }) font: string;
  // How `ThemedButton` renders a primary CTA — filled / bordered / tinted.
  @Prop({ type: String, enum: ['solid', 'outline', 'soft'], default: 'solid' })
  buttonStyle: 'solid' | 'outline' | 'soft';

  // ── Real design-system dimensions (not just color) — see `themes.ts` on
  // the frontend for the curated bundles that set all of these together.
  // Every default below reproduces today's actual rendered look exactly, so
  // a pre-existing store is pixel-identical until a seller changes anything.
  @Prop({ type: String, enum: ['compact', 'comfortable', 'spacious'], default: 'comfortable' })
  typeScale: 'compact' | 'comfortable' | 'spacious';

  @Prop({ type: String, enum: ['narrow', 'standard', 'wide'], default: 'standard' })
  containerWidth: 'narrow' | 'standard' | 'wide';

  @Prop({ type: String, enum: ['compact', 'comfortable', 'spacious'], default: 'comfortable' })
  sectionSpacing: 'compact' | 'comfortable' | 'spacious';

  @Prop({ type: String, enum: ['sm', 'md', 'lg'], default: 'md' })
  buttonSize: 'sm' | 'md' | 'lg';

  // ── Buttons scope — independent from product/testimonial cards and from
  // standalone images. Only `ThemedButton` reads these. ──
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  buttonRadius: 'none' | 'small' | 'medium' | 'large' | 'full';
  @Prop({ type: String, enum: ['auto', 'full'], default: 'auto' })
  buttonWidth: 'auto' | 'full';

  // ── Images scope — corner radius for a standalone content image
  // (`ImageWithTextSection`). Independent of buttons/cards. Default 'medium'
  // reproduces that section's previously-hardcoded `rounded-xl` look exactly.
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  imageRadius: 'none' | 'small' | 'medium' | 'large' | 'full';

  @Prop({ type: String, enum: ['overlay', 'split'], default: 'overlay' })
  heroStyle: 'overlay' | 'split';

  @Prop({ type: String, enum: ['left', 'center'], default: 'left' })
  heroAlignment: 'left' | 'center';

  // ── Product Cards scope — independent from testimonial cards. Default
  // values reproduce the old shared `cardStyle`/`borderRadius` defaults
  // exactly (both were 'outlined'/'medium'), so a pre-existing store's
  // product grid renders pixel-identical.
  @Prop({ type: String, enum: ['flat', 'outlined', 'elevated'], default: 'outlined' })
  productCardStyle: 'flat' | 'outlined' | 'elevated';
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  productCardRadius: 'none' | 'small' | 'medium' | 'large' | 'full';

  @Prop({ type: String, enum: ['square', 'portrait'], default: 'square' })
  productImageRatio: 'square' | 'portrait';

  @Prop({ type: String, enum: ['none', 'zoom'], default: 'none' })
  productImageHover: 'none' | 'zoom';

  @Prop({ type: String, enum: ['cozy', 'relaxed'], default: 'cozy' })
  productGridDensity: 'cozy' | 'relaxed';

  @Prop({ type: String, enum: ['cards', 'minimal'], default: 'cards' })
  testimonialStyle: 'cards' | 'minimal';
  // ── Testimonials scope — independent from product cards, same
  // backward-compatible defaults as the old shared token. ──
  @Prop({ type: String, enum: ['flat', 'outlined', 'elevated'], default: 'outlined' })
  testimonialCardStyle: 'flat' | 'outlined' | 'elevated';
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  testimonialCardRadius: 'none' | 'small' | 'medium' | 'large' | 'full';

  @Prop({ type: String, enum: ['accordion', 'list'], default: 'accordion' })
  faqStyle: 'accordion' | 'list';
}
export const StorefrontColorsSchema = SchemaFactory.createForClass(StorefrontColors);

// Header/footer are bespoke fields (not wrapped in the generic `Section` type
// used for page content) — they're singletons, never reorderable/deletable
// relative to siblings, so `Section`'s "one of many" semantics would buy
// nothing here. They still reuse the shared `Block` shape for their own
// content units (nav_link / footer_column / social_link / copyright_text —
// see section-settings.validator.ts for the allowed shape of each).
@Schema({ _id: false })
export class StorefrontHeader {
  @Prop({ type: String, enum: ['store', 'custom'], default: 'store' }) logoSource: 'store' | 'custom';
  @Prop({ type: String, default: null }) customLogoUrl: string | null;
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // nav_link blocks only
  // Where the nav-link group sits relative to the logo — the icons (cart/
  // account) always stay pinned to the far right regardless of this.
  @Prop({ type: String, enum: ['left', 'center', 'right'], default: 'left' })
  navAlignment: 'left' | 'center' | 'right';
  // Overall header composition — 'standard' is today's logo-left/inline-nav
  // layout; 'centered' stacks a centered logo with nav below it.
  @Prop({ type: String, enum: ['standard', 'centered'], default: 'standard' })
  headerStyle: 'standard' | 'centered';
}
export const StorefrontHeaderSchema = SchemaFactory.createForClass(StorefrontHeader);

@Schema({ _id: false })
export class StorefrontFooter {
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // footer_column / social_link / copyright_text blocks
  // 'columns' is today's multi-column layout; 'minimal' is a single centered
  // row (store name + copyright + socials, no columns).
  @Prop({ type: String, enum: ['columns', 'minimal'], default: 'columns' })
  footerStyle: 'columns' | 'minimal';
}
export const StorefrontFooterSchema = SchemaFactory.createForClass(StorefrontFooter);

// The store-identity banner (logo/name/description/rating on the home page)
// is fixed transactional chrome, not a seller-composable section (see the
// storefront plan) — but the seller still needs *some* control over it, so
// these four toggles (not full placement/reordering) are what's actually
// configurable. Defaults all `true` so a store with no saved StoreTheme yet
// (or one saved before this field existed) behaves exactly as before.
@Schema({ _id: false })
export class IdentityBanner {
  @Prop({ type: Boolean, default: true }) showFollowButton: boolean;
  @Prop({ type: Boolean, default: true }) showMessageButton: boolean;
  @Prop({ type: Boolean, default: true }) showLoyaltyButton: boolean;
  @Prop({ type: Boolean, default: true }) showMembershipButton: boolean;

  // ── Layout/visibility around those 4 fixed buttons (Phase 11) — genuinely
  // configurable presentation, not new transactional surface: the buttons
  // above stay individually toggle-able exactly as before; these control
  // everything AROUND them (cover height/composition, which stats show).
  // 'standard' + all-true + null reproduces today's exact rendered look, so
  // an existing store is pixel-identical until a seller changes something.
  @Prop({ type: String, enum: ['standard', 'compact', 'immersive'], default: 'standard' })
  layout: 'standard' | 'compact' | 'immersive';
  @Prop({ type: Boolean, default: true }) showBadges: boolean;
  @Prop({ type: Boolean, default: true }) showFollowerCount: boolean;
  @Prop({ type: Boolean, default: true }) showProductCount: boolean;
  @Prop({ type: Boolean, default: true }) showRating: boolean;
  @Prop({ type: Number, default: null }) descriptionMaxLines: number | null;
}
export const IdentityBannerSchema = SchemaFactory.createForClass(IdentityBanner);

// Highlight rows above "All products" on the buyer store page. Lives in the
// same draft/live split as the rest of the theme (NOT Store.featuredRank, which
// is the admin's "Featured store" pin, and not the legacy Store.pinnedProductIds).
@Schema({ _id: false })
export class StorefrontHighlights {
  // Seller-picked, in display order, max 8 (validated in StoreThemeService.updateStorefront).
  @Prop({ type: [String], default: [] }) featuredProductIds: string[];
  // Latest 8 published products.
  @Prop({ type: Boolean, default: false }) showNewArrivals: boolean;
  // Top 8 by Product.purchaseCount.
  @Prop({ type: Boolean, default: false }) showBestSellers: boolean;
}
export const StorefrontHighlightsSchema = SchemaFactory.createForClass(StorefrontHighlights);

// The draft/live split (Phase 2 of the Store Builder plan) — mirrors the
// `StoreTheme` root shape exactly (theme/header/footer/identityBanner +
// baseThemeId) so every seller edit lands here first and only reaches the
// public storefront once explicitly published. `_id: false` since this is
// always a singleton sub-object, never an array element.
@Schema({ _id: false })
export class StoreThemeDraft {
  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  @Prop({ type: String, default: null })
  baseThemeId: string | null;

  @Prop({ type: StorefrontHighlightsSchema, default: () => ({}) })
  storefront: StorefrontHighlights;

  // Customize-store draft: name/headline/about/logo/banner/teacher profile. Absent until the seller saves a draft
  // (the page then starts from the live Store values). Publish copies it onto the Store document in one transaction.
  @Prop({ type: Object, default: undefined })
  storePage?: Record<string, any>;
}
export const StoreThemeDraftSchema = SchemaFactory.createForClass(StoreThemeDraft);

// One doc per store — site-wide chrome (theme colors + header + footer),
// separate from `StorePage` (per-page section content). Replaces
// `Store.builderConfig` as the source of truth for this content; the old
// field is left as an inert orphan on already-existing stores rather than
// migrated in a big-bang way (see `store-theme.service.ts#ensureDefaultTheme`).
//
// `theme`/`header`/`footer`/`identityBanner`/`baseThemeId` at the document
// root are the LIVE/PUBLISHED state — read by the public storefront exactly
// as before this field was introduced (`getPublic()`/`PublicStoreThemeController`
// are untouched). `draft` is the seller's working copy: every
// `updateTheme`/`updateHeader`/`updateFooter`/`updateIdentityBanner` call now
// writes here, and only `publishTheme()` copies draft → root. This gives
// Theme the same safe edit-then-publish behavior `StorePage.status` already
// has, instead of every keystroke going instantly live.
@Schema({ timestamps: true })
export class StoreTheme {
  _id: string;

  @Prop({ required: true, unique: true, index: true })
  storeId: string;

  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  // Which curated theme (a frontend-only `themes.ts` definition, not a
  // backend ref/FK) the fields above were last bulk-set FROM — powers the
  // Theme tab's "Currently using X" / "Custom — based on X, N customized"
  // status line. Left untouched by manual field edits, so it keeps meaning
  // "based on X" even after the seller tweaks something. Null for a store
  // that's never applied a gallery theme (pre-existing stores, or a seller
  // who's only ever used the manual controls).
  @Prop({ type: String, default: null })
  baseThemeId: string | null;

  // LIVE highlight rows (published copy; the draft lives in `draft.storefront`).
  @Prop({ type: StorefrontHighlightsSchema, default: () => ({}) })
  storefront: StorefrontHighlights;

  // Defaults to a copy of the live root fields at read time for any store
  // that predates this field (`ensureDefaultTheme`), never left empty — see
  // that method for why a lazy per-read backfill is safe here (idempotent,
  // no concurrent-writer risk since it's the same $setOnInsert-style upsert
  // pattern already used for the rest of this document).
  @Prop({ type: StoreThemeDraftSchema, default: () => ({}) })
  draft: StoreThemeDraft;

  @Prop({ type: Date, default: null })
  lastPublishedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreThemeSchema = SchemaFactory.createForClass(StoreTheme);
