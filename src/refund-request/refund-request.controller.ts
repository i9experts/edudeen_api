import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { RefundRequestService } from './refund-request.service';
import { CreateRefundRequestDto, RejectRefundRequestDto } from './dto/refund-request.dto';

@ApiTags('Refund Requests')
@ApiBearerAuth()
@Controller('api/refund-request')
export class RefundRequestController {
  constructor(private readonly refundRequestService: RefundRequestService) {}

  // Buyer or seller — role comes straight from the JWT, matching this
  // codebase's existing convention (e.g. UsersService.changePassword).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @UsePipes(new ValidationPipe({ transform: true }))
  @Post()
  async create(@Req() req: any, @Body() dto: CreateRefundRequestDto) {
    return this.refundRequestService.createRequest(req.user.userId, req.user.role, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'seller', 'admin')
  @Get('order/:orderId')
  async listForOrder(@Req() req: any, @Param('orderId') orderId: string) {
    return this.refundRequestService.listForOrder(req.user.userId, req.user.role, orderId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/pending')
  async listPending(@Query('page') page = '1', @Query('limit') limit = '20') {
    return this.refundRequestService.listPending(Number(page) || 1, Number(limit) || 20);
  }

  // Seller's own refund requests, across just their store — ownership
  // verified inside the service.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId')
  async listForSeller(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.refundRequestService.listForSeller(req.user.userId, storeId, Number(page) || 1, Number(limit) || 20);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @Patch(':id/approve')
  async approve(@Req() req: any, @Param('id') id: string) {
    return this.refundRequestService.approve(req.user.userId, req.user.role, id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @UsePipes(new ValidationPipe({ transform: true }))
  @Patch(':id/reject')
  async reject(@Req() req: any, @Param('id') id: string, @Body() dto: RejectRefundRequestDto) {
    return this.refundRequestService.reject(req.user.userId, req.user.role, id, dto.notes);
  }
}
