/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { StoreThemeDraft } from './schemas/store-theme.schema';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';

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

@Injectable()
export class StoreThemeService {
  constructor(private readonly databaseService: DatabaseService) {}

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
      { upsert: true, new: true, setDefaultsOnInsert: true },
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
            },
          },
        },
      ],
      // Mongoose 9 rejects array (aggregation-pipeline) updates unless this
      // is set explicitly — without it every call threw, which broke store
      // creation and every Store Builder theme endpoint.
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
    return {
      success: true,
      data: {
        theme: draft.theme,
        header: draft.header,
        footer: draft.footer,
        identityBanner: draft.identityBanner,
        baseThemeId: draft.baseThemeId,
        lastPublishedAt: doc!.lastPublishedAt,
      },
    };
  }

  async getPublic(storeId: string) {
    const theme = await this.storeThemeModel.findOne({ storeId }).lean();
    return { success: true, data: theme };
  }

  /** Copies draft → the live root fields in one atomic $set, using the same document-referencing aggregation-pipeline update as the draft backfill above (so it can't drift into a two-step read-then-write race). */
  async publishTheme(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      [
        {
          $set: {
            theme: '$draft.theme',
            header: '$draft.header',
            footer: '$draft.footer',
            identityBanner: '$draft.identityBanner',
            baseThemeId: '$draft.baseThemeId',
            lastPublishedAt: '$$NOW',
          },
        },
      ],
      { new: true, updatePipeline: true },
    );
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
            },
          },
        },
      ],
      { new: true, updatePipeline: true },
    );
    return { success: true, message: 'Draft reverted to the published theme', data: updated };
  }

  async updateTheme(storeId: string, sellerId: string, dto: UpdateThemeDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      // `baseThemeId` lives at the draft root (sibling of `theme`), not
      // nested under it — everything else on this DTO is a `theme.*`
      // color/design field. All writes now target `draft.*`, never the
      // live root fields directly — see publishTheme() for how a draft
      // actually goes live.
      set[key === 'baseThemeId' ? 'draft.baseThemeId' : `draft.theme.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
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

    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Header updated', data: updated };
  }

  async updateFooter(storeId: string, sellerId: string, dto: UpdateFooterDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    validateBlocks(dto.blocks, FOOTER_ALLOWED_BLOCK_TYPES, MAX_FOOTER_BLOCKS);

    const set: Record<string, unknown> = { 'draft.footer.blocks': dto.blocks };
    if (dto.footerStyle !== undefined) set['draft.footer.footerStyle'] = dto.footerStyle;

    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Footer updated', data: updated };
  }

  async updateIdentityBanner(storeId: string, sellerId: string, dto: UpdateIdentityBannerDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`draft.identityBanner.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Store info updated', data: updated };
  }
}
