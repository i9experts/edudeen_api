import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { InventoryService } from './inventory.service';

@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('getStoreInventory/:storeId')
  async getStoreInventory(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId } = req.user;
    return this.inventoryService.getStoreInventory(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('low-stock-summary/:storeId')
  async getLowStockSummary(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.inventoryService.getLowStockSummary(userId, storeId);
  }

  // Last 20 stock changes of one product (manual + bulk). Seller only, own store only.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('stock-history/:storeId/:productId')
  async getStockHistory(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Param('productId', ParseObjectIdPipe) productId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.getStockHistory(req.user.userId, storeId, productId, limit);
  }

  // Per-product "running low" line: { threshold: 0..1000 | null (= default 10) }.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('low-stock-threshold/:storeId/:productId')
  async setLowStockThreshold(
    @Req() req: any,
    @Param('storeId', ParseObjectIdPipe) storeId: string,
    @Param('productId', ParseObjectIdPipe) productId: string,
    @Body() body: any,
  ) {
    return this.inventoryService.setLowStockThreshold(req.user.userId, storeId, productId, body?.threshold);
  }
}
