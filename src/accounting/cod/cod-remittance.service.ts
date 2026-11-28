/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { DatabaseService } from '../../database/databaseservice';
import { BASE_CURRENCY, BOOKS_START } from '../accounting.constants';
import { parseDay, round2 } from '../accounting.util';
import { AccountingService, type AcctActor } from '../accounting.service';
import type { ReportTable } from '../export.util';
import { FxResolver } from '../posting/posting.service';
import { COD_COURIERS, CodRemittance, CodRemittanceItem, type CodCourier } from '../schemas/settlement.schemas';
import {
  AGING_BUCKETS, agingBucket, detectColumns, extractLines, matchLines, normalizeTracking, packageCodAmount, readStatement, remittanceJournalLines,
  remittanceTotals, type ColumnMapping, type ParcelInfo, type StatementLine,
} from './cod.util';

const MAX_LINES = 5000;

export interface RemittanceInput {
  courier?: string;
  statementRef?: string | null;
  remittanceDate?: string;
  bankAccount?: string;
  otherDeductions?: number;
  otherDeductionsAccount?: string | null;
  netReceived?: number;
  notes?: string | null;
}
export interface LineEdits { upsertLines?: { trackingNumber: string; codCollected: number; charges?: number }[]; removeTrackings?: string[] }

@Injectable()
export class CodRemittanceService {
  private readonly logger = new Logger(CodRemittanceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: AccountingService,
    private readonly activity: ActivityLogService,
    @InjectModel(CodRemittance.name) private readonly remittances: Model<CodRemittance>,
    @InjectModel(CodRemittanceItem.name) private readonly items: Model<CodRemittanceItem>,
  ) {}

  private canPrepare(a: AcctActor) { return a.isOwner || !!a.permissions?.has('accounting.prepare') || !!a.permissions?.has('accounting.approve'); }
  private canApprove(a: AcctActor) { return a.isOwner || !!a.permissions?.has('accounting.approve'); }

  // ── Reading a statement ────────────────────────────────────────────────────
  /** Parses an uploaded statement and reports the columns found (nothing is saved). */
  preview(file: Buffer, courier: string, override?: Partial<ColumnMapping> | null) {
    let rows: string[][];
    try { rows = readStatement(file); } catch (e: any) { throw new BadRequestException(e?.message ?? 'Could not read the file.'); }
    if (!rows.length) throw new BadRequestException('The file is empty.');
    const { headerRow, headers, mapping } = detectColumns(rows, courier, override);
    let lines: StatementLine[] = [];
    if (mapping) {
      try { lines = extractLines(rows, headerRow, headers, mapping); } catch (e: any) { throw new BadRequestException(e?.message); }
    }
    if (lines.length > MAX_LINES) throw new BadRequestException(`A statement can have at most ${MAX_LINES} parcels. Split the file.`);
    return { headers, headerRow, mapping, sample: rows.slice(headerRow + 1, headerRow + 6), lines };
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────
  async list(q: { status?: string; courier?: string; page?: number; limit?: number }) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.courier) filter.courier = q.courier;
    const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100);
    const page = Math.max(Number(q.page) || 1, 1);
    const [items, total] = await Promise.all([
      this.remittances.find(filter).select('-lines').sort({ remittanceDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.remittances.countDocuments(filter),
    ]);
    const counts = await this.remittances.aggregate<{ _id: string; n: number }>([{ $match: filter }, { $unwind: '$lines' }, { $group: { _id: { $concat: [{ $toString: '$_id' }, ':', '$lines.status'] }, n: { $sum: 1 } } }]);
    const byRem = new Map<string, Record<string, number>>();
    for (const c of counts) { const [id, st] = c._id.split(':'); const m = byRem.get(id) ?? {}; m[st] = c.n; byRem.set(id, m); }
    return { items: items.map((r: any) => ({ ...r, lineCounts: byRem.get(String(r._id)) ?? {} })), total, page, limit };
  }

  async get(id: string) {
    const r: any = await this.remittances.findById(id).lean();
    if (!r) throw new NotFoundException('Remittance not found');
    return { ...r, totals: remittanceTotals(r.lines, r.otherDeductions, r.netReceived) };
  }

  /**
   * New draft from an uploaded statement (columns detected, or the mapping the preparer chose) and/or lines typed in.
   * Takes the file itself rather than the parsed lines so a large statement never hits the JSON body limit.
   */
  async create(actor: AcctActor, dto: RemittanceInput & { file?: Buffer | null; fileName?: string | null; mapping?: Partial<ColumnMapping> | null; lines?: StatementLine[] }) {
    if (!this.canPrepare(actor)) throw new ForbiddenException('You need accounting prepare rights.');
    const header = await this.cleanHeader(dto, true);
    let fromFile: StatementLine[] = [];
    let mapping: ColumnMapping | null = null;
    if (dto.file?.length) {
      const p = this.preview(dto.file, header.courier, dto.mapping ?? null);
      if (!p.mapping) throw new BadRequestException('Could not find the tracking number and COD amount columns. Choose them and try again.');
      fromFile = p.lines;
      mapping = p.mapping;
    }
    const lines = await this.match([...fromFile, ...(dto.lines ?? [])], null);
    if (!lines.length) throw new BadRequestException('No parcels found. Upload the statement or add parcels.');
    const doc: any = await this.remittances.create({
      ...header, courier: header.courier as CodCourier, lines, fileName: dto.fileName ?? null, mapping, status: 'draft', preparedBy: actor.id,
      ...this.headerTotals(lines, header.otherDeductions, header.netReceived),
    });
    void this.log(actor, 'cod_remittance_created', `COD remittance ${header.courier.toUpperCase()} ${header.statementRef ?? ''} drafted (${lines.length} parcels)`, String(doc._id));
    return this.get(String(doc._id));
  }

  async update(actor: AcctActor, id: string, dto: RemittanceInput & LineEdits) {
    if (!this.canPrepare(actor)) throw new ForbiddenException('You need accounting prepare rights.');
    const cur: any = await this.remittances.findById(id).lean();
    if (!cur) throw new NotFoundException('Remittance not found');
    if (cur.status !== 'draft') throw new ConflictException('Only a draft can be edited. Reject it back to draft first.');
    const header = await this.cleanHeader({ ...cur, remittanceDate: cur.remittanceDate?.toISOString?.().slice(0, 10), ...dto }, false);
    // Line edits by tracking number: remove, then add/replace.
    const remove = new Set((dto.removeTrackings ?? []).map(normalizeTracking));
    const upsert = new Map((dto.upsertLines ?? []).map((l) => [normalizeTracking(l.trackingNumber), l]));
    const kept = (cur.lines as StatementLine[]).filter((l) => !remove.has(normalizeTracking(l.trackingNumber)) && !upsert.has(normalizeTracking(l.trackingNumber)));
    const lines = await this.match([...kept, ...[...upsert.values()].map((l) => ({ trackingNumber: l.trackingNumber, codCollected: l.codCollected, charges: l.charges ?? 0 }))], id);
    await this.remittances.updateOne({ _id: id, status: 'draft' }, { $set: { ...header, lines, ...this.headerTotals(lines, header.otherDeductions, header.netReceived) } });
    return this.get(id);
  }

  async submit(actor: AcctActor, id: string) {
    if (!this.canPrepare(actor)) throw new ForbiddenException('You need accounting prepare rights.');
    const cur = await this.get(id);
    if (cur.status !== 'draft') throw new ConflictException('Only a draft can be submitted.');
    if (!cur.lines.length) throw new BadRequestException('Add at least one parcel.');
    const res = await this.remittances.updateOne({ _id: id, status: 'draft' }, { $set: { status: 'submitted', submittedBy: actor.id, submittedAt: new Date(), rejectReason: null } });
    if (!res.modifiedCount) throw new ConflictException('It changed meanwhile; reload.');
    void this.log(actor, 'cod_remittance_submitted', `COD remittance submitted for approval`, id);
    return this.get(id);
  }

  async reject(actor: AcctActor, id: string, reason?: string | null) {
    if (!this.canApprove(actor)) throw new ForbiddenException('Only an accounting approver can reject.');
    const res = await this.remittances.updateOne({ _id: id, status: 'submitted' }, { $set: { status: 'draft', rejectReason: (reason ?? '').slice(0, 300) || null } });
    if (!res.modifiedCount) throw new ConflictException('Only a submitted remittance can be sent back.');
    void this.log(actor, 'cod_remittance_rejected', `COD remittance sent back${reason ? `: ${reason}` : ''}`, id);
    return this.get(id);
  }

  async voidDraft(actor: AcctActor, id: string) {
    if (!this.canPrepare(actor)) throw new ForbiddenException('You need accounting prepare rights.');
    const res = await this.remittances.updateOne({ _id: id, status: 'draft' }, { $set: { status: 'void' } });
    if (!res.modifiedCount) throw new ConflictException('Only a draft can be discarded.');
    return this.get(id);
  }

  /**
   * Approve: re-match (another statement may have been approved meanwhile), claim every parcel, post the journal.
   * The claim is the unique `acct_cod_items` row, so the same parcel can never clear the receivable twice; if posting
   * fails the claims are released again.
   */
  async approve(actor: AcctActor, id: string) {
    if (!this.canApprove(actor)) throw new ForbiddenException('Only an accounting approver can approve.');
    const cur: any = await this.remittances.findById(id).lean();
    if (!cur) throw new NotFoundException('Remittance not found');
    if (cur.status !== 'submitted') throw new ConflictException('Only a submitted remittance can be approved.');
    if (!actor.isOwner && (cur.preparedBy === actor.id || cur.submittedBy === actor.id)) throw new ForbiddenException('Someone other than the preparer must approve it.');
    if (await this.ledger.isClosed(new Date(cur.remittanceDate).toISOString().slice(0, 7))) throw new BadRequestException('That month is closed. Change the date or reopen the month.');
    const lines = await this.match(cur.lines, id);
    const dups = lines.filter((l) => l.status === 'duplicate');
    if (dups.length) {
      await this.remittances.updateOne({ _id: id }, { $set: { lines } });
      throw new ConflictException(`${dups.length} parcel(s) are duplicates (already remitted or listed twice). Send it back and remove them.`);
    }
    const claim = lines.filter((l) => l.status !== 'unknown').map((l) => ({
      trackingNumber: l.trackingNumber, remittanceId: id, orderId: l.orderId, sellerOrderId: l.sellerOrderId, courier: cur.courier, codCollected: l.codCollected, remittanceDate: cur.remittanceDate,
    }));
    try {
      if (claim.length) await this.items.insertMany(claim, { ordered: true });
    } catch (e: any) {
      await this.items.deleteMany({ remittanceId: id });
      if (e?.code === 11000) throw new ConflictException('A parcel was remitted by another statement a moment ago. Reload and check the duplicates.');
      throw e;
    }
    try {
      const draftLines = remittanceJournalLines({ ...cur, lines });
      const { entry } = await this.ledger.postJournal({
        date: new Date(cur.remittanceDate), memo: `${String(cur.courier).toUpperCase()} COD remittance${cur.statementRef ? ` ${cur.statementRef}` : ''} (${lines.length} parcels)`,
        lines: draftLines.map((l) => ({ ...l, currency: BASE_CURRENCY })), kind: 'auto', preparedBy: cur.preparedBy, approvedBy: actor.id,
        source: { type: 'cod_remittance', id, ref: cur.statementRef ?? null },
      });
      await this.remittances.updateOne({ _id: id }, { $set: { status: 'approved', approvedBy: actor.id, approvedAt: new Date(), lines, journalIds: [String(entry._id)] } });
    } catch (e) {
      await this.items.deleteMany({ remittanceId: id });
      throw e;
    }
    void this.log(actor, 'cod_remittance_approved', `COD remittance approved and posted`, id);
    return this.get(id);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private async cleanHeader(dto: any, creating: boolean) {
    const courier = String(dto.courier ?? '').toLowerCase();
    if (!(COD_COURIERS as readonly string[]).includes(courier)) throw new BadRequestException(`Courier must be one of: ${COD_COURIERS.join(', ')}`);
    const date = parseDay(String(dto.remittanceDate ?? ''));
    if (!date) throw new BadRequestException('Enter the date the money reached the bank.');
    if (date < parseDay(BOOKS_START)!) throw new BadRequestException(`The books start on ${BOOKS_START}; earlier remittances belong in the opening balances.`);
    const accounts = await this.ledger.accountMap();
    const bank = String(dto.bankAccount ?? '');
    const acc = accounts.get(bank);
    if (!acc || !acc.isActive || !['bank', 'cash'].includes(acc.subtype)) throw new BadRequestException('Choose the bank or cash account the money was paid into.');
    const otherAcc = String(dto.otherDeductionsAccount || '6900');
    if (!accounts.get(otherAcc)?.isActive) throw new BadRequestException('Choose a valid account for other deductions.');
    const otherDeductions = round2(Math.max(0, Number(dto.otherDeductions) || 0));
    const netReceived = round2(Number(dto.netReceived) || 0);
    if (netReceived < 0) throw new BadRequestException('Net received cannot be negative.');
    void creating;
    return {
      courier, statementRef: dto.statementRef ? String(dto.statementRef).trim().slice(0, 80) : null, remittanceDate: date, bankAccount: bank,
      otherDeductions, otherDeductionsAccount: otherAcc, netReceived, notes: dto.notes ? String(dto.notes).slice(0, 500) : null,
    };
  }

  private headerTotals(lines: { codCollected: number; charges: number; status: string }[], other: number, net: number) {
    const t = remittanceTotals(lines, other, net);
    return { grossCollected: t.gross, courierCharges: t.charges };
  }

  private async match(raw: StatementLine[], selfId: string | null) {
    if (raw.length > MAX_LINES) throw new BadRequestException(`A statement can have at most ${MAX_LINES} parcels.`);
    const lines = raw.map((l) => ({ trackingNumber: normalizeTracking(l.trackingNumber), codCollected: round2(Number(l.codCollected) || 0), charges: round2(Math.abs(Number(l.charges) || 0)) })).filter((l) => l.trackingNumber);
    const trackings = [...new Set(lines.map((l) => l.trackingNumber))];
    const [parcels, claimed] = await Promise.all([this.parcels(trackings), this.items.find({ trackingNumber: { $in: trackings } }).select('trackingNumber remittanceId').lean()]);
    const remitted = new Map(claimed.map((c: any) => [String(c.trackingNumber), String(c.remittanceId)]));
    return matchLines(lines, parcels, remitted, selfId);
  }

  /** Our shipments for these tracking numbers, with the booked COD amount in PKR. */
  async parcels(trackings: string[]): Promise<Map<string, ParcelInfo>> {
    const out = new Map<string, ParcelInfo>();
    if (!trackings.length) return out;
    const r = this.db.repositories;
    const orders: any[] = await r.orderModel.find({
      isDelete: { $ne: true },
      $or: [{ 'sellerOrders.shipment.trackingNumber': { $in: trackings } }, { 'sellerOrders.tracking.trackingNumber': { $in: trackings } }],
    }).select('orderNumber userId currency totalAmount createdAt sellerOrders._id sellerOrders.storeId sellerOrders.codAmount sellerOrders.subtotal sellerOrders.shipment sellerOrders.tracking').lean();
    const users = await this.userNames(orders.map((o) => o.userId));
    const fx = new FxResolver(this.db);
    const want = new Set(trackings);
    for (const o of orders) {
      for (const so of o.sellerOrders ?? []) {
        const t = normalizeTracking(so.shipment?.trackingNumber || so.tracking?.trackingNumber);
        if (!t || !want.has(t)) continue;
        let amount = packageCodAmount(o, so);
        const cur = String(o.currency || BASE_CURRENCY).toUpperCase();
        if (cur !== BASE_CURRENCY) {
          try { amount = round2(amount * (await fx.rate(cur, new Date(o.createdAt))).fxRate); } catch { /* keep the order-currency amount */ }
        }
        out.set(t, {
          orderId: String(o._id), orderNumber: o.orderNumber ?? null, sellerOrderId: String(so._id), storeId: so.storeId ? String(so.storeId) : null,
          customerId: o.userId ? String(o.userId) : null, customerName: o.userId ? users.get(String(o.userId)) ?? null : null, codExpected: amount,
        });
      }
    }
    return out;
  }

  private async userNames(ids: unknown[]): Promise<Map<string, string | null>> {
    const valid = [...new Set(ids.filter(Boolean).map(String))].filter((id) => /^[a-f0-9]{24}$/i.test(id));
    if (!valid.length) return new Map();
    const users: any[] = await this.db.repositories.userModel.find({ _id: { $in: valid } }).select('name email').lean();
    return new Map(users.map((u) => [String(u._id), u.name || u.email || null]));
  }

  // ── Outstanding COD ────────────────────────────────────────────────────────
  /**
   * Delivered cash-on-delivery parcels collected by Edudeen's courier (codCollector 'platform') since the books start
   * that no approved remittance has claimed yet. Returned parcels carry no cash and are left out.
   */
  async outstanding(q: { courier?: string } = {}, now = new Date()) {
    const r = this.db.repositories;
    const since = parseDay(BOOKS_START)!;
    const orders: any[] = await r.orderModel.find({
      isDelete: { $ne: true }, paymentType: 'cash_on_delivery',
      sellerOrders: { $elemMatch: { status: { $in: ['delivered', 'completed'] }, $or: [{ deliveredAt: { $gte: since } }, { deliveredAt: null, updatedAt: { $gte: since } }] } },
    }).select('orderNumber userId currency totalAmount createdAt updatedAt sellerOrders._id sellerOrders.storeId sellerOrders.status sellerOrders.codCollector sellerOrders.fulfillmentMode sellerOrders.codAmount sellerOrders.subtotal sellerOrders.shipment sellerOrders.tracking sellerOrders.deliveredAt sellerOrders.trackingEvents').lean();
    const candidates: { o: any; so: any; tracking: string }[] = [];
    for (const o of orders) {
      for (const so of o.sellerOrders ?? []) {
        if (!['delivered', 'completed'].includes(so.status)) continue;
        const collector = so.codCollector ?? so.fulfillmentMode ?? 'seller';
        if (collector !== 'platform') continue;
        const events = so.trackingEvents ?? [];
        if (events.length && events[events.length - 1]?.status === 'returned') continue;
        const delivered = so.deliveredAt ? new Date(so.deliveredAt) : new Date(o.updatedAt);
        if (delivered < since) continue;
        candidates.push({ o, so, tracking: normalizeTracking(so.shipment?.trackingNumber || so.tracking?.trackingNumber) });
      }
    }
    const trackings = candidates.map((c) => c.tracking).filter(Boolean);
    const soIds = candidates.map((c) => String(c.so._id));
    const claimed: any[] = candidates.length ? await this.items.find({ $or: [{ trackingNumber: { $in: trackings } }, { sellerOrderId: { $in: soIds } }] }).select('trackingNumber sellerOrderId').lean() : [];
    const doneT = new Set(claimed.map((c) => String(c.trackingNumber)));
    const doneSo = new Set(claimed.map((c) => String(c.sellerOrderId)));
    const storeIds = [...new Set(candidates.map((c) => String(c.so.storeId)).filter(Boolean))];
    const stores: any[] = storeIds.length ? await r.storeModel.find({ _id: { $in: storeIds.filter((id) => /^[a-f0-9]{24}$/i.test(id)) } }).select('name').lean() : [];
    const storeName = new Map(stores.map((s) => [String(s._id), s.name ?? null]));
    const fx = new FxResolver(this.db);
    const rows: any[] = [];
    for (const c of candidates) {
      if ((c.tracking && doneT.has(c.tracking)) || doneSo.has(String(c.so._id))) continue;
      const courier = String(c.so.shipment?.courier || (c.so.tracking?.carrier ? String(c.so.tracking.carrier).toLowerCase() : '') || 'other');
      const normCourier = (COD_COURIERS as readonly string[]).includes(courier) ? courier : /tcs/.test(courier) ? 'tcs' : /leopard/.test(courier) ? 'leopards' : /postex/.test(courier) ? 'postex' : 'other';
      if (q.courier && q.courier !== normCourier) continue;
      let amount = packageCodAmount(c.o, c.so);
      const cur = String(c.o.currency || BASE_CURRENCY).toUpperCase();
      if (cur !== BASE_CURRENCY) { try { amount = round2(amount * (await fx.rate(cur, new Date(c.o.createdAt))).fxRate); } catch { /* order currency */ } }
      const deliveredAt = c.so.deliveredAt ? new Date(c.so.deliveredAt) : new Date(c.o.updatedAt);
      const { days, bucket } = agingBucket(deliveredAt, now);
      rows.push({
        orderId: String(c.o._id), orderNumber: c.o.orderNumber ?? null, sellerOrderId: String(c.so._id), storeId: c.so.storeId ? String(c.so.storeId) : null,
        storeName: storeName.get(String(c.so.storeId)) ?? null, courier: normCourier, trackingNumber: c.tracking || null, codExpected: amount, deliveredAt, days, bucket,
      });
    }
    rows.sort((a, b) => b.days - a.days);
    const total = (list: any[]) => round2(list.reduce((s, x) => s + x.codExpected, 0));
    const byBucket = AGING_BUCKETS.map((b) => ({ bucket: b, count: rows.filter((x) => x.bucket === b).length, amount: total(rows.filter((x) => x.bucket === b)) }));
    const couriers = [...new Set(rows.map((x) => x.courier))].sort();
    const byCourier = couriers.map((c) => {
      const list = rows.filter((x) => x.courier === c);
      return { courier: c, count: list.length, amount: total(list), ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, total(list.filter((x) => x.bucket === b))])) };
    });
    return { asOf: now, currency: BASE_CURRENCY, count: rows.length, amount: total(rows), agedOver15: total(rows.filter((x) => x.days > 15)), byBucket, byCourier, rows };
  }

  async outstandingTable(q: { courier?: string }): Promise<ReportTable> {
    const d = await this.outstanding(q);
    return {
      title: 'Outstanding COD (collected by couriers, not yet remitted)',
      subtitle: `As of ${d.asOf.toISOString().slice(0, 10)} · ${d.count} parcels · PKR ${d.amount.toLocaleString('en-US')}`,
      columns: [
        { key: 'courier', label: 'Courier' }, { key: 'trackingNumber', label: 'Tracking' }, { key: 'orderNumber', label: 'Order' }, { key: 'storeName', label: 'Store' },
        { key: 'deliveredAt', label: 'Delivered' }, { key: 'days', label: 'Days', align: 'right' }, { key: 'bucket', label: 'Age' }, { key: 'codExpected', label: 'COD (PKR)', align: 'right' },
      ],
      rows: [
        ...d.rows.map((x) => ({ ...x, courier: x.courier.toUpperCase(), deliveredAt: x.deliveredAt.toISOString().slice(0, 10) })),
        { courier: 'Total', codExpected: d.amount, _bold: 1 },
      ],
    };
  }

  private async log(actor: AcctActor, action: string, description: string, id: string) {
    try {
      await this.activity.log({ category: 'accounting', action, description, actorId: actor.id, actorRole: 'admin', targetId: id, targetType: 'cod_remittance', ip: actor.ip, userAgent: actor.userAgent });
    } catch (e: any) { this.logger.warn(`activity log failed: ${e?.message}`); }
  }
}
