import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

@Controller('api/products')
export class productController {
  constructor(private readonly ProductsService: ProductsService) {}

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
  ) {
    const page = Math.max(1, parseInt(pageQuery as string) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(limitQuery as string) || 10),
    );
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

    return this.ProductsService.getProductsByCategoryId(
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
    );
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
    return this.ProductsService.getProductById(id, req.user?.userId ?? null);
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('delete-product/:productId')
  async deleteProduct(@Req() req: any, @Param('productId') productId: string) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.deleteProduct(sellerId, productId);
  }
}
