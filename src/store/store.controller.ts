/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Patch, Body, Req, Param, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreService } from './store.service';
import { UpdateStoreCustomerDto } from './dto/update-store-customer.dto';

@Controller('api/store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('create-store')
  async createStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.createStore(userId, body);
  }

  // Store-independent requirements preview — used by onboarding BEFORE a
  // store exists (the store isn't created until the final submit step, so
  // there's no storeId yet to scope the existing `:storeId/verification/
  // requirements` route to). Pure function of country+businessType, no
  // ownership check needed. Declared as a literal segment ahead of the
  // `:storeId/...` block below so `:storeId` never swallows "verification"
  // as if it were a store id.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('verification/requirements-preview')
  async previewVerificationRequirementsStandalone(@Query() query: { country?: string; businessType?: string }) {
    return this.storeService.previewVerificationRequirementsStandalone(query);
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
  @Patch(':storeId/announcement')
  async updateAnnouncementBar(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.storeService.updateAnnouncementBar(req.user.userId, storeId, body);
  }

  // ── Seller business verification (Leads review) ────────────────────────
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/verification')
  async getVerification(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.getVerification(req.user.userId, storeId);
  }

  // Live "what would I need" preview as the seller picks country/business
  // type, before anything is saved — see StoreService.getVerificationRequirements.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/verification/requirements')
  async getVerificationRequirements(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: { country?: string; businessType?: string },
  ) {
    return this.storeService.getVerificationRequirements(req.user.userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/verification')
  async updateVerification(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.storeService.updateVerification(req.user.userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/verification/documents')
  async attachVerificationDocument(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() body: { type: string; publicId: string; resourceType: string; fileName: string },
  ) {
    return this.storeService.attachVerificationDocument(req.user.userId, storeId, body.type, {
      publicId: body.publicId,
      resourceType: body.resourceType,
      fileName: body.fileName,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/verification/submit')
  async submitVerification(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.submitVerification(req.user.userId, storeId);
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
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId } = req.user;
    return this.storeService.getStoreFollowers(userId, storeId, query);
  }

  // ── Customers (staff-facing) ─────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/customers')
  async getStoreCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    const { userId } = req.user;
    return this.storeService.getStoreCustomers(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/customers/:customerId')
  @UsePipes(new ValidationPipe({ transform: true }))
  async updateStoreCustomer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateStoreCustomerDto,
  ) {
    const { userId } = req.user;
    return this.storeService.updateStoreCustomer(userId, storeId, customerId, dto, req.ip, req.headers['user-agent']);
  }
}