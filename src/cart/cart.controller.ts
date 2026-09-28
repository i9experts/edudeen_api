import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
  Get,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CartService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('api/cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @UseGuards(JwtAuthGuard)
  @Post('add-to-cart')
  async addToCart(@Req() req: any, @Body() dto: AddToCartDto) {
    const { userId } = req.user;

    return this.cartService.addToCart(userId, dto.storeId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-carts')
  async getMyCarts(@Req() req: any) {
    const { userId } = req.user;
    return this.cartService.getMyCarts(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-cart')
  async getCart(@Req() req: any, @Query('storeId') storeId: string) {
    const { userId } = req.user;

    return this.cartService.getCart(userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('update-cart-quantity')
  async updateCartQuantity(@Req() req: any) {
    const { userId } = req.user;
    const { storeId } = req.body;

    return this.cartService.updateCartQuantity(userId, storeId, req.body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('remove-cart-item')
  async removeCartItem(@Req() req: any) {
    const { userId } = req.user;
    const { storeId } = req.body;

    return this.cartService.removeCartItem(userId, storeId, req.body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('clear-cart')
  async clearCart(@Req() req: any, @Body('storeId') storeId: string) {
    const { userId } = req.user;

    return this.cartService.clearCart(userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('add-to-wishlist')
  async addToWishlist(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    const { storeId } = body;

    return this.cartService.addToWishlist(userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-wishlist')
  async getWishlist(@Req() req: any, @Query('storeId') storeId: string) {
    const { userId } = req.user;
    return this.cartService.getWishlist(userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-wishlist-item')
  async getWishlistItem(@Req() req: any, @Query() query: any) {
    const { userId } = req.user;
    return this.cartService.getWishlistItem(userId, query.storeId, query);
  }

  @UseGuards(JwtAuthGuard)
  @Post('remove-from-wishlist')
  async removeFromWishlist(
    @Req() req: any,
    @Body('wishlistId') wishlistId: string,
    @Body('storeId') storeId: string,
  ) {
    const { userId } = req.user;
    return await this.cartService.removeFromWishlist(userId, storeId, wishlistId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('clear-wishlist')
  async clearWishlist(@Req() req: any, @Body('storeId') storeId: string) {
    const { userId } = req.user;
    return this.cartService.clearWishlist(userId, storeId);
  }
}
