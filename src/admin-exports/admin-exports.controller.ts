/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminReauthGuard, RequireReauth } from '../admin-reauth/admin-reauth.guard';
import { AdminExportsService } from './admin-exports.service';

/**
 * CSV exports. Staff need the dedicated `<module>.export` right for each path (permissions.ts); an unmapped path
 * under /api/admin/exports is denied for staff. The owner always passes.
 */
@ApiTags('Admin Exports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
@Roles('admin')
@RequireReauth() // a bulk download of personal data asks for the admin password (X-Admin-Reauth) like money actions do
@Controller('api/admin/exports')
export class AdminExportsController {
  constructor(private readonly exportsService: AdminExportsService) {}

  private actor(req: any) { return { id: req.user?.userId, name: req.user?.name ?? req.user?.email ?? null }; }
  private send(res: Response, file: string, csv: string) {
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${file}.csv"`);
    res.header('Cache-Control', 'no-store');
    res.send(csv);
  }

  @Get('users') async users(@Req() req: any, @Query() q: any, @Res() res: Response) { this.send(res, 'users', await this.exportsService.users(q, this.actor(req))); }
  @Get('orders') async orders(@Req() req: any, @Query() q: any, @Res() res: Response) { this.send(res, 'orders', await this.exportsService.orders(q, this.actor(req))); }
  @Get('listings') async listings(@Req() req: any, @Query() q: any, @Res() res: Response) { this.send(res, 'listings', await this.exportsService.listings(q, this.actor(req))); }
  @Get('payment-proofs') async proofs(@Req() req: any, @Query() q: any, @Res() res: Response) { this.send(res, 'payment-proofs', await this.exportsService.paymentProofs(q, this.actor(req))); }
}
