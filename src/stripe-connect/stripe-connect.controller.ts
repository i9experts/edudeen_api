/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Body, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { StripeConnectService } from './stripe-connect.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateOnboardingLinkDto } from './dto/create-onboarding-link.dto';

@ApiTags('Stripe Connect')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/stripe-connect')
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  @Get('status')
  getStatus(@Req() req: any) {
    return this.stripeConnectService.getStatus(req.user.userId);
  }

  @Post('onboarding-link')
  @UsePipes(new ValidationPipe({ transform: true }))
  createOnboardingLink(@Req() req: any, @Body() dto: CreateOnboardingLinkDto) {
    return this.stripeConnectService.createOnboardingLink(req.user.userId, dto.refreshUrl, dto.returnUrl);
  }

  @Post('sync')
  sync(@Req() req: any) {
    return this.stripeConnectService.syncAccountStatus(req.user.userId);
  }
}
