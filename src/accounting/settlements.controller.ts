/* eslint-disable prettier/prettier */
import {
  BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AccountingService, type AcctActor } from './accounting.service';
import { parseDay } from './accounting.util';
import { EXPORT_FORMATS, exportTable, type ExportFormat } from './export.util';
import { AcctSettings } from './schemas/accounting.schemas';
import { StripeSettlementService } from './stripe/stripe-settlement.service';
import { CodRemittanceService } from './cod/cod-remittance.service';
import { CodRemittanceUpdateDto, ReasonDto, StripeSettingsDto, StripeSyncDto } from './dto/accounting.dto';

const STATEMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Settlements (super admin): Stripe payouts/fees sync + reconciliation, and courier COD remittances. Staff rights as
 * for the rest of /api/admin/accounting (staff/permissions.ts): reads `accounting.view`, preparing `accounting.prepare`,
 * approving remittances and changing the Stripe payout account `accounting.approve`.
 */
@ApiTags('Admin — Accounting settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/accounting')
export class SettlementsController {
  constructor(
    private readonly stripe: StripeSettlementService,
    private readonly cod: CodRemittanceService,
    private readonly ledger: AccountingService,
    private readonly activity: ActivityLogService,
    @InjectModel(AcctSettings.name) private readonly settings: Model<AcctSettings>,
  ) {}

  private actor(req: any): AcctActor {
    const perms: Set<string> | undefined = req.staffPermissions;
    return { id: String(req.user.userId), isOwner: !perms, permissions: perms ?? null, ip: req.ip, userAgent: req.headers?.['user-agent'] };
  }

  // ── Stripe ──────────────────────────────────────────────────────────────────
  @Get('stripe/status')
  async stripeStatus() { return { success: true, data: await this.stripe.status() }; }

  @Post('stripe/sync')
  async stripeSync(@Body() dto: StripeSyncDto) {
    const from = dto.from ? parseDay(dto.from) : null;
    if (dto.from && !from) throw new BadRequestException('Choose a valid date.');
    return { success: true, data: await this.stripe.sync({ from }) };
  }

  @Get('stripe/transactions')
  async stripeTransactions(@Query() q: Record<string, string>) {
    return { success: true, data: await this.stripe.list({ ...q, page: Number(q.page) || 1, limit: Number(q.limit) || 50 }) };
  }

  @Get('stripe/reconciliation')
  async stripeReconciliation() { return { success: true, data: await this.stripe.reconciliation() }; }

  @Put('stripe/settings')
  async stripeSettings(@Req() req: any, @Body() dto: StripeSettingsDto) {
    const actor = this.actor(req);
    const acc = (await this.ledger.accountMap()).get(dto.payoutBankAccount);
    if (!acc || !acc.isActive || !['bank', 'cash'].includes(acc.subtype)) throw new BadRequestException('Choose an active bank account.');
    await this.settings.updateOne({ key: 'default' }, { $set: { stripePayoutBankAccount: dto.payoutBankAccount, updatedBy: actor.id } }, { upsert: true });
    void this.activity.log({
      category: 'accounting', action: 'stripe_payout_account', description: `Stripe payouts now post to ${acc.code} ${acc.name}`,
      actorId: actor.id, actorRole: 'admin', targetType: 'accounting', ip: actor.ip, userAgent: actor.userAgent,
    }).catch(() => undefined);
    return { success: true, data: await this.stripe.status() };
  }

  // ── COD remittances ─────────────────────────────────────────────────────────
  /** Reads a courier statement (CSV or .xlsx) and returns the columns found and the parcel lines. Saves nothing. */
  @Post('cod-remittances/preview')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: STATEMENT_MAX_BYTES } }))
  preview(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    if (!file?.buffer?.length) throw new BadRequestException('Upload the courier statement (.csv or .xlsx).');
    let override: Record<string, string> | null = null;
    if (body?.mapping) { try { override = JSON.parse(body.mapping); } catch { throw new BadRequestException('Invalid column mapping.'); } }
    return { success: true, data: { fileName: file.originalname, ...this.cod.preview(file.buffer, String(body?.courier ?? 'other'), override) } };
  }

  @Get('cod-remittances')
  async listRemittances(@Query() q: Record<string, string>) {
    return { success: true, data: await this.cod.list({ ...q, page: Number(q.page) || 1, limit: Number(q.limit) || 30 }) };
  }

  @Get('cod-remittances/:id')
  async getRemittance(@Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.cod.get(id) }; }

  /** Multipart: `file` (optional statement) + the header fields; `mapping` and `lines` are JSON strings when given. */
  @Post('cod-remittances')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: STATEMENT_MAX_BYTES } }))
  async createRemittance(@Req() req: any, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    const json = (v: string | undefined, what: string) => {
      if (!v) return null;
      try { return JSON.parse(v); } catch { throw new BadRequestException(`Invalid ${what}.`); }
    };
    const lines = json(body?.lines, 'parcel lines');
    if (lines && (!Array.isArray(lines) || lines.length > 500)) throw new BadRequestException('Add at most 500 parcels by hand; upload the statement for more.');
    const data = await this.cod.create(this.actor(req), {
      courier: body?.courier, statementRef: body?.statementRef || null, remittanceDate: body?.remittanceDate, bankAccount: body?.bankAccount,
      otherDeductions: Number(body?.otherDeductions) || 0, otherDeductionsAccount: body?.otherDeductionsAccount || null, netReceived: Number(body?.netReceived) || 0,
      notes: body?.notes || null, file: file?.buffer ?? null, fileName: file?.originalname ? String(file.originalname).slice(0, 200) : null,
      mapping: json(body?.mapping, 'column mapping'),
      lines: (lines ?? []).map((l: any) => ({ trackingNumber: String(l?.trackingNumber ?? ''), codCollected: Number(l?.codCollected) || 0, charges: Number(l?.charges) || 0 })),
    });
    return { success: true, data };
  }

  @Patch('cod-remittances/:id')
  async updateRemittance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: CodRemittanceUpdateDto) {
    return { success: true, data: await this.cod.update(this.actor(req), id, dto) };
  }

  @Post('cod-remittances/:id/submit')
  async submitRemittance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.cod.submit(this.actor(req), id) }; }

  @Post('cod-remittances/:id/approve')
  async approveRemittance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.cod.approve(this.actor(req), id) }; }

  @Post('cod-remittances/:id/reject')
  async rejectRemittance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReasonDto) {
    return { success: true, data: await this.cod.reject(this.actor(req), id, dto.reason) };
  }

  @Post('cod-remittances/:id/void')
  async voidRemittance(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.cod.voidDraft(this.actor(req), id) }; }

  @Get('cod-outstanding')
  async outstanding(@Query('courier') courier?: string) { return { success: true, data: await this.cod.outstanding({ courier: courier || undefined }) }; }

  @Get('cod-outstanding/export')
  async exportOutstanding(@Query() q: Record<string, string>, @Res() res: Response) {
    const format = (EXPORT_FORMATS as readonly string[]).includes(q.format) ? (q.format as ExportFormat) : 'csv';
    const table = await this.cod.outstandingTable({ courier: q.courier || undefined });
    const { body, contentType, ext } = await exportTable(table, format);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="outstanding-cod-${new Date().toISOString().slice(0, 10)}.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}
