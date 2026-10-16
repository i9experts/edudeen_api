import { CURRICULA } from './schemas/product.schema';
import { CLASS_VALUES } from './class-levels';
import { clampInt, queryString } from './product-public-view.util';
import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ProductsService } from './products.service';
import { ProductStockService } from './product-stock.service';
import { ProductOffersService } from './product-offers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

@Controller('api/products')
export class productController {
  constructor(
    private readonly ProductsService: ProductsService,
    private readonly productStockService: ProductStockService,
    private readonly productOffersService: ProductOffersService,
  ) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('products-by-category')
  async getProductsByCategoryId(
    @Req() req: any,
    @Query('id') id?: string,
    @Query('page') pageQuery?: string,
    @Query('limit') limitQuery?: string,
    @Query('productType') productType?: string,
    @Query('educationLevel') educationLevel?: string,
    @Query('normalizedCustomLevel') normalizedCustomLevel?: string,
    @Query('campaignId') campaignId?: string,
    @Query('minPrice') minPriceQuery?: string,
    @Query('maxPrice') maxPriceQuery?: string,
    @Query('minRating') minRatingQuery?: string,
    @Query('sortBy') sortByQuery?: string,
    @Query('attributes') attributesQuery?: string,
    @Query('q') searchQuery?: string,
    @Query('curriculum') curriculumQuery?: string,
    @Query('age') ageQuery?: string,
    @Query('featured') featuredQuery?: string,
    @Query('class') classQuery?: string,
    @Query('exact') exactQuery?: string,
  ) {
    // Express/qs hands back arrays and objects for ?x[]=1 / ?x[$ne]=1 even though these are typed as strings.
    id = queryString(id);
    searchQuery = queryString(searchQuery);
    productType = queryString(productType);
    educationLevel = queryString(educationLevel);
    normalizedCustomLevel = queryString(normalizedCustomLevel);
    campaignId = queryString(campaignId);
    const page = clampInt(pageQuery, 1, 1, 1000);
    const limit = clampInt(limitQuery, 10, 1, 50);
    const parseNum = (v?: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const allowedSorts = [
      'newest',
      'price_asc',
      'price_desc',
      'rating',
      'popularity',
    ];
    const sortBy = allowedSorts.includes(sortByQuery as string)
      ? (sortByQuery as
          | 'newest'
          | 'price_asc'
          | 'price_desc'
          | 'rating'
          | 'popularity')
      : undefined;

    // Shareable-URL friendly: ?attributes={"subject":["phonics"],"format":["pdf","google_slides"]}
    // A malformed value is treated as "no attribute filter" rather than a 400 —
    // a stale/hand-edited URL shouldn't break browsing.
    let attributesFilter: Record<string, string[]> | undefined;
    if (attributesQuery) {
      try {
        const parsed = JSON.parse(attributesQuery);
        if (parsed && typeof parsed === 'object') {
          attributesFilter = Object.fromEntries(
            Object.entries(parsed).filter(([, v]) => Array.isArray(v)),
          ) as Record<string, string[]>;
        }
      } catch {
        attributesFilter = undefined;
      }
    }

    const run = (term: string | undefined) => this.ProductsService.getProductsByCategoryId(
      id,
      page,
      limit,
      req.user?.userId ?? null,
      productType,
      educationLevel,
      normalizedCustomLevel,
      campaignId,
      parseNum(minPriceQuery),
      parseNum(maxPriceQuery),
      parseNum(minRatingQuery),
      sortBy,
      attributesFilter,
      term,
      {
        curriculum: CURRICULA.includes(curriculumQuery as any) ? curriculumQuery : undefined,
        age: ageQuery !== undefined && /^\d{1,2}$/.test(String(ageQuery)) ? Number(ageQuery) : undefined,
        featured: featuredQuery === '1' || featuredQuery === 'true',
        classValue: CLASS_VALUES.includes(queryString(classQuery) as string) ? (queryString(classQuery) as string) : undefined,
      },
    );
    // Typo tolerance only for real keyword searches (?exact=1 = "search instead for what I typed").
    return this.ProductsService.withSpellFix(searchQuery, exactQuery === '1' || exactQuery === 'true', run);
  }

  /** Public: up to 4 products for the Compare page (?ids=a,b,c) — same shaping/sanitising as listings. */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('compare')
  async compareProducts(@Req() req: any, @Query('ids') ids?: string) {
    const list = (queryString(ids, 400) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.ProductsService.getCompareProducts(list, req.user?.userId ?? null);
  }

  /** Members-only: the products with the biggest Premium discount (empty list for everyone else). */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('premium-deals')
  async premiumDeals(@Req() req: any, @Query('limit') limit?: string) {
    return this.ProductsService.getPremiumDeals(clampInt(limit, 12, 1, 24), req.user?.userId ?? null);
  }

  @Get('education/facets')
  async getEducationFacets() {
    return this.ProductsService.getEducationFacets();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('education/custom-level-suggestions')
  async getCustomLevelSuggestions(@Query('q') q: string = '') {
    return this.ProductsService.getCustomLevelSuggestions(q);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('getProductById/:id')
  async getProductById(@Req() req: any, @Param('id') id: string) {
    return this.ProductsService.getProductById(id, req.user?.userId ?? null, req.user?.role ?? null);
  }

  @Get('getVariantById/:variantId')
  async getVariantById(@Param('variantId') variantId: string) {
    return this.ProductsService.getVariantById(variantId);
  }

  // Public, pre-purchase preview of a digital product — watermarked/trimmed
  // derivative only, never the original file. Same guard as getProductById.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('preview/:id')
  async getProductPreview(@Req() req: any, @Param('id') id: string) {
    return this.ProductsService.getProductPreview(id, req.ip);
  }

  @Get('sample/:id')
  async getProductSample(@Req() req: any, @Param('id') id: string) {
    return this.ProductsService.getProductSample(id, req.ip);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('also-bought/:id')
  async getAlsoBought(@Req() req: any, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.ProductsService.getAlsoBought(id, clampInt(limit, 8, 1, 20), req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('add-physical-product')
  async addPhysicalProduct(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.addPhysicalProduct(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('add-digital-product')
  async addDigitalProduct(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.addDigitalProduct(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('get-my-product/:productId')
  async getSellerProductById(
    @Req() req: any,
    @Param('productId') productId: string,
  ) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.getSellerProductById(sellerId, productId);
  }

  // ── Storefront promotion sections — public, no auth required ──────────────
  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/pinned')
  async getPinnedProducts(@Req() req: any, @Param('storeId') storeId: string) {
    return this.ProductsService.getPinnedProducts(storeId, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/new-arrivals')
  async getNewArrivals(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limitQuery?: string) {
    const limit = Math.min(24, Math.max(1, parseInt(limitQuery as string) || 12));
    return this.ProductsService.getNewArrivals(storeId, limit, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/best-sellers')
  async getBestSellers(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limitQuery?: string) {
    const limit = Math.min(24, Math.max(1, parseInt(limitQuery as string) || 12));
    return this.ProductsService.getBestSellers(storeId, limit, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/trending')
  async getTrendingProducts(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limitQuery?: string) {
    const limit = Math.min(24, Math.max(1, parseInt(limitQuery as string) || 12));
    return this.ProductsService.getTrendingProducts(storeId, limit, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('store-products/:storeId')
  async getStoreProducts(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.getStoreProducts(sellerId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('edit-product')
  async editProduct(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.editProduct(sellerId, body);
  }

  // Bulk stock editing for the seller Inventory page: { storeId, updates: [{ variantId, stock }] }.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('stock/bulk')
  async bulkUpdateStock(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.productStockService.bulkUpdateStock(sellerId, String(body?.storeId ?? ''), body?.updates);
  }

  // Bulk Premium / platform-sale membership for the seller product list: { storeId, productIds[<=200], action, percent?, campaignId? }.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('bulk-offers')
  async bulkOffers(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.productOffersService.bulkOffers(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('delete-product/:productId')
  async deleteProduct(@Req() req: any, @Param('productId') productId: string) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.deleteProduct(sellerId, productId);
  }
}
