// import { Controller, Get, Put, Param, Req, UseGuards } from '@nestjs/common';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { RolesGuard } from '../auth/guards/roles.guard';
// import { OrdersService } from './orders.service';

// @Controller('api/orders')
// export class OrdersController {
//   constructor(private readonly ordersService: OrdersService) {}

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Get('myOrders')
//   async getMyOrders(@Req() req: any) {
//     const { userId } = req.user;
//     return this.ordersService.getMyOrders(userId);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Get(':orderId')
//   async getOrderById(@Req() req: any, @Param('orderId') orderId: string) {
//     const { userId } = req.user;
//     return this.ordersService.getOrderById(userId, orderId);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Put('cancel/:orderId')
//   async cancelOrder(@Req() req: any, @Param('orderId') orderId: string) {
//     const { userId } = req.user;
//     return this.ordersService.cancelOrder(userId, orderId);
//   }
// }

import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { OrdersService } from './orders.service';

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('my-orders')
  async getOrdersByUserId(@Req() req: any, @Query() query: any) {
    const { userId } = req.user;
    return this.ordersService.getOrdersByUserId(userId, query);
  }

  // signed URLs (non-stamped) + stamped stream URLs list
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('download-url')
  async getDownloadUrls(
    @Req() req: any,
    @Query('orderId') orderId: string,
    @Query('productId') productId: string,
  ) {
    const { userId } = req.user;
    return this.ordersService.getDownloadUrls(userId, orderId, productId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Put('mark-paid/:orderId')
  async markPaid(@Req() req: any, @Param('orderId') orderId: string) {
    const { userId, role } = req.user;
    return this.ordersService.markPaid(orderId, { userId, role });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Put('update-status')
  async updateSellerOrderStatus(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.ordersService.updateSellerOrderStatus(
      userId,
      body,
      req.ip,
      req.headers['user-agent'],
    );
  }

  // Static path — must be declared before `seller-orders/:storeId` below, otherwise
  // that param route would swallow this literal segment as `storeId: 'my'`.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('seller-orders/my')
  async getMySellerOrders(@Req() req: any, @Query() query: any) {
    const { userId } = req.user;
    return this.ordersService.getSellerOrders(userId, null, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('seller-orders/:storeId')
  async getSellerOrders(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId } = req.user;
    return this.ordersService.getSellerOrders(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('cancel/:orderId')
  async cancelOrder(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    const { userId } = req.user;
    return this.ordersService.cancelOrder(userId, orderId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('returns')
  async getSellerReturns(@Req() req: any, @Query() query: any) {
    const { userId: sellerId } = req.user;
    return this.ordersService.getSellerReturns(sellerId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('return-request/:orderId')
  async returnRequest(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    const { userId } = req.user;
    return this.ordersService.returnRequest(userId, orderId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Put('return-action/:orderId')
  async returnAction(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    const { userId: sellerId } = req.user;
    return this.ordersService.returnAction(
      sellerId,
      orderId,
      body,
      req.ip,
      req.headers['user-agent'],
    );
  }

  // Step 1: JWT se download link lo (10 min valid)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('get-download-link')
  async getDownloadLink(
    @Req() req: any,
    @Query('orderId') orderId: string,
    @Query('productId') productId: string,
    @Query('fileIndex') fileIndex: string,
  ) {
    const { userId } = req.user;
    const index = parseInt(fileIndex) || 0;
    return this.ordersService.getDownloadLink(
      userId,
      orderId,
      productId,
      index,
    );
  }

  // Step 2: yeh URL browser mein paste karo — seedha download (no auth header)
  @Get('download-file')
  async downloadFile(@Res() res: Response, @Query('token') token: string) {
    const { buffer, fileName, mimeType } =
      await this.ordersService.downloadByToken(token);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // stamped PDF via token — browser direct download (no JWT header)
  @Get('stream-pdf-token')
  async streamPdfByToken(@Res() res: Response, @Query('token') token: string) {
    const { buffer, fileName } =
      await this.ordersService.streamStampedPdfByToken(token);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // stamped PDF stream — browser direct download
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('stream-pdf')
  async streamPdf(
    @Req() req: any,
    @Res() res: Response,
    @Query('orderId') orderId: string,
    @Query('productId') productId: string,
    @Query('fileIndex') fileIndex: string,
  ) {
    const { userId } = req.user;
    const index = parseInt(fileIndex) || 0;

    const { buffer, fileName } = await this.ordersService.streamStampedPdf(
      userId,
      orderId,
      productId,
      index,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }

  // must be last — catches any GET /:orderId after all static routes
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get(':orderId')
  async getOrderById(@Req() req: any, @Param('orderId') orderId: string) {
    const { userId } = req.user;
    return this.ordersService.getOrderById(userId, orderId);
  }
}
