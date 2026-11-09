/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminOrdersService } from './admin-orders.service';
import { AdminCreateOrderService } from './admin-create-order.service';
import { AdminOrdersQueryDto } from './dto/admin-orders-query.dto';
import { CreateManualOrderDto, ManualOrderProductsQueryDto } from './dto/manual-order.dto';

@ApiTags('Admin Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly adminOrdersService: AdminOrdersService,
    private readonly adminCreateOrderService: AdminCreateOrderService,
  ) {}

  // Declared before ':id' so it is never swallowed as an order id.
  @Get('manual/products')
  searchManualOrderProducts(@Query() query: ManualOrderProductsQueryDto) {
    return this.adminCreateOrderService.searchProducts(query.q);
  }

  @Post('manual')
  createManualOrder(@Req() req: any, @Body() dto: CreateManualOrderDto) {
    return this.adminCreateOrderService.create(req.user.userId, dto);
  }

  @Get()
  list(@Query() query: AdminOrdersQueryDto) {
    return this.adminOrdersService.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseObjectIdPipe) id: string) {
    return this.adminOrdersService.detail(id);
  }
}
