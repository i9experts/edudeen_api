/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Post, Param, Body, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoContentService } from '../services/seo-content.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { BulkApplyProductTemplateDto } from '../dto/bulk-apply-template.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Product Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/products')
export class SellerProductSeoController {
  constructor(
    private readonly seoContent: SeoContentService,
    private readonly db: DatabaseService,
  ) {}

  // Static routes registered before the `:productId` catch-all, same discipline used throughout this codebase (Orders/POS).
  @Post('bulk-apply-template')
  async bulkApply(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkApplyProductTemplateDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoContent.bulkApplyProductTemplate(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @Get('export')
  async exportCsv(@Req() req: any, @Param('storeId') storeId: string, @Res() res: Response) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    const csv = await this.seoContent.exportProductSeoCsv(storeId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="product-seo-${storeId}.csv"`);
    res.send(csv);
  }

  /** Search-visibility list (products that still need something). Declared before `:productId`. */
  @Get('visibility')
  async visibility(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoContent.listSearchVisibility(storeId, query);
  }

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoContent.listProductSeo(storeId, query);
  }

  @Get(':productId')
  async getOne(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoContent.getProductSeo(storeId, productId);
  }

  @Patch(':productId')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string, @Body() dto: UpdateSeoMetaDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.seoContent.updateProductSeo(storeId, productId, dto, { id: req.user.userId, role: req.user.role });
  }
}
