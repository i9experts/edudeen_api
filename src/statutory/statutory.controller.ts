import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import {
  EXPORT_FORMATS,
  exportTable,
  type ExportFormat,
} from '../accounting/export.util';
import { StatutoryService, type StatActor } from './statutory.service';

const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const actorOf = (req: any): StatActor => {
  const perms: Set<string> | undefined = req.staffPermissions;
  return {
    id: String(req.user.userId),
    isOwner: !perms,
    permissions: perms ?? null,
    ip: req.ip,
    userAgent: req.headers?.['user-agent'],
  };
};
const sendFile = (
  res: Response,
  body: Buffer,
  fileName: string,
  contentType: string,
) => {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
};

/**
 * Tax & EOBI payments (statutory liabilities). Every staff member reaches the route (staff/permissions.ts); the
 * service requires payroll OR accounting view / prepare / approve rights, and payroll.approve for full CNIC exports.
 */
@ApiTags('Admin — Tax & EOBI payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/statutory')
export class StatutoryController {
  constructor(private readonly svc: StatutoryService) {}

  @Get()
  async list(@Req() req: any, @Query() q: Record<string, string>) {
    return { success: true, data: await this.svc.list(actorOf(req), q ?? {}) };
  }

  @Get('settings')
  async settings(@Req() req: any) {
    return { success: true, data: await this.svc.getSettings(actorOf(req)) };
  }

  @Put('settings')
  async saveSettings(@Req() req: any, @Body() body: any) {
    return {
      success: true,
      data: await this.svc.saveSettings(actorOf(req), body ?? {}),
    };
  }

  @Get('overview')
  async overview(@Req() req: any) {
    return { success: true, data: await this.svc.overview(actorOf(req)) };
  }

  @Post('generate')
  async generate(@Req() req: any) {
    const actor = actorOf(req);
    if (
      !actor.isOwner &&
      ![
        'payroll.prepare',
        'accounting.prepare',
        'payroll.approve',
        'accounting.approve',
      ].some((p) => actor.permissions?.has(p))
    )
      throw new ForbiddenException('You need prepare rights.');
    return { success: true, data: await this.svc.generateFromRuns() };
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    return {
      success: true,
      data: await this.svc.createManual(actorOf(req), body ?? {}),
    };
  }

  @Get('exports/:kind')
  async export(
    @Req() req: any,
    @Param('kind') kind: string,
    @Query() q: Record<string, string>,
    @Res() res: Response,
  ) {
    const format = (q.format ?? 'xlsx') as ExportFormat;
    if (!(EXPORT_FORMATS as readonly string[]).includes(format))
      throw new BadRequestException(
        `Format must be one of: ${EXPORT_FORMATS.join(', ')}`,
      );
    const full = q.full === '1' || q.full === 'true';
    const table = await this.svc.filingTable(
      actorOf(req),
      kind,
      String(q.period ?? ''),
      full,
    );
    const out = await exportTable(table, format);
    sendFile(
      res,
      out.body,
      `edudeen-${kind}-${String(q.period ?? '')}${full ? '' : '-masked'}.${out.ext}`,
      out.contentType,
    );
  }

  @Get('certificate/:adminId')
  async certificate(
    @Req() req: any,
    @Param('adminId', ParseObjectIdPipe) adminId: string,
    @Query('taxYear') taxYear: string,
    @Res() res: Response,
  ) {
    const f = await this.svc.salaryCertificate(
      actorOf(req),
      adminId,
      String(taxYear ?? ''),
    );
    sendFile(res, f.body, f.fileName, 'application/pdf');
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) {
    return { success: true, data: await this.svc.get(actorOf(req), id) };
  }

  @Post(':id/void')
  async void(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: any,
  ) {
    return {
      success: true,
      data: await this.svc.voidStatement(
        actorOf(req),
        id,
        body?.reason ?? null,
      ),
    };
  }

  @Post(':id/payments')
  async pay(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: any,
  ) {
    return {
      success: true,
      data: await this.svc.recordPayment(actorOf(req), id, body ?? {}),
    };
  }

  @Post(':id/payments/:paymentId/receipt')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: RECEIPT_MAX_BYTES },
    }),
  )
  async receipt(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('paymentId', ParseObjectIdPipe) paymentId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return {
      success: true,
      data: await this.svc.uploadReceipt(actorOf(req), id, paymentId, file),
    };
  }

  @Get(':id/payments/:paymentId/receipt')
  async receiptUrl(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('paymentId', ParseObjectIdPipe) paymentId: string,
  ) {
    return {
      success: true,
      data: await this.svc.receiptUrl(actorOf(req), id, paymentId),
    };
  }

  @Delete(':id/payments/:paymentId')
  async remove(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('paymentId', ParseObjectIdPipe) paymentId: string,
  ) {
    return {
      success: true,
      data: await this.svc.removePayment(actorOf(req), id, paymentId),
    };
  }

  @Post(':id/payments/:paymentId/approve')
  async approve(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('paymentId', ParseObjectIdPipe) paymentId: string,
  ) {
    return {
      success: true,
      data: await this.svc.approvePayment(actorOf(req), id, paymentId),
    };
  }

  @Post(':id/payments/:paymentId/reject')
  async reject(
    @Req() req: any,
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('paymentId', ParseObjectIdPipe) paymentId: string,
    @Body() body: any,
  ) {
    return {
      success: true,
      data: await this.svc.rejectPayment(
        actorOf(req),
        id,
        paymentId,
        body?.reason ?? null,
      ),
    };
  }
}
