/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Put, Patch, Body, Req, Param, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreService } from './store.service';
import { StoreCustomersService } from './store-customers.service';
import { StoreCustomerNoteDto } from './dto/store-customer-note.dto';

@Controller('api/store')
export class StoreController {
  constructor(private readonly storeService: StoreService, private readonly customersService: StoreCustomersService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('create-store')
  async createStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.createStore(userId, body);
  }

  // seller ke saare stores
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('my-stores')
  async getMyStores(@Req() req: any) {
    const { userId } = req.user;
    return this.storeService.getMyStores(userId);
  }

  // Deliberately left without a mandatory auth guard — POS pin-login and other
  // shared-device flows fetch a store before any seller session exists.
  // `OptionalJwtAuthGuard` lets an authenticated *owning* seller additionally
  // receive their own contact/stat fields (see StoreService.getStoreById)
  // without exposing that PII to anonymous/other callers.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('getStoreById/:storeId')
  async getStoreById(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.getStoreById(storeId, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/custom-domain')
  async setCustomDomain(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { domain: string | null }) {
    return this.storeService.setCustomDomain(req.user.userId, storeId, body.domain ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/custom-domain/verify')
  async verifyCustomDomain(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.verifyCustomDomain(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/white-label')
  async setWhiteLabel(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { enabled: boolean }) {
    return this.storeService.setWhiteLabel(req.user.userId, storeId, !!body.enabled);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/pinned-products')
  async updatePinnedProducts(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { productIds: string[] }) {
    return this.storeService.updatePinnedProducts(req.user.userId, storeId, body.productIds ?? []);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/holiday')
  async setHoliday(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() body: any) {
    return this.storeService.setHoliday(req.user.userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/announcement')
  async updateAnnouncementBar(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.storeService.updateAnnouncementBar(req.user.userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('update-store')
  async updateStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    const { storeId, ...updateData } = body;
    return this.storeService.updateStore(userId, storeId, updateData);
  }

  // ── Builder APIs ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('save-builder-config')
  async saveBuilderConfig(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.saveBuilderConfig(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('builder-config/:storeId')
  async getBuilderConfig(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.getBuilderConfig(userId, storeId);
  }

  // ── Public Storefront APIs ────────────────────────────────────────────────

  // Static segments ('public', 'public/top') must be declared before the
  // 'public/:slug' param route below, or they'd be swallowed by it.
  @Get('public')
  async listPublicStores(@Query() query: any) {
    return this.storeService.listPublicStores(query);
  }

  @Get('public/top')
  async getTopStores(@Query('limit') limit?: string) {
    return this.storeService.getTopStores(Math.min(20, parseInt(limit || '10') || 10));
  }

  @Get('public/platform-stats')
  async getPlatformStats() {
    return this.storeService.getPlatformStats();
  }

// Registered BEFORE 'public/:slug' — a static path segment must be matched
  // first, or Nest would swallow 'resolve-domain' as `:slug`.
  @Get('public/resolve-domain')
  async resolveStoreByDomain(@Query('host') host: string) {
    return this.storeService.getPublicStoreByDomain(host);
  }

  @Get('public/:slug')
  async getPublicStore(@Param('slug') slug: string) {
    return this.storeService.getPublicStore(slug);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/:storeId/products')
  async getPublicStoreProducts(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    return this.storeService.getPublicStoreProducts(storeId, query, req.user?.userId ?? null);
  }

  @Get('public/:storeId/catalog-facets')
  async getCatalogFacets(@Param('storeId') storeId: string) {
    return this.storeService.getCatalogFacets(storeId);
  }

  @Get('public/:storeId/filters')
  async getPublicStoreFilters(@Param('storeId') storeId: string) {
    return this.storeService.getPublicStoreFilters(storeId);
  }

  // ── Follow APIs ───────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post(':storeId/follow')
  async followStore(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.followStore(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get(':storeId/follow-status')
  async getFollowStatus(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.getFollowStatus(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/followers')
  async getStoreFollowers(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Query() query: any,
  ) {
    return this.customersService.getFollowers(req.user.userId, storeId, query);
  }

  // ── Customers (seller-facing, contact details masked; read-only — a seller can never edit a buyer) ──

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/customers')
  async getStoreCustomers(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Query() query: any) {
    return this.customersService.getCustomers(req.user.userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/customers/:customerId')
  async getStoreCustomer(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Param('customerId', ParseObjectIdPipe) customerId: string,
  ) {
    return this.customersService.getCustomerDetail(req.user.userId, storeId, customerId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Put(':storeId/customers/:customerId/note')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async saveCustomerNote(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Param('customerId', ParseObjectIdPipe) customerId: string,
    @Body() dto: StoreCustomerNoteDto,
  ) {
    return this.customersService.saveNote(req.user.userId, storeId, customerId, dto);
  }
}
