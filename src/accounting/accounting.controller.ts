/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AccountingService, type AcctActor } from './accounting.service';
import { ReportsService, REPORT_NAMES } from './reports.service';
import { PostingService } from './posting/posting.service';
import { BOOKS_START } from './accounting.constants';
import { parseDay } from './accounting.util';
import { EXPORT_FORMATS, exportTable, type ExportFormat } from './export.util';
import {
  BackfillDto, CreateAccountDto, CreateAssetDto, CreateJournalDto, DisposeAssetDto, ReasonDto, ReverseDto, UpdateAccountDto, UpdateAssetDto,
  UpdateJournalDto, VendorDto,
} from './dto/accounting.dto';

/**
 * Company accounting (super admin). Staff rights (staff/permissions.ts): reads need `accounting.view`, preparing
 * entries/assets/vendors needs `accounting.prepare`, approving/reversing/closing months/backfills need
 * `accounting.approve`. The owner can do everything; a staff approver can't approve an entry they prepared.
 */
@ApiTags('Admin — Accounting')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/accounting')
export class AccountingController {
  constructor(private readonly ledger: AccountingService, private readonly reports: ReportsService, private readonly posting: PostingService) {}

  private actor(req: any): AcctActor {
    const perms: Set<string> | undefined = req.staffPermissions;
    return { id: String(req.user.userId), isOwner: !perms, permissions: perms ?? null, ip: req.ip, userAgent: req.headers?.['user-agent'] };
  }

  @Get('summary')
  async summary() { return { success: true, data: await this.reports.summary() }; }

  // Accounts
  @Get('accounts')
  async accounts() { return { success: true, data: await this.ledger.listAccounts() }; }

  @Post('accounts')
  async createAccount(@Req() req: any, @Body() dto: CreateAccountDto) { return { success: true, data: await this.ledger.createAccount(this.actor(req), dto) }; }

  @Patch('accounts/:code')
  async updateAccount(@Req() req: any, @Param('code') code: string, @Body() dto: UpdateAccountDto) { return { success: true, data: await this.ledger.updateAccount(this.actor(req), code, dto) }; }

  @Delete('accounts/:code')
  async deleteAccount(@Req() req: any, @Param('code') code: string) { return { success: true, data: await this.ledger.deleteAccount(this.actor(req), code) }; }

  // Journals
  @Get('journals')
  async journals(@Query() q: Record<string, string>) {
    return { success: true, data: await this.ledger.listJournals({ ...q, page: Number(q.page) || 1, limit: Number(q.limit) || 50 }) };
  }

  @Get('journals/:id')
  async journal(@Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.ledger.getJournal(id) }; }

  @Post('journals')
  async createJournal(@Req() req: any, @Body() dto: CreateJournalDto) {
    return { success: true, data: await this.ledger.createDraft(this.actor(req), { date: dto.date ?? '', memo: dto.memo, lines: dto.lines }) };
  }

  @Patch('journals/:id')
  async updateJournal(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateJournalDto) {
    return { success: true, data: await this.ledger.updateDraft(this.actor(req), id, dto) };
  }

  @Post('journals/:id/submit')
  async submit(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.ledger.submit(this.actor(req), id) }; }

  @Post('journals/:id/approve')
  async approve(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string) { return { success: true, data: await this.ledger.approve(this.actor(req), id) }; }

  @Post('journals/:id/reject')
  async reject(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReasonDto) { return { success: true, data: await this.ledger.reject(this.actor(req), id, dto.reason) }; }

  @Post('journals/:id/void')
  async voidEntry(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReasonDto) { return { success: true, data: await this.ledger.voidEntry(this.actor(req), id, dto.reason) }; }

  @Post('journals/:id/reverse')
  async reverse(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: ReverseDto) {
    return { success: true, data: await this.ledger.reverse(this.actor(req), id, dto.date, dto.memo) };
  }

  // Opening balances (as at the books start)
  @Get('opening-balances')
  async opening() {
    const posted = await this.ledger.listJournals({ kind: 'opening', status: 'posted', limit: 1 });
    const pending = await this.ledger.listJournals({ kind: 'opening', limit: 20 });
    return { success: true, data: { booksStart: BOOKS_START, posted: posted.items[0] ?? null, drafts: pending.items.filter((j: any) => j.status === 'draft' || j.status === 'submitted') } };
  }

  @Post('opening-balances')
  async createOpening(@Req() req: any, @Body() dto: CreateJournalDto) {
    return { success: true, data: await this.ledger.createDraft(this.actor(req), { date: BOOKS_START, memo: dto.memo, lines: dto.lines, kind: 'opening' }) };
  }

  // Periods
  @Get('periods')
  async periods() { return { success: true, data: await this.ledger.listPeriods() }; }

  @Post('periods/:period/close')
  async close(@Req() req: any, @Param('period') period: string) { return { success: true, data: await this.ledger.closePeriod(this.actor(req), period) }; }

  @Post('periods/:period/reopen')
  async reopen(@Req() req: any, @Param('period') period: string, @Body() dto: ReasonDto) { return { success: true, data: await this.ledger.reopenPeriod(this.actor(req), period, dto.reason) }; }

  // Vendors
  @Get('vendors')
  async vendors() { return { success: true, data: await this.ledger.listVendors() }; }

  @Post('vendors')
  async createVendor(@Req() req: any, @Body() dto: VendorDto) { return { success: true, data: await this.ledger.upsertVendor(this.actor(req), null, dto) }; }

  @Patch('vendors/:id')
  async updateVendor(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: VendorDto) { return { success: true, data: await this.ledger.upsertVendor(this.actor(req), id, dto) }; }

  // Fixed assets
  @Get('assets')
  async assets() {
    const [items, dep] = await Promise.all([this.ledger.listAssets(), this.ledger.depreciationTotals()]);
    return { success: true, data: items.map((a: any) => ({ ...a, accumulatedDepreciation: dep.get(String(a._id)) ?? 0, netBookValue: Math.round((a.cost - (dep.get(String(a._id)) ?? 0)) * 100) / 100 })) };
  }

  @Post('assets')
  async createAsset(@Req() req: any, @Body() dto: CreateAssetDto) { return { success: true, data: await this.ledger.createAsset(this.actor(req), dto) }; }

  @Post('assets/depreciation/run')
  async runDepreciation() { return { success: true, data: await this.ledger.runDepreciation() }; }

  @Patch('assets/:id')
  async updateAsset(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateAssetDto) { return { success: true, data: await this.ledger.updateAsset(this.actor(req), id, dto) }; }

  @Post('assets/:id/dispose')
  async dispose(@Req() req: any, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: DisposeAssetDto) { return { success: true, data: await this.ledger.disposeAsset(this.actor(req), id, dto) }; }

  // Posting engine
  @Get('posting/status')
  async postingStatus() { return { success: true, data: await this.posting.status() }; }

  @Post('posting/run')
  async runPosting() {
    const [run, dep] = [await this.posting.runAll(), await this.ledger.runDepreciation()];
    return { success: true, data: { run, depreciation: dep } };
  }

  @Post('posting/backfill')
  async backfill(@Body() dto: BackfillDto) {
    const from = parseDay(dto.from ?? BOOKS_START);
    if (!from) throw new BadRequestException('Choose a valid date.');
    return { success: true, data: await this.posting.runAll({ from }) };
  }

  // Reports
  @Get('reports/:name')
  async report(@Param('name') name: string, @Query() q: Record<string, string>) {
    const data =
      name === 'trial-balance' ? await this.reports.trialBalance(q)
        : name === 'profit-loss' ? await this.reports.profitLoss(q)
          : name === 'balance-sheet' ? await this.reports.balanceSheet(q)
            : name === 'general-ledger' ? await this.reports.generalLedger(q)
              : name === 'party-ledger' ? await this.reports.partyLedger(q)
                : name === 'aging' ? await this.reports.aging(q)
                  : name === 'payouts' ? await this.reports.payouts(q)
                    : name === 'subscribers' ? await this.reports.subscribers()
                      : null;
    if (data === null) throw new BadRequestException(`Unknown report. Use one of: ${REPORT_NAMES.join(', ')}`);
    return { success: true, data };
  }

  @Get('reports/:name/export')
  async exportReport(@Param('name') name: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const format = (EXPORT_FORMATS as readonly string[]).includes(q.format) ? (q.format as ExportFormat) : 'csv';
    const table = await this.reports.table(name, q);
    const { body, contentType, ext } = await exportTable(table, format);
    const file = `${name}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}
