/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminReauthGuard, RequireReauth } from '../admin-reauth/admin-reauth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PremiumService } from './premium.service';
import {
  CreatePremiumPlanDto, GrantPremiumDto, RejectPremiumPaymentDto, RevokePremiumDto, SubmitPremiumProofDto, SubscribePremiumDto, UpdatePremiumPlanDto, UpdatePremiumSettingsDto,
} from './premium.dto';

const PROOF_UPLOAD_OPTIONS = { storage: memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } };
const PIPE = new ValidationPipe({ transform: true, whitelist: true });

@ApiTags('Edudeen Premium (buyer)')
@Controller('api/premium')
export class PremiumController {
  constructor(private readonly premium: PremiumService) {}

  /** Public: the plans a buyer can choose from (USD + PKR prices, benefits). */
  @Get('plans')
  plans() { return this.premium.listPublicPlans(); }

  /** Public: platform offer %, fee on premium sales, min gap, and (with ?type=&currency=) the normal platform fee for that product type. */
  @Get('terms')
  terms(@Query('type') type?: string, @Query('currency') currency?: string, @Query('storeId') storeId?: string) { return this.premium.getTerms(type, currency, storeId); }

  /** Seller: products whose normal sale is too close to their Premium discount (warning list for the store settings card). */
  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('seller')
  @Get('seller/conflicts')
  sellerConflicts(@Req() req: any, @Query('storeId') storeId: string) { return this.premium.sellerPremiumConflicts(req.user.userId, storeId); }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Get('me')
  me(@Req() req: any) { return this.premium.me(req.user.userId); }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Get('bank-details')
  async bankDetails() { return { success: true, data: await this.premium.getBankDetails() }; }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Get('payments')
  payments(@Req() req: any) { return this.premium.myPayments(req.user.userId); }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(PIPE)
  @Post('subscribe')
  subscribe(@Req() req: any, @Body() dto: SubscribePremiumDto) { return this.premium.subscribe(req.user.userId, dto); }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', PROOF_UPLOAD_OPTIONS))
  @UsePipes(PIPE)
  @Post('payments/:paymentId/proof')
  proof(@Req() req: any, @Param('paymentId') paymentId: string, @Body() dto: SubmitPremiumProofDto, @UploadedFile() file: Express.Multer.File) {
    return this.premium.submitProof(req.user.userId, paymentId, dto, file);
  }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Post('cancel')
  cancel(@Req() req: any) { return this.premium.cancel(req.user.userId); }

  @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles('user')
  @Post('resume')
  resume(@Req() req: any) { return this.premium.resume(req.user.userId); }
}

@ApiTags('Edudeen Premium (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
@Roles('admin')
@Controller('api/admin/premium')
export class AdminPremiumController {
  constructor(private readonly premium: PremiumService) {}

  @Get('stats') stats() { return this.premium.adminStats(); }

  @Get('settings') settings() { return this.premium.adminGetSettings(); }
  @Put('settings')
  updateSettings(@Req() req: any, @Body() body: UpdatePremiumSettingsDto) { return this.premium.adminUpdateSettings(req.user.userId, body); }

  @Get('plans') plans() { return this.premium.adminListPlans(); }
  @UsePipes(PIPE) @Post('plans')
  createPlan(@Req() req: any, @Body() dto: CreatePremiumPlanDto) { return this.premium.adminCreatePlan(req.user.userId, dto); }
  @UsePipes(PIPE) @Patch('plans/:id')
  updatePlan(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePremiumPlanDto) { return this.premium.adminUpdatePlan(req.user.userId, id, dto); }
  @Delete('plans/:id')
  deletePlan(@Req() req: any, @Param('id') id: string) { return this.premium.adminDeletePlan(req.user.userId, id); }

  @Get('members') members(@Query() query: any) { return this.premium.adminListMembers(query); }
  @RequireReauth() @UsePipes(PIPE) @Post('members/grant')
  grant(@Req() req: any, @Body() dto: GrantPremiumDto) { return this.premium.adminGrant(req.user.userId, dto); }
  @UsePipes(PIPE) @Post('members/:userId/revoke')
  revoke(@Req() req: any, @Param('userId') userId: string, @Body() dto: RevokePremiumDto) { return this.premium.adminRevoke(req.user.userId, userId, dto.reason); }

  @Get('payments') payments(@Query() query: any) { return this.premium.adminListPayments(query); }
  @Get('payments/:id/proof-url') proofUrl(@Param('id') id: string) { return this.premium.adminProofUrl(id); }
  @RequireReauth() @Patch('payments/:id/approve') approve(@Req() req: any, @Param('id') id: string) { return this.premium.adminApprove(req.user.userId, id); }
  @UsePipes(PIPE) @Patch('payments/:id/reject')
  reject(@Req() req: any, @Param('id') id: string, @Body() dto: RejectPremiumPaymentDto) { return this.premium.adminReject(req.user.userId, id, dto.reason); }
}
