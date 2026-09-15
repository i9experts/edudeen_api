import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AttributesService } from './attributes.service';
import { SetProductAttributesDto } from './dto/set-product-attributes.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

// Kept separate from `products.controller.ts` so the existing, already large
// product controller/service stay untouched by this new feature.
@Controller('api/products')
export class ProductAttributesController {
  constructor(private readonly attributesService: AttributesService) {}

  @Get(':productId/attributes')
  async getProductAttributes(@Param('productId') productId: string) {
    return this.attributesService.getProductAttributes(productId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Put(':productId/attributes')
  async setProductAttributes(
    @Req() req: any,
    @Param('productId') productId: string,
    @Body() dto: SetProductAttributesDto,
  ) {
    const { userId: sellerId } = req.user;
    return this.attributesService.setProductAttributes(sellerId, productId, dto);
  }
}
