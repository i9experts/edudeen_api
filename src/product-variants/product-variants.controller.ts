import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProductVariantsService } from './product-variants.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';

@Controller('api/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
export class ProductVariantsController {
  constructor(private readonly productVariantsService: ProductVariantsService) {}

  @Get(':productId/variants')
  async listVariants(@Req() req: any, @Param('productId') productId: string) {
    const { userId: sellerId } = req.user;
    return this.productVariantsService.listVariants(sellerId, productId);
  }

  // Validate only (no transform): `options` sub-objects are persisted as-is.
  @Post(':productId/variants')
  @UsePipes(new ValidationPipe())
  async addVariant(
    @Req() req: any,
    @Param('productId') productId: string,
    @Body() body: CreateVariantDto,
  ) {
    const { userId: sellerId } = req.user;
    return this.productVariantsService.addVariant(sellerId, productId, body);
  }

  // Validate only (no transform): `options` sub-objects are persisted as-is.
  @Patch(':productId/variants/:variantId')
  @UsePipes(new ValidationPipe())
  async updateVariant(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() body: UpdateVariantDto,
  ) {
    const { userId: sellerId } = req.user;
    return this.productVariantsService.updateVariant(sellerId, productId, variantId, body);
  }

  @Delete(':productId/variants/:variantId')
  async deleteVariant(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ) {
    const { userId: sellerId } = req.user;
    return this.productVariantsService.deleteVariant(sellerId, productId, variantId);
  }
}
