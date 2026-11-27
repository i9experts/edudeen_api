/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { escapeHtml, notificationEmailShell } from 'src/notifications/templates/notification-email.template';
import { assertProofFile } from 'src/common/proof-file.util';
import { clampInt } from 'src/common/query-safety.util';
import { SellerKyc, SellerKycDocument } from './schemas/seller-kyc.schema';
import {
  KYC_DOCUMENT_TYPES, KYC_ID_TYPES, KYC_SELLER_TYPES, KYC_STATUSES,
  assertKycTransition, decryptKycValue, encryptKycValue, isKycEditable, maskTail, missingKycRequirements, namesRoughlyMatch,
} from './kyc.util';
import type { KycDocumentType, KycStatus } from './kyc.util';

const KYC_FOLDER = 'private/kyc-documents';
const DOC_URL_TTL_SECONDS = 10 * 60;
const MAX_TEXT = 200;
const WEB = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

export interface KycDraftInput {
  sellerType?: unknown; idType?: unknown; fullName?: unknown; idNumber?: unknown; taxNumber?: unknown;
  legalBusinessName?: unknown; registrationNumber?: unknown; bankAccountHolder?: unknown; bankName?: unknown;
  address?: { country?: unknown; state?: unknown; city?: unknown; line?: unknown } | null;
}

function text(v: unknown, field: string, max = MAX_TEXT): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text`);
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > max) throw new BadRequestException(`${field} is too long`);
  return t || null;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new BadRequestException(`${field} is not valid`);
  return v as T;
}

/** Only the fields the seller sent are changed; `undefined` leaves a value alone, `null`/'' clears it. */
export function buildKycDraftUpdate(input: KycDraftInput): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (input.sellerType !== undefined) set.sellerType = oneOf(input.sellerType, KYC_SELLER_TYPES, 'Seller type');
  if (input.idType !== undefined) set.idType = oneOf(input.idType, KYC_ID_TYPES, 'ID type');
  for (const k of ['fullName', 'legalBusinessName', 'registrationNumber', 'bankAccountHolder', 'bankName'] as const) {
    if (input[k] !== undefined) set[k] = text(input[k], k);
  }
  if (input.address !== undefined && input.address !== null) {
    if (typeof input.address !== 'object') throw new BadRequestException('address must be an object');
    for (const k of ['country', 'state', 'city'] as const) {
      if (input.address[k] !== undefined) set[`address.${k}`] = text(input.address[k], k, 100);
    }
    if (input.address.line !== undefined) set['address.line'] = text(input.address.line, 'Address', 300);
  }
  // Secrets: stored encrypted, only the last 4 stay readable. Spaces/dashes are dropped before storing.
  for (const [k, enc, last4] of [['idNumber', 'idNumberEnc', 'idNumberLast4'], ['taxNumber', 'taxNumberEnc', 'taxNumberLast4']] as const) {
    if (input[k] === undefined) continue;
    const raw = text(input[k], k === 'idNumber' ? 'ID number' : 'Tax number', 60);
    const clean = raw ? raw.replace(/[\s-]/g, '') : null;
    if (clean && !/^[A-Za-z0-9]{3,40}$/.test(clean)) throw new BadRequestException(`${k === 'idNumber' ? 'ID number' : 'Tax number'} can only contain letters and numbers`);
    set[enc] = clean ? encryptKycValue(clean) : null;
    set[last4] = clean ? clean.slice(-4) : null;
  }
  return set;
}

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @InjectModel(SellerKyc.name) private readonly kycModel: Model<SellerKycDocument>,
    private readonly db: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
  ) {}

  private get sellerModel() { return this.db.repositories.sellerModel; }
  private get storeModel() { return this.db.repositories.storeModel; }

  private docUrl(d: { publicId: string; resourceType?: string; fileName?: string }) {
    try {
      return this.uploadService.generateSignedUrl(d.publicId, d.resourceType ?? 'image', DOC_URL_TTL_SECONDS, d.fileName, true);
    } catch {
      return null;
    }
  }

  /** Seller-facing shape: masked numbers, no storage ids, but a short-lived link to their own files. */
  private sellerView(k: any) {
    return {
      status: (k?.status ?? 'not_started') as KycStatus,
      editable: isKycEditable(k?.status ?? 'not_started'),
      sellerType: k?.sellerType ?? null,
      address: { country: k?.address?.country ?? null, state: k?.address?.state ?? null, city: k?.address?.city ?? null, line: k?.address?.line ?? null },
      idType: k?.idType ?? null,
      fullName: k?.fullName ?? null,
      idNumberMasked: maskTail(k?.idNumberLast4),
      taxNumberMasked: maskTail(k?.taxNumberLast4),
      legalBusinessName: k?.legalBusinessName ?? null,
      registrationNumber: k?.registrationNumber ?? null,
      bankAccountHolder: k?.bankAccountHolder ?? null,
      bankName: k?.bankName ?? null,
      documents: (k?.documents ?? []).map((d: any) => ({ type: d.type, fileName: d.fileName, uploadedAt: d.uploadedAt, viewUrl: this.docUrl(d) })),
      rejectionReason: k?.status === 'rejected' ? (k?.rejectionReason ?? null) : null,
      submittedAt: k?.submittedAt ?? null,
      reviewedAt: k?.reviewedAt ?? null,
      missing: missingKycRequirements({ ...k, idNumberEnc: k?.idNumberLast4, taxNumberEnc: k?.taxNumberLast4 }),
      history: (k?.history ?? []).map((h: any) => ({ action: h.action, note: h.note ?? null, at: h.at })),
    };
  }

  private async findOrCreate(sellerId: string) {
    return this.kycModel.findOneAndUpdate(
      { sellerId },
      { $setOnInsert: { sellerId, status: 'not_started' } },
      { upsert: true, new: true },
    );
  }

  private async editableKyc(sellerId: string) {
    const k = await this.findOrCreate(sellerId);
    if (!isKycEditable(k.status)) {
      throw new ConflictException(k.status === 'approved'
        ? 'Your verification is approved and locked. Contact support to change it.'
        : 'Your verification is under review. You can edit it again if the team asks for changes.');
    }
    return k;
  }

  async getMine(sellerId: string) {
    const k = await this.kycModel.findOne({ sellerId }).lean();
    return this.sellerView(k);
  }

  async saveDraft(sellerId: string, input: KycDraftInput) {
    await this.editableKyc(sellerId);
    const set = buildKycDraftUpdate(input ?? {});
    const k = Object.keys(set).length
      ? await this.kycModel.findOneAndUpdate({ sellerId, status: { $in: ['not_started', 'rejected'] } }, { $set: set }, { new: true }).lean()
      : await this.kycModel.findOne({ sellerId }).lean();
    if (!k) throw new ConflictException('Your verification can no longer be edited.');
    return this.sellerView(k);
  }

  async uploadDocument(sellerId: string, type: string, file: Express.Multer.File | undefined) {
    if (!(KYC_DOCUMENT_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Unknown document type');
    if (!file) throw new BadRequestException('Choose a photo or PDF to upload');
    assertProofFile(file);
    await this.editableKyc(sellerId);
    const up = await this.uploadService.uploadPrivateFile(file, KYC_FOLDER);
    const doc = { type: type as KycDocumentType, publicId: up.publicId, resourceType: up.resourceType, fileName: up.fileName, uploadedAt: new Date() };
    // One file per type: a new upload replaces the old one.
    await this.kycModel.updateOne({ sellerId }, { $pull: { documents: { type } } });
    const k = await this.kycModel.findOneAndUpdate(
      { sellerId, status: { $in: ['not_started', 'rejected'] } },
      { $push: { documents: doc } },
      { new: true },
    ).lean();
    if (!k) throw new ConflictException('Your verification can no longer be edited.');
    return this.sellerView(k);
  }

  async submit(sellerId: string) {
    const k = await this.editableKyc(sellerId);
    const full = await this.kycModel.findById(k._id).select('+idNumberEnc +taxNumberEnc').lean();
    const missing = missingKycRequirements(full as any);
    if (missing.length) throw new BadRequestException(`Please complete: ${missing.join(', ')}`);
    assertKycTransition(k.status, 'pending');

    const resubmit = k.status === 'rejected';
    const nameMismatchFlagged = !namesRoughlyMatch(full!.fullName, full!.bankAccountHolder);
    const updated = await this.kycModel.findOneAndUpdate(
      { _id: k._id, status: k.status },
      {
        $set: { status: 'pending', submittedAt: new Date(), rejectionReason: null, nameMismatchFlagged },
        $push: { history: { action: resubmit ? 'resubmitted' : 'submitted', actorId: sellerId, actorRole: 'seller', at: new Date() } },
      },
      { new: true },
    ).lean();
    if (!updated) throw new ConflictException('Your verification changed while submitting. Refresh and try again.');
    await this.sellerModel.updateOne({ _id: sellerId }, { $set: { kycStatus: 'pending' } });
    return this.sellerView(updated);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  async adminList(query: { status?: string; search?: string; page?: unknown; limit?: unknown }) {
    const page = clampInt(query.page, 1, 1, 10_000);
    const limit = clampInt(query.limit, 20, 1, 100);
    const filter: Record<string, any> = { status: { $ne: 'not_started' } };
    if (query.status && (KYC_STATUSES as readonly string[]).includes(query.status)) filter.status = query.status;
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const sellers = await this.sellerModel.find({ $or: [{ name: rx }, { email: rx }] }).select('_id').limit(200).lean();
      filter.$or = [{ fullName: rx }, { legalBusinessName: rx }, { sellerId: { $in: sellers.map((s: any) => String(s._id)) } }];
    }
    const [rows, total, counts] = await Promise.all([
      this.kycModel.find(filter).sort({ submittedAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.kycModel.countDocuments(filter),
      this.kycModel.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const sellers = await this.sellerModel.find({ _id: { $in: rows.map((r) => r.sellerId).filter(isValidObjectId) } }).select('name email').lean();
    const byId = new Map(sellers.map((s: any) => [String(s._id), s]));
    return {
      items: rows.map((r) => ({
        id: String(r._id),
        sellerId: r.sellerId,
        sellerName: byId.get(r.sellerId)?.name ?? null,
        sellerEmail: byId.get(r.sellerId)?.email ?? null,
        status: r.status,
        sellerType: r.sellerType,
        fullName: r.fullName,
        legalBusinessName: r.legalBusinessName,
        country: r.address?.country ?? null,
        nameMismatchFlagged: !!r.nameMismatchFlagged,
        submittedAt: r.submittedAt,
        reviewedAt: r.reviewedAt,
      })),
      total, page, limit,
      counts: Object.fromEntries(counts.map((c: any) => [c._id, c.n])),
    };
  }

  async adminGet(id: string) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid id');
    const k: any = await this.kycModel.findById(id).select('+idNumberEnc +taxNumberEnc').lean();
    if (!k) throw new NotFoundException('Verification not found');
    const [seller, stores] = await Promise.all([
      isValidObjectId(k.sellerId) ? this.sellerModel.findById(k.sellerId).select('name email phone createdAt status').lean() : null,
      this.storeModel.find({ sellerId: k.sellerId, isDelete: false }).select('name slug status').lean(),
    ]);
    return {
      id: String(k._id),
      sellerId: k.sellerId,
      seller: seller ? { name: (seller as any).name ?? null, email: (seller as any).email ?? null, phone: (seller as any).phone ?? null, status: (seller as any).status ?? null, joinedAt: (seller as any).createdAt ?? null } : null,
      stores: stores.map((s: any) => ({ id: String(s._id), name: s.name, slug: s.slug, status: s.status })),
      status: k.status,
      sellerType: k.sellerType,
      address: k.address ?? {},
      idType: k.idType,
      fullName: k.fullName,
      idNumber: decryptKycValue(k.idNumberEnc),
      taxNumber: decryptKycValue(k.taxNumberEnc),
      legalBusinessName: k.legalBusinessName,
      registrationNumber: k.registrationNumber,
      bankAccountHolder: k.bankAccountHolder,
      bankName: k.bankName,
      nameMismatchFlagged: !!k.nameMismatchFlagged,
      documents: (k.documents ?? []).map((d: any) => ({ type: d.type, fileName: d.fileName, uploadedAt: d.uploadedAt, viewUrl: this.docUrl(d) })),
      rejectionReason: k.rejectionReason ?? null,
      submittedAt: k.submittedAt, reviewedAt: k.reviewedAt, reviewedBy: k.reviewedBy,
      history: k.history ?? [],
    };
  }

  /** approve: pending → approved. reject: pending → rejected. revoke: approved → rejected (fraud found later). */
  async adminDecide(id: string, decision: 'approve' | 'reject' | 'revoke', reason: string | undefined, meta: { adminId: string; ip?: string; userAgent?: string }) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid id');
    const note = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (decision !== 'approve' && !note) throw new BadRequestException('Tell the seller why, so they can fix it');
    const k = await this.kycModel.findById(id).lean();
    if (!k) throw new NotFoundException('Verification not found');
    const from = k.status;
    const to: KycStatus = decision === 'approve' ? 'approved' : 'rejected';
    if (decision === 'revoke' && from !== 'approved') throw new BadRequestException('Only an approved verification can be revoked');
    if (decision !== 'revoke' && from !== 'pending') throw new ConflictException('This verification is not waiting for review.');
    assertKycTransition(from, to);

    const now = new Date();
    const updated = await this.kycModel.findOneAndUpdate(
      { _id: id, status: from },
      {
        $set: { status: to, reviewedAt: now, reviewedBy: meta.adminId, rejectionReason: to === 'rejected' ? note : null },
        $push: { history: { action: decision === 'approve' ? 'approved' : decision === 'revoke' ? 'revoked' : 'rejected', note: note || null, actorId: meta.adminId, actorRole: 'admin', at: now } },
      },
      { new: true },
    ).lean();
    if (!updated) throw new ConflictException('This verification was already reviewed.');

    await this.sellerModel.updateOne({ _id: k.sellerId }, { $set: { kycStatus: to } });
    // The storefront "Verified" badge follows the seller's KYC on every store they own.
    await this.storeModel.updateMany(
      { sellerId: k.sellerId },
      to === 'approved' ? { $addToSet: { badges: 'verified' } } : { $pull: { badges: 'verified' } },
    );

    void this.activityLog.log({
      storeId: 'platform', category: 'security', action: `seller_kyc_${decision === 'approve' ? 'approved' : decision === 'revoke' ? 'revoked' : 'rejected'}`,
      description: `${decision === 'approve' ? 'Approved' : decision === 'revoke' ? 'Revoked' : 'Rejected'} seller verification for ${k.fullName ?? k.sellerId}`,
      actorId: meta.adminId, actorRole: 'admin', targetId: String(k._id), targetType: 'seller_kyc',
      ip: meta.ip, userAgent: meta.userAgent, metadata: { sellerId: k.sellerId, note: note || null },
    });

    const link = `${WEB()}/seller/verification`;
    const approved = to === 'approved';
    const title = approved ? 'You are verified' : 'Your verification needs changes';
    const body = approved
      ? 'Your identity verification (KYC) is approved. You can now withdraw your earnings, and your stores show a Verified badge.'
      : `Your identity verification (KYC) was not approved. Reason: ${note}. Please update your details and submit again.`;
    void this.notifications.notify({
      recipientId: k.sellerId, recipientRole: 'seller',
      type: approved ? NOTIFICATION_TYPES.KYC_APPROVED : NOTIFICATION_TYPES.KYC_REJECTED,
      title, body, data: { link: '/seller/verification' },
      email: {
        subject: approved ? 'Your Edudeen seller account is verified' : 'Action needed: your Edudeen verification',
        html: notificationEmailShell(title, `<p>${escapeHtml(body)}</p>`, { label: approved ? 'Go to my dashboard' : 'Update my details', url: link }),
      },
    });
    return { success: true, data: { id: String(updated._id), status: updated.status } };
  }
}
