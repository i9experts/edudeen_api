/* eslint-disable prettier/prettier */
import { isStoreLive } from 'src/common/store-live.util';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateSectionSettings, validateBlocksOfType, SECTION_ALLOWED_BLOCK_TYPES } from '../common/store-content/section-settings.validator';
import { SectionType } from '../common/schemas/section.schema';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdateSectionsDto } from './dto/update-sections.dto';

const MAX_SECTIONS_PER_PAGE = 40;
const MAX_PAGES_PER_STORE = 50;
const MAX_SECTIONS_BYTES = 60_000; // serialized size cap per page — the 100kb body limit was the only bound, times unlimited pages
// Custom pages are served at the bare `/:slug/:pageSlug` (no `/pages/`
// prefix), so a page slug now shares its namespace directly with sibling
// storefront routes — 'blog' must be reserved to avoid shadowing
// `/:slug/blog`. 'home' stays reserved since the home page's own slug is
// always the fixed empty string, never seller-assignable. 'category'/
// 'collections' reserved alongside the new store-scoped category-browse
// (`/category/:slugOrId`) and collection-detail (`/collections/:slugOrId`)
// storefront routes (Store Builder plan, Phase 11) for the same reason.
// 'search' reserved for the navbar search box's results route.
const RESERVED_CUSTOM_PAGE_SLUGS = ['home', 'blog', 'category', 'collections', 'search', 'cart', 'checkout', 'login', 'account'];

function validateSections(sections: { type: SectionType; settings: Record<string, any>; blocks: { type: string; settings: Record<string, any> }[] }[]) {
  if (Buffer.byteLength(JSON.stringify(sections ?? [])) > MAX_SECTIONS_BYTES) {
    throw new BadRequestException('This page is too large — remove some content');
  }
  if (sections.length > MAX_SECTIONS_PER_PAGE) {
    throw new BadRequestException(`A page cannot have more than ${MAX_SECTIONS_PER_PAGE} sections`);
  }
  for (const section of sections) {
    validateSectionSettings(section.type, section.settings ?? {});
    validateBlocksOfType(section.blocks ?? [], SECTION_ALLOWED_BLOCK_TYPES[section.type]);
  }
}

function starterHomeSections() {
  return [
    { type: 'hero' as SectionType, settings: { heightPreset: 'medium' }, blocks: [] },
    { type: 'product_catalog' as SectionType, settings: { heading: 'Our Products' }, blocks: [] },
  ];
}

@Injectable()
export class StorePagesService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get storePageModel() {
    return this.databaseService.repositories.storePageModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  /** Idempotent — called from `StoreService.createStore()` right after creation, and from the one-off backfill script for pre-existing stores. A brand-new home page starts as a usable draft with a hero + product catalog, not empty. */
  async ensureHomePage(storeId: string) {
    return this.storePageModel.findOneAndUpdate(
      { storeId, type: 'home' },
      {
        $setOnInsert: {
          storeId,
          type: 'home',
          slug: '',
          title: 'Home',
          sections: starterHomeSections(),
          status: 'draft',
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
  }

  private async findOwnedPage(storeId: string, sellerId: string, pageId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const page = await this.storePageModel.findOne({ _id: pageId, storeId, isDelete: false });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureHomePage(storeId);
    const pages = await this.storePageModel.find({ storeId, isDelete: false }).sort({ type: -1, createdAt: 1 }).lean();
    return { success: true, data: pages };
  }

  async getForSeller(storeId: string, sellerId: string, pageId: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    return { success: true, data: page };
  }

  async createPage(storeId: string, sellerId: string, dto: CreatePageDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    if (RESERVED_CUSTOM_PAGE_SLUGS.includes(dto.slug)) {
      throw new BadRequestException(`"${dto.slug}" is a reserved page slug — choose another`);
    }
    const existing = await this.storePageModel.findOne({ storeId, slug: dto.slug, isDelete: false });
    if (existing) throw new ConflictException(`A page with slug "${dto.slug}" already exists`);
    if ((await this.storePageModel.countDocuments({ storeId, isDelete: false })) >= MAX_PAGES_PER_STORE) {
      throw new BadRequestException(`A store can have at most ${MAX_PAGES_PER_STORE} pages`);
    }

    const page = await this.storePageModel.create({
      storeId,
      type: 'custom',
      slug: dto.slug,
      title: dto.title,
      sections: [],
      status: 'draft',
    });
    return { success: true, message: 'Page created', data: page };
  }

  async updatePage(storeId: string, sellerId: string, pageId: string, dto: UpdatePageDto) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    if (dto.slug !== undefined && page.type === 'home') {
      throw new BadRequestException('The home page slug cannot be changed');
    }
    if (dto.slug !== undefined && dto.slug !== page.slug) {
      if (RESERVED_CUSTOM_PAGE_SLUGS.includes(dto.slug)) {
        throw new BadRequestException(`"${dto.slug}" is a reserved page slug — choose another`);
      }
      const conflict = await this.storePageModel.findOne({ storeId, slug: dto.slug, isDelete: false, _id: { $ne: pageId } });
      if (conflict) throw new ConflictException(`A page with slug "${dto.slug}" already exists`);
    }

    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.slug !== undefined) set.slug = dto.slug;
    if (dto.showInNav !== undefined) set.showInNav = dto.showInNav;
    if (dto.showInFooter !== undefined) set.showInFooter = dto.showInFooter;
    if (dto.seo?.metaTitle !== undefined) set['seo.metaTitle'] = dto.seo.metaTitle;
    // `metaDesc` is a deprecated write-compat alias — a caller still only
    // sending it (not yet updated to `metaDescription`) still lands in the
    // real, full-parity field, not just the legacy one, so read paths never
    // need to check both once anything has been saved through here again.
    if (dto.seo?.metaDescription !== undefined) set['seo.metaDescription'] = dto.seo.metaDescription;
    else if (dto.seo?.metaDesc !== undefined) set['seo.metaDescription'] = dto.seo.metaDesc;
    if (dto.seo?.metaDesc !== undefined) set['seo.metaDesc'] = dto.seo.metaDesc;
    if (dto.seo?.ogImage !== undefined) set['seo.ogImage'] = dto.seo.ogImage;
    if (dto.seo?.ogTitle !== undefined) set['seo.ogTitle'] = dto.seo.ogTitle;
    if (dto.seo?.ogDescription !== undefined) set['seo.ogDescription'] = dto.seo.ogDescription;
    if (dto.seo?.twitterCard !== undefined) set['seo.twitterCard'] = dto.seo.twitterCard;
    if (dto.seo?.canonicalUrlOverride !== undefined) set['seo.canonicalUrlOverride'] = dto.seo.canonicalUrlOverride;
    if (dto.seo?.noindex !== undefined) set['seo.noindex'] = dto.seo.noindex;
    if (dto.seo?.keywords !== undefined) set['seo.keywords'] = dto.seo.keywords;

    const updated = await this.storePageModel.findByIdAndUpdate(pageId, { $set: set }, { returnDocument: 'after' });
    return { success: true, message: 'Page updated', data: updated };
  }

  async updateSections(storeId: string, sellerId: string, pageId: string, dto: UpdateSectionsDto) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    validateSections(dto.sections);
    const updated = await this.storePageModel.findByIdAndUpdate(pageId, { $set: { sections: dto.sections } }, { returnDocument: 'after' });
    return { success: true, message: 'Sections updated', data: updated };
  }

  async publish(storeId: string, sellerId: string, pageId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    const updated = await this.storePageModel.findByIdAndUpdate(pageId, { $set: { status: 'published' } }, { returnDocument: 'after' });
    return { success: true, message: 'Page published', data: updated };
  }

  async unpublish(storeId: string, sellerId: string, pageId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    const updated = await this.storePageModel.findByIdAndUpdate(pageId, { $set: { status: 'draft' } }, { returnDocument: 'after' });
    return { success: true, message: 'Page unpublished', data: updated };
  }

  async deletePage(storeId: string, sellerId: string, pageId: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    if (page.type === 'home') throw new ForbiddenException('The home page cannot be deleted');
    await this.storePageModel.findByIdAndUpdate(pageId, { $set: { isDelete: true } });
    return { success: true, message: 'Page deleted' };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async getPublicHome(storeId: string) {
    if (!(await isStoreLive(this.storeModel, storeId))) throw new NotFoundException('Store not found');
    const page = await this.storePageModel.findOne({ storeId, type: 'home', status: 'published', isDelete: false }).lean();
    if (!page) throw new NotFoundException('This store has no published home page yet');
    return { success: true, data: page };
  }

  async getPublicPage(storeId: string, slug: string) {
    if (!(await isStoreLive(this.storeModel, storeId))) throw new NotFoundException('Store not found');
    const page = await this.storePageModel.findOne({ storeId, slug, type: 'custom', status: 'published', isDelete: false }).lean();
    if (!page) throw new NotFoundException('Page not found');
    return { success: true, data: page };
  }

  async listPublicPages(storeId: string) {
    if (!(await isStoreLive(this.storeModel, storeId))) throw new NotFoundException('Store not found');
    const pages = await this.storePageModel
      .find({ storeId, type: 'custom', status: 'published', isDelete: false })
      .select('slug title showInNav showInFooter')
      .lean();
    return { success: true, data: pages };
  }
}
