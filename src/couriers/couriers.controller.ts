import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CouriersService } from './couriers.service';

@Controller('api/couriers')
export class CouriersController {
  constructor(private readonly service: CouriersService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get()
  list() {
    return this.service.listCouriers();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('shipments')
  create(@Req() req: any, @Body() body: any) {
    return this.service.createShipment(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('shipments/label')
  label(@Req() req: any, @Query('storeId') storeId: string, @Query('orderId') orderId: string) {
    return this.service.getLabel(req.user.userId, storeId, orderId);
  }

  // Courier status webhook: shared-secret header, no bearer token.
  @Post(':courier/webhook')
  webhook(
    @Param('courier') courier: string,
    @Headers('x-webhook-secret') secret: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Body() body: any,
  ) {
    const presented = secret ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
    return this.service.handleWebhook(courier, presented, body);
  }
}
