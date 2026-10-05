/* eslint-disable prettier/prettier */
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { clampInt, queryString } from '../products/product-public-view.util';
import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guards/optional-jwt-auth.guard';
import { SearchService } from './search.service';

/** Buyer search: keyword product search (public; history recorded when a JWT
 *  is present) plus the per-user recent-searches and recently-viewed lists
 *  behind it. History routes need only a login, not a role — a seller
 *  browsing as a customer gets the same experience. */
@Controller('api/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('products')
  searchProducts(@Req() req: any, @Query() query: any) {
    // Query values can arrive as arrays/objects (?q[]=a, ?q[$ne]=1): coerce, bound, never .trim() a non-string.
    const page = clampInt(query.page, 1, 1, 1000);
    const limit = clampInt(query.limit, 20, 1, 50);
    // suggest=1 = search-as-you-type preview: don't save half-typed terms to the buyer's history.
    const userId = query.suggest === '1' ? null : req.user?.userId ?? null;
    return this.searchService.searchProducts(queryString(query.q, 100) ?? '', page, limit, userId, req.user?.userId ?? null);
  }

  /** Public: popular search terms across all buyers (for the search box). */
  @Get('trending')
  getTrending(@Query() query: any) {
    return this.searchService.getTrendingSearches(clampInt(query.limit, 8, 1, 20));
  }

  @Get('stores')
  searchStores(@Query() query: any) {
    const page = clampInt(query.page, 1, 1, 1000);
    const limit = clampInt(query.limit, 20, 1, 50);
    return this.searchService.searchStores(queryString(query.q, 100) ?? '', page, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Get('recent')
  getRecentSearches(@Req() req: any, @Query() query: any) {
    const limit = clampInt(query.limit, 10, 1, 50);
    return this.searchService.getRecentSearches(req.user.userId, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recent')
  clearRecentSearches(@Req() req: any) {
    return this.searchService.clearRecentSearches(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recent/:searchId')
  deleteRecentSearch(@Req() req: any, @Param('searchId') searchId: string) {
    return this.searchService.deleteRecentSearch(req.user.userId, searchId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('recently-viewed')
  getRecentlyViewed(@Req() req: any, @Query() query: any) {
    const limit = Math.max(1, clampInt(query.limit, 10, 1, 100));
    return this.searchService.getRecentlyViewed(req.user.userId, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Post('recently-viewed')
  recordProductView(@Req() req: any, @Body('productId', ParseObjectIdPipe) productId: string) {
    return this.searchService.recordProductView(req.user.userId, productId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recently-viewed')
  clearRecentlyViewed(@Req() req: any) {
    return this.searchService.clearRecentlyViewed(req.user.userId);
  }
}
