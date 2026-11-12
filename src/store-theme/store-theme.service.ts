/* eslint-disable prettier/prettier */
import { isStoreLive } from 'src/common/store-live.util';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { cleanStorePageDraft, storePageFromStore } from '../store/store-page.util';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { StoreThemeDraft } from './schemas/store-theme.schema';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';
import { UpdateStorefrontDto } from './dto/update-storefront.dto';
import { UpdateStorePageDto } from './dto/update-store-page.dto';
import { assertFeaturedOwned, normalizeFeaturedIds, publishedHighlights } from './featured-products.util';
import { RealtimeService } from '../realtime/realtime.service';

const HEADER_ALLOWED_BLOCK_TYPES = ['nav_link'];
const FOOTER_ALLOWED_BLOCK_TYPES = ['footer_column', 'social_link', 'copyright_text'];
const MAX_HEADER_LINKS = 10;
const MAX_FOOTER_BLOCKS = 20;

function validateBlocks(blocks: { type: string; settings: Record<string, any> }[], allowed: string[], max: number) {
  if (blocks.length > max) throw new BadRequestException(`Cannot have more than ${max} items`);
  for (const block of blocks) {
    if (!allowed.includes(block.type)) throw new BadRequestException(`Block type "${block.type}" is not allowed here`);
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

/** The only keys updateTheme / updateIdentityBanner will write — mirrors the DTO classes. */
const THEME_UPDATE_KEYS = [
  'primaryColor', 'bgColor', 'textColor', 'accentColor', 'font', 'buttonStyle', 'buttonRadius', 'buttonWidth', 'imageRadius',
  'typeScale', 'containerWidth', 'sectionSpacing', 'productCardStyle', 'productCardRadius', 'buttonSize', 'heroStyle',
  'heroAlignment', 'productImageRatio', 'productImageHover', 'productGridDensity', 'testimonialStyle', 'testimonialCardStyle',
  'testimonialCardRadius', 'faqStyle', 'baseThemeId',
] as const;
const IDENTITY_BANNER_KEYS = [
  'showFollowButton', 'showMessageButton', 'showLoyaltyButton', 'showMembershipButton', 'layout', 'showBadges',
  'showFollowerCount', 'showProductCount', 'showRating', 'descriptionMaxLines',
] as const;

@Injectable()
export class StoreThemeService {
  constructor(
    private readonly databaseService: DatabaseService,
    @InjectConnection() private readonly connection: Connection,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get storeThemeModel() {
    return this.databaseService.repositories.storeThemeModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  /** Idempotent — called once from `StoreService.createStore()` right after a store is created, and safe to call again (upsert) for the one-off backfill of pre-existing stores. Never called from an unauthenticated read path (see plan: eager creation avoids a public-GET-does-a-write race). */
  async ensureDefaultTheme(storeId: string) {
    await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $setOnInsert: { storeId } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    // Backfill `draft` = a copy of the live root fields, for any store that
    // predates the draft/publish split. A raw `$exists` filter (not an
    // app-level check on `theme.draft`) is required here — a hydrated
    // Mongoose Document always reports schema defaults for a path missing
    // from the stored document, so there's no way to tell "draft was never
    // set" from "draft was set to all-defaults" once it's been read into JS.
    // No-ops harmlessly (0 matched) for every store that already has a real
    // `draft`, including a brand-new store — `setDefaultsOnInsert` already
    // populated `draft` at insert time above.
    await this.storeThemeModel.updateOne(
      { storeId, draft: { $exists: false } },
      [
        {
          $set: {
            draft: {
              theme: '$theme',
              header: '$header',
              footer: '$footer',
              identityBanner: '$identityBanner',
              baseThemeId: '$baseThemeId',
              storefront: { $ifNull: ['$storefront', {}] },
            },
          },
        },
      ],
      // Mongoose 9 rejects aggregation-pipeline updates without this flag —
      // without it every store creation 500'd after the store was inserted.
      { updatePipeline: true },
    );
    return this.storeThemeModel.findOne({ storeId });
  }

  async getForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const theme = await this.ensureDefaultTheme(storeId);
    return { success: true, data: theme };
  }

  /** Seller-only working copy, shaped like the public payload (theme/header/footer/identityBanner/baseThemeId) — what Store Builder's Theme/Header/Footer tabs edit, and what Live Preview (Phase 9) renders against real data. */
  async getDraft(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const doc = await this.ensureDefaultTheme(storeId);
    const draft = doc!.draft as StoreThemeDraft;
    const { draft: storefront, published: publishedStorefront } = await this.highlightsState(storeId);
    const page = await this.storePageState(storeId);
    return {
      success: true,
      data: {
        theme: draft.theme,
        header: draft.header,
        footer: draft.footer,
        identityBanner: draft.identityBanner,
        baseThemeId: draft.baseThemeId,
        storefront,
        publishedStorefront,
        storePage: page.draft,
        publishedStorePage: page.published,
        storePageSavedAt: page.savedAt,
        lastPublishedAt: doc!.lastPublishedAt,
      },
    };
  }

  /**
   * Highlights (featured / new arrivals / best sellers): the seller's draft and what buyers see now. Read raw (lean) because a
   * hydrated doc shows schema defaults for fields a store never had; an old store with no published block shows its legacy
   * pinned list, and its draft starts from that same list.
   */
  private async highlightsState(storeId: string) {
    const raw: any = await this.storeThemeModel.findOne({ storeId }).select('storefront draft.storefront').lean();
    const store: any = await this.storeModel.findById(storeId).select('pinnedProductIds').lean();
    const published = publishedHighlights(raw?.storefront, store?.pinnedProductIds);
    const draft = raw?.draft?.storefront ? publishedHighlights(raw.draft.storefront, null) : published;
    return { draft, published };
  }

  /**
   * Customize-store draft (name / headline / about / logo / banner photo / teacher profile). Buyers read the Store
   * document only, so nothing here is visible until publishTheme copies it. No saved draft = the live values.
   */
  private async storePageState(storeId: string) {
    const raw: any = await this.storeThemeModel.findOne({ storeId }).select('draft.storePage').lean();
    const store: any = await this.storeModel.findById(storeId)
      .select('name tagline description logo coverImage aboutBio educatorProfile gradesServed subjects teachingLanguages').lean();
    const published = storePageFromStore(store);
    const saved = raw?.draft?.storePage;
    if (!saved) return { draft: published, published, savedAt: null as Date | null };
    const { savedAt, ...rest } = saved;
    return { draft: { ...published, ...rest }, published, savedAt: (savedAt as Date) ?? null };
  }

  async updateStorePage(storeId: string, sellerId: string, dto: UpdateStorePageDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const state = await this.storePageState(storeId);
    const cleaned = cleanStorePageDraft(dto as Record<string, any>, state.draft);
    const savedAt = new Date();
    await this.storeThemeModel.updateOne({ storeId }, { $set: { 'draft.storePage': { ...cleaned, savedAt } } });
    return { success: true, message: 'Draft saved', data: { storePage: cleaned, publishedStorePage: state.published, storePageSavedAt: savedAt } };
  }
  /** The seller's highlights draft: featured product ids (own, active, max 8, in order) + the two auto-row switches. */
  async updateStorefront(storeId: string, sellerId: string, dto: UpdateStorefrontDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const next = { ...(await this.highlightsState(storeId)).draft };
    if (dto.featuredProductIds !== undefined) {
      const ids = normalizeFeaturedIds(dto.featuredProductIds);
      if (ids.length) {
        const rows = await this.databaseService.repositories.productModel
          .find({ _id: { $in: ids } }).select('_id storeId status isDelete isTest').lean();
        assertFeaturedOwned(ids, rows as any[], storeId);
      }
      next.featuredProductIds = ids;
    }
    if (dto.showNewArrivals !== undefined) next.showNewArrivals = dto.showNewArrivals;
    if (dto.showBestSellers !== undefined) next.showBestSellers = dto.showBestSellers;
    await this.storeThemeModel.updateOne({ storeId }, { $set: { 'draft.storefront': next } });
    return { success: true, message: 'Draft saved', data: { storefront: next } };
  }

  async getPublic(storeId: string) {
    // Live stores only, and never the unpublished `draft` copy (it used to be returned to every visitor).
    if (!(await isStoreLive(this.storeModel, storeId))) return { success: true, data: null };
    const theme = await this.storeThemeModel.findOne({ storeId }).select('-draft').lean();
    return { success: true, data: theme };
  }

  /**
   * Copies draft → the live root fields in one atomic $set (document-referencing aggregation-pipeline update, so it can't
   * drift into a two-step read-then-write race). When the seller also has a Customize-store draft (`draft.storePage`),
   * the SAME transaction applies it to the Store document and clears it, so theme + store fields go live together or not at all.
   */
  async publishTheme(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    let changedFields: string[] = [];
    const updated = await this.connection.transaction(async (session) => {
      const raw: any = await this.storeThemeModel.findOne({ storeId }).select('draft.storePage').session(session).lean();
      const doc = await this.storeThemeModel.findOneAndUpdate(
        { storeId },
        [
          {
            $set: {
              theme: '$draft.theme',
              header: '$draft.header',
              footer: '$draft.footer',
              identityBanner: '$draft.identityBanner',
              baseThemeId: '$draft.baseThemeId',
              // Only when the seller has a highlights draft; an old store that never edited it keeps its legacy pinned row.
              storefront: { $ifNull: ['$draft.storefront', '$storefront'] },
              lastPublishedAt: '$$NOW',
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true, session },
      );
      const page = raw?.draft?.storePage;
      if (page) {
        const store: any = await this.storeModel.findById(storeId).session(session).lean();
        const { savedAt, ...rest } = page;
        const clean = cleanStorePageDraft(rest, storePageFromStore(store));
        const live = storePageFromStore(store);
        changedFields = (Object.keys(clean) as (keyof typeof clean)[]).filter(k => JSON.stringify(clean[k]) !== JSON.stringify(live[k]));
        await this.storeModel.updateOne({ _id: storeId }, {
          $set: {
            name: clean.name, tagline: clean.tagline, description: clean.description, logo: clean.logo ?? '',
            coverImage: clean.coverImage, aboutBio: clean.aboutBio, educatorProfile: clean.educatorProfile,
            gradesServed: clean.gradesServed, subjects: clean.subjects, teachingLanguages: clean.teachingLanguages,
          },
        }, { session });
        // Draft = live again; the next edit starts from the Store document (so a later direct Store edit is never overwritten).
        await this.storeThemeModel.updateOne({ storeId }, { $unset: { 'draft.storePage': '' } }, { session });
      }
      return doc;
    });
    await this.activityLogService.log({
      storeId, category: 'settings', action: 'store_page_published',
      description: 'Store page published',
      actorId: sellerId, actorRole: 'seller', targetId: storeId, targetType: 'store',
      metadata: { storeFields: changedFields },
    });
    // Open storefronts re-read the store + highlight rows (no data in the message, only the topic).
    RealtimeService.instance?.emitTo({ stores: [storeId] }, ['store']);
    RealtimeService.instance?.emit('storefront');
    return { success: true, message: 'Theme published', data: updated };
  }
  /** Safety-net "discard unsaved changes" — copies the live root fields back over draft, the mirror image of publishTheme's copy direction. */
  async revertDraftToPublished(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      [
        {
          $set: {
            draft: {
              theme: '$theme',
              header: '$header',
              footer: '$footer',
              identityBanner: '$identityBanner',
              baseThemeId: '$baseThemeId',
              storefront: { $ifNull: ['$storefront', '$$REMOVE'] },
            },
          },
        },
      ],
      { returnDocument: 'after', updatePipeline: true },
    );
    return { success: true, message: 'Draft reverted to the published theme', data: updated };
  }

  async updateTheme(storeId: string, sellerId: string, dto: UpdateThemeDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const set: Record<string, unknown> = {};
    for (const key of THEME_UPDATE_KEYS) {
      const value = (dto as Record<string, unknown>)[key];
      if (value === undefined) continue;
      // Only the declared keys are written (iterating Object.entries(dto) turned any extra body key into a
      // `draft.theme.<key>` write path). `baseThemeId` lives at the draft root (sibling of `theme`), not
      // nested under it — everything else on this DTO is a `theme.*`
      // color/design field. All writes now target `draft.*`, never the
      // live root fields directly — see publishTheme() for how a draft
      // actually goes live.
      set[key === 'baseThemeId' ? 'draft.baseThemeId' : `draft.theme.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { returnDocument: 'after' });
    return { success: true, message: 'Theme updated', data: updated };
  }

  async updateHeader(storeId: string, sellerId: string, dto: UpdateHeaderDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    if (dto.blocks) validateBlocks(dto.blocks, HEADER_ALLOWED_BLOCK_TYPES, MAX_HEADER_LINKS);

    const set: Record<string, unknown> = {};
    if (dto.logoSource !== undefined) set['draft.header.logoSource'] = dto.logoSource;
    if (dto.customLogoUrl !== undefined) set['draft.header.customLogoUrl'] = dto.customLogoUrl;
    if (dto.blocks !== undefined) set['draft.header.blocks'] = dto.blocks;
    if (dto.navAlignment !== undefined) set['draft.header.navAlignment'] = dto.navAlignment;
    if (dto.headerStyle !== undefined) set['draft.header.headerStyle'] = dto.headerStyle;

    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { returnDocument: 'after' });
    return { success: true, message: 'Header updated', data: updated };
  }

  async updateFooter(storeId: string, sellerId: string, dto: UpdateFooterDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    validateBlocks(dto.blocks, FOOTER_ALLOWED_BLOCK_TYPES, MAX_FOOTER_BLOCKS);

    const set: Record<string, unknown> = { 'draft.footer.blocks': dto.blocks };
    if (dto.footerStyle !== undefined) set['draft.footer.footerStyle'] = dto.footerStyle;

    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { returnDocument: 'after' });
    return { success: true, message: 'Footer updated', data: updated };
  }

  async updateIdentityBanner(storeId: string, sellerId: string, dto: UpdateIdentityBannerDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const set: Record<string, unknown> = {};
    for (const key of IDENTITY_BANNER_KEYS) {
      const value = (dto as Record<string, unknown>)[key];
      if (value !== undefined) set[`draft.identityBanner.${key}`] = value;
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to update');
    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { returnDocument: 'after' });
    return { success: true, message: 'Store info updated', data: updated };
  }
}
