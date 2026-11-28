/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { EXPORT_FORMATS, exportTable, type ExportFormat } from '../accounting/export.util';
import { PayrollService, type PayActor } from './payroll.service';
import { RECEIPT_MAX_BYTES } from './payroll.constants';

const actorOf = (req: any): PayActor => {
  const perms: Set<string> | undefined = req.staffPermissions;
  return { id: String(req.user.userId), isOwner: !perms, permissions: perms ?? null, ip: req.ip, userAgent: req.headers?.['user-agent'] };
};

const sendFile = (res: Response, body: Buffer, fileName: string, contentType: string) => {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
};

/**
 * Self-service for every admin-panel account (staff or owner): their own pay summary, month-to-date estimate,
 * claims and payslips. Never anyone else's data. permissions.ts lets every staff member reach /payroll/me.
 */
@ApiTags('Admin — Payroll (me)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/payroll/me')
export class PayrollMeController {
  constructor(private readonly payroll: PayrollService) {}

  @Get()
  async summary(@Req() req: any) {
    const id = actorOf(req).id;
    const [summary, reports] = await Promise.all([this.payroll.mySummary(id), this.payroll.myReports(id)]);
    return { success: true, data: { ...summary, ...reports } };
  }

  @Get('estimate')
  async estimate(@Req() req: any) { return { success: true, data: await this.payroll.myEstimate(actorOf(req).id) }; }

  @Get('payslips')
  async payslips(@Req() req: any) { return { success: true, data: await this.payroll.myPayslips(actorOf(req).id) }; }

  @Get('payslips/:runId')
  async payslip(@Req() req: any, @Param('runId', ParseObjectIdPipe) runId: string, @Res() res: Response) {
    const actor = actorOf(req);
    const f = await this.payroll.payslipPdf(actor, runId, actor.id);
    sendFile(res, f.body, f.fileName, 'application/pdf');
  }

  @Get('claims')
  async claims(@Req() req: any, @Query() q: Record<string, string>) { return { success: true, data: await this.payroll.myClaims(actorOf(req).id, q ?? {}) }; }

  @Post('claims')
  async createClaim(@Req() req: any, @Body() body: any) { return { success: true, data: await this.payroll.createClaim(actorOf(req), body ?? {}) }; }

  @Patch('claims/:id')
  async updateClaim(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: any) { return { success: true, data: await this.payroll.updateClaim(actorOf(req), id, body ?? {}) }; }

  @Delete('claims/:id')
  async deleteClaim(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.deleteClaim(actorOf(req), id) }; }

  @Post('claims/:id/receipt')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: RECEIPT_MAX_BYTES } }))
  async receipt(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return { success: true, data: await this.payroll.uploadReceipt(actorOf(req), id, file) };
  }
}

/**
 * Claim review: their manager, or staff with claims.approve / payroll.approve (payroll.view reads). The staff
 * middleware lets every staff member reach /payroll/claims; the service decides (permissions.ts).
 */
@ApiTags('Admin — Payroll claims')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/payroll/claims')
export class PayrollClaimsController {
  constructor(private readonly payroll: PayrollService) {}

  @Get()
  async list(@Req() req: any, @Query() q: Record<string, string>) { return { success: true, data: await this.payroll.listClaims(actorOf(req), q ?? {}) }; }

  @Get(':id/receipt')
  async receipt(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.receiptUrl(actorOf(req), id) }; }

  @Post(':id/approve')
  async approve(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: any) {
    return { success: true, data: await this.payroll.decideClaim(actorOf(req), id, true, body?.note ?? null, typeof body?.taxable === 'boolean' ? body.taxable : undefined) };
  }

  @Post(':id/reject')
  async reject(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: any) {
    return { success: true, data: await this.payroll.decideClaim(actorOf(req), id, false, body?.note ?? body?.reason ?? null) };
  }
}

/**
 * Payroll administration. Staff rights (permissions.ts): reads need payroll.view, preparing needs payroll.prepare;
 * approving runs/advances, recording payments, verifying tax years and seeing full CNIC/bank need payroll.approve.
 * The approver of a run or advance must differ from its preparer (the owner is exempt).
 */
@ApiTags('Admin — Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  // Profiles
  @Get('profiles')
  async profiles() { return { success: true, data: await this.payroll.listProfiles() }; }

  @Get('profiles/:adminId')
  async profile(@Param('adminId', ParseObjectIdPipe) adminId: string) { return { success: true, data: await this.payroll.getProfile(adminId) }; }

  @Put('profiles/:adminId')
  async saveProfile(@Req() req: any, @Param('adminId', ParseObjectIdPipe) adminId: string, @Body() body: any) {
    return { success: true, data: await this.payroll.saveProfile(actorOf(req), adminId, body ?? {}) };
  }

  @Get('profiles/:adminId/identity')
  async identity(@Req() req: any, @Param('adminId', ParseObjectIdPipe) adminId: string) { return { success: true, data: await this.payroll.revealIdentity(actorOf(req), adminId) }; }

  // Tax years
  @Get('tax-years')
  async taxYears() { return { success: true, data: await this.payroll.listTaxYears() }; }

  @Put('tax-years/:year')
  async saveTaxYear(@Req() req: any, @Param('year') year: string, @Body() body: any) { return { success: true, data: await this.payroll.saveTaxYear(actorOf(req), year, body ?? {}) }; }

  @Post('tax-years/:year/verify')
  async verifyTaxYear(@Req() req: any, @Param('year') year: string) { return { success: true, data: await this.payroll.verifyTaxYear(actorOf(req), year) }; }

  // Advances
  @Get('advances')
  async advances(@Query() q: Record<string, string>) { return { success: true, data: await this.payroll.listAdvances(q ?? {}) }; }

  @Post('advances')
  async createAdvance(@Req() req: any, @Body() body: any) { return { success: true, data: await this.payroll.createAdvance(actorOf(req), body ?? {}) }; }

  @Post('advances/:id/approve')
  async approveAdvance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.decideAdvance(actorOf(req), id, true) }; }

  @Post('advances/:id/reject')
  async rejectAdvance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: any) { return { success: true, data: await this.payroll.decideAdvance(actorOf(req), id, false, body?.reason ?? null) }; }

  // Activity counts for a month (preview)
  @Get('metrics')
  async metrics(@Query('month') month: string, @Query('adminId') adminId?: string) { return { success: true, data: await this.payroll.monthMetrics(month, adminId || undefined) }; }

  // Runs
  @Get('runs')
  async runs() { return { success: true, data: await this.payroll.listRuns() }; }

  @Post('runs')
  async createRun(@Req() req: any, @Body() body: any) { return { success: true, data: await this.payroll.createRun(actorOf(req), String(body?.month ?? '')) }; }

  @Get('runs/:id')
  async run(@Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.getRun(id) }; }

  @Post('runs/:id/recalculate')
  async recalculate(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.recalculate(actorOf(req), id) }; }

  @Patch('runs/:id/lines/:adminId')
  async updateLine(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Param('adminId', ParseObjectIdPipe) adminId: string, @Body() body: any) {
    return { success: true, data: await this.payroll.updateLine(actorOf(req), id, adminId, body ?? {}) };
  }

  @Post('runs/:id/submit')
  async submit(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.submit(actorOf(req), id) }; }

  @Post('runs/:id/approve')
  async approve(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.approve(actorOf(req), id) }; }

  @Post('runs/:id/reject')
  async reject(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: any) { return { success: true, data: await this.payroll.reject(actorOf(req), id, body?.reason ?? null) }; }

  @Post('runs/:id/cancel')
  async cancel(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.payroll.cancel(actorOf(req), id) }; }

  @Post('runs/:id/pay')
  async pay(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() body: any) { return { success: true, data: await this.payroll.pay(actorOf(req), id, body ?? {}) }; }

  @Get('runs/:id/payslips')
  async payslipsZip(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Res() res: Response) {
    const f = await this.payroll.payslipsZip(actorOf(req), id);
    sendFile(res, f.body, f.fileName, 'application/zip');
  }

  @Get('runs/:id/payslips/:adminId')
  async payslip(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Param('adminId', ParseObjectIdPipe) adminId: string, @Res() res: Response) {
    const f = await this.payroll.payslipPdf(actorOf(req), id, adminId);
    sendFile(res, f.body, f.fileName, 'application/pdf');
  }

  // Reports
  @Get('reports/:name')
  async report(@Param('name') name: string, @Query() q: Record<string, string>) { return { success: true, data: await this.payroll.report(name, q ?? {}) }; }

  @Get('reports/:name/export')
  async exportReport(@Param('name') name: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const format = (EXPORT_FORMATS as readonly string[]).includes(q.format) ? (q.format as ExportFormat) : 'csv';
    const table = await this.payroll.report(name, q ?? {});
    const { body, contentType, ext } = await exportTable(table, format);
    sendFile(res, body, `payroll-${name}-${new Date().toISOString().slice(0, 10)}.${ext}`, contentType);
  }
}
