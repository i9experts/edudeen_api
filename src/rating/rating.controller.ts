import {
  Controller,
  Post,
  Put,
  Patch,
  Delete,
  Get,
  Body,
  Param,
  Req,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RatingService } from './rating.service';
import { AddReviewDto } from './dto/add-review.dto';
import { EditReviewDto } from './dto/edit-review.dto';
import { SellerReplyDto } from './dto/seller-reply.dto';

@Controller('api/rating')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — write their own review
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('add-review')
  async addReview(@Req() req: any, @Body() body: AddReviewDto) {
    const { userId } = req.user;
    return this.ratingService.addReview(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('my-reviews')
  async getMyReviews(@Req() req: any, @Query() query: any) {
    const { userId } = req.user;
    return this.ratingService.getMyReviews(userId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Patch(':reviewId')
  async editReview(
    @Req() req: any,
    @Param('reviewId') reviewId: string,
    @Body() body: EditReviewDto,
  ) {
    const { userId } = req.user;
    return this.ratingService.editReview(userId, reviewId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Delete(':reviewId')
  async deleteReview(@Req() req: any, @Param('reviewId') reviewId: string) {
    const { userId } = req.user;
    return this.ratingService.deleteReview(userId, reviewId);
  }

  // Any logged-in buyer can vote — toggles on/off, not role-restricted to 'user'
  // since a seller/admin browsing as a customer should be able to vote too.
  @UseGuards(JwtAuthGuard)
  @Post(':reviewId/helpful')
  async toggleHelpful(@Req() req: any, @Param('reviewId') reviewId: string) {
    const { userId } = req.user;
    return this.ratingService.toggleHelpful(userId, reviewId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC / BUYER-FACING — read reviews for a product
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(OptionalJwtAuthGuard)
  @Get('product/:productId')
  async getProductReviews(
    @Req() req: any,
    @Param('productId') productId: string,
    @Query() query: any,
  ) {
    const viewerId = req.user?.userId ?? null;
    return this.ratingService.getProductReviews(productId, query, viewerId);
  }

  /** Public: a store's best recent written reviews (storefront testimonials fallback). */
  @Get('store/:storeId/public')
  async getPublicStoreReviews(
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    return this.ratingService.getPublicStoreReviews(storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER / ADMIN — manage reviews on their store
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('store-reviews/:storeId')
  async getStoreReviews(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId: sellerId, role } = req.user;
    return this.ratingService.getStoreReviews(sellerId, role, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post('reply/:reviewId')
  async replyToReview(
    @Req() req: any,
    @Param('reviewId') reviewId: string,
    @Body() body: SellerReplyDto,
  ) {
    const { userId: sellerId, role } = req.user;
    return this.ratingService.replyToReview(sellerId, role, reviewId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Put('edit-reply/:reviewId')
  async editReply(
    @Req() req: any,
    @Param('reviewId') reviewId: string,
    @Body() body: SellerReplyDto,
  ) {
    const { userId: sellerId, role } = req.user;
    return this.ratingService.editReply(sellerId, role, reviewId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post('flag/:reviewId')
  async flagReview(@Req() req: any, @Param('reviewId') reviewId: string) {
    const { userId: sellerId, role } = req.user;
    return this.ratingService.flagReview(sellerId, role, reviewId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Patch('unflag/:reviewId')
  async unflagReview(@Req() req: any, @Param('reviewId') reviewId: string) {
    const { userId: sellerId, role } = req.user;
    return this.ratingService.unflagReview(sellerId, role, reviewId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Delete('admin/:reviewId')
  async moderateDeleteReview(
    @Req() req: any,
    @Param('reviewId') reviewId: string,
  ) {
    const { userId: sellerId, role } = req.user;
    return this.ratingService.moderateDeleteReview(sellerId, role, reviewId);
  }
}
