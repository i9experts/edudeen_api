/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EmailService } from '../otp/services/email.service';
import { escapeHtml, notificationEmailShell } from '../notifications/templates/notification-email.template';
import { UploadService } from '../upload/upload.service';
import { assertProofFile } from '../common/proof-file.util';
import { escapeRegex } from '../common/query-safety.util';
import { STORE_ASSIGNMENT_ROLES, StoreAssignment, StoreAssignmentDocument, type StoreAssignmentRole } from './schemas/store-assignment.schema';
import { cleanManagedInput, mouStatus, type ManagedInput } from './managed-stores.util';

export interface Actor { id: string; ip?: string; userAgent?: string }

const MOU_FOLDER = 'private/mou-documents';
const DOC_URL_TTL_SECONDS = 10 * 60;
const STORE_FIELDS = 'name slug status sellerId country baseCurrency managementType mou fulfillmentMode createdByAdmin createdAt logo';
const webUrl = () => (process.env.WEB_APP_URL || 'https://www.edudeen.com').replace(/\/$/, '');

@Injectable()
export class ManagedStoresService {
  private readonly logger = new Logger(ManagedStoresService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectModel(StoreAssignment.name) private readonly assignmentModel: Model<StoreAssignmentDocument>,
    private readonly activity: ActivityLogService,
    private readonly upload: UploadService,
    private readonly email: EmailService,
  ) {}

  private get storeModel() { return this.db.repositories.storeModel; }
  private get sellerModel() { return this.db.repositories.sellerModel; }
  private get adminModel() { return this.db.repositories.adminModel; }

  /** Owner = an admin account that is not a staff member (full access, see staff/permissions.ts). */
  async isOwner(adminId: string): Promise<boolean> {
    const a: any = await this.adminModel.findById(adminId).select('isStaff isDelete').lean();
    return !!a && !a.isDelete && !a.isStaff;
  }

  /** Staff may operate (manage-as-seller) only stores assigned to them; the owner may operate any store. */
  async assertMayOperate(adminId: string, storeId: string): Promise<void> {
    if (await this.isOwner(adminId)) return;
    const assigned = await this.assignmentModel.exists({ storeId, adminId, active: true });
    if (!assigned) throw new ForbiddenException('This store is not assigned to you. Ask the owner to assign it.');
  }

  private shapeMou(store: any, now = new Date()) {
    const m = store.mou;
    return {
      status: mouStatus(m, now),
      commissionRate: m?.commissionRate ?? null,
      startDate: m?.startDate ?? null,
      endDate: m?.endDate ?? null,
      notes: m?.notes ?? null,
      hasDocument: !!m?.document?.publicId,
      documentName: m?.document?.fileName ?? null,
      updatedAt: m?.updatedAt ?? null,
    };
  }

  private async decorate(stores: any[]) {
    const ids = stores.map((s) => String(s._id));
    const sellerIds = [...new Set(stores.map((s) => String(s.sellerId)).filter(Boolean))];
    const [sellers, assignments] = await Promise.all([
      this.sellerModel.find({ _id: { $in: sellerIds } }).select('name email').lean(),
      this.assignmentModel.find({ storeId: { $in: ids }, active: true }).lean(),
    ]);
    const adminIds = [...new Set(assignments.map((a: any) => a.adminId))];
    const admins = adminIds.length ? await this.adminModel.find({ _id: { $in: adminIds } }).select('name email').lean() : [];
    const sellerById = new Map(sellers.map((s: any) => [String(s._id), s]));
    const adminById = new Map(admins.map((a: any) => [String(a._id), a]));
    const now = new Date();
    return stores.map((s) => {
      const seller: any = sellerById.get(String(s.sellerId));
      return {
        id: String(s._id),
        name: s.name,
        slug: s.slug,
        logo: s.logo ?? null,
        status: s.status,
        country: s.country ?? null,
        currency: s.baseCurrency ?? null,
        managementType: s.managementType ?? 'self',
        fulfillmentMode: s.fulfillmentMode ?? 'seller',
        createdByAdmin: !!s.createdByAdmin,
        createdAt: s.createdAt ?? null,
        seller: seller ? { id: String(seller._id), name: seller.name ?? null, email: seller.email ?? null } : null,
        mou: s.managementType === 'managed' || s.mou ? this.shapeMou(s, now) : null,
        assignees: assignments
          .filter((a: any) => a.storeId === String(s._id))
          .map((a: any) => ({ adminId: a.adminId, role: a.role, name: adminById.get(a.adminId)?.name ?? null, email: adminById.get(a.adminId)?.email ?? null, assignedAt: a.assignedAt })),
      };
    });
  }

  /** All stores (owner / staff with managed.manage). Filters: type, mouStatus, assignee, q. */
  async list(query: { type?: string; mouStatus?: string; assignee?: string; q?: string; page?: string | number; limit?: string | number }) {
    const filter: any = { isDelete: false };
    if (query.type === 'managed' || query.type === 'self') filter.managementType = query.type === 'self' ? { $ne: 'managed' } : 'managed';
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
    if (q) filter.$or = [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { slug: { $regex: escapeRegex(q), $options: 'i' } }];
    if (typeof query.assignee === 'string' && query.assignee) {
      const ids = (await this.assignmentModel.find({ adminId: query.assignee, active: true }).select('storeId').lean()).map((a: any) => a.storeId);
      filter._id = { $in: ids };
    }
    const stores: any[] = await this.storeModel.find(filter).select(STORE_FIELDS).sort({ managementType: 1, createdAt: -1 }).limit(2000).lean();
    let rows = await this.decorate(stores);
    if (query.mouStatus) rows = rows.filter((r) => (r.mou?.status ?? 'none') === query.mouStatus);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const page = Math.max(1, Number(query.page) || 1);
    const counts = {
      all: rows.length,
      managed: rows.filter((r) => r.managementType === 'managed').length,
      expiring: rows.filter((r) => r.mou?.status === 'expiring_soon').length,
      expired: rows.filter((r) => r.managementType === 'managed' && r.mou?.status === 'expired').length,
    };
    return { items: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit, counts };
  }

  /** Stores assigned to this team member (the "My stores" list); the owner sees every managed store. */
  async mine(adminId: string) {
    const owner = await this.isOwner(adminId);
    const ids = owner ? null : (await this.assignmentModel.find({ adminId, active: true }).select('storeId').lean()).map((a: any) => a.storeId);
    const filter: any = owner ? { isDelete: false, managementType: 'managed' } : { isDelete: false, _id: { $in: ids } };
    const stores = await this.storeModel.find(filter).select(STORE_FIELDS).sort({ name: 1 }).limit(500).lean();
    return { isOwner: owner, items: await this.decorate(stores) };
  }

  async get(storeId: string) {
    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select(STORE_FIELDS).lean();
    if (!store) throw new NotFoundException('Store not found');
    const [row] = await this.decorate([store]);
    return { ...row, history: (store.mou?.history ?? []).slice(-50).reverse() };
  }

  private async log(actor: Actor, storeId: string, action: string, description: string, metadata?: Record<string, unknown>) {
    const ok = await this.activity.log({
      storeId, category: 'managed', action, description,
      actorId: actor.id, actorRole: 'admin', targetId: storeId, targetType: 'store',
      ip: actor.ip, userAgent: actor.userAgent, metadata: metadata ?? null,
    });
    if (!ok) this.logger.error(`audit entry for ${action} on ${storeId} was not stored`);
  }

  async update(actor: Actor, storeId: string, input: ManagedInput) {
    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name managementType mou fulfillmentMode').lean();
    if (!store) throw new NotFoundException('Store not found');
    const clean = cleanManagedInput(input, store);
    const set: Record<string, unknown> = {};
    const changes: Record<string, unknown> = {};
    if (clean.managementType && clean.managementType !== (store.managementType ?? 'self')) {
      set.managementType = clean.managementType;
      changes.managementType = { from: store.managementType ?? 'self', to: clean.managementType };
    }
    if (clean.fulfillmentMode && clean.fulfillmentMode !== (store.fulfillmentMode ?? 'seller')) {
      set.fulfillmentMode = clean.fulfillmentMode;
      changes.fulfillmentMode = { from: store.fulfillmentMode ?? 'seller', to: clean.fulfillmentMode };
    }
    if (clean.mou) {
      const prev = store.mou ?? {};
      for (const k of ['commissionRate', 'startDate', 'endDate', 'notes'] as const) {
        const a = prev[k] instanceof Date ? prev[k].toISOString() : prev[k] ?? null;
        const b = (clean.mou as any)[k] instanceof Date ? (clean.mou as any)[k].toISOString() : (clean.mou as any)[k];
        if (a !== b) changes[k] = { from: a, to: b };
      }
      if (['commissionRate', 'startDate', 'endDate', 'notes'].some((k) => k in changes)) {
        for (const [k, v] of Object.entries(clean.mou)) set[`mou.${k}`] = v;
        set['mou.updatedBy'] = actor.id;
        set['mou.updatedAt'] = new Date();
        // A new end date gets fresh expiry notices.
        if ('endDate' in changes) set['mou.lastNotice'] = null;
      }
    }
    if (!Object.keys(set).length) return this.get(storeId);
    // `mou` is null on a store that was never managed; dotted $set/$push paths need an object there first.
    if (!store.mou) await this.storeModel.updateOne({ _id: storeId, mou: null }, { $set: { mou: { history: [] } } });
    const push = { 'mou.history': { $each: [{ action: changes.managementType ? 'type_changed' : 'updated', changes, actorId: actor.id, at: new Date() }], $slice: -200 } };
    await this.storeModel.updateOne({ _id: storeId }, { $set: set, $push: push });

    const parts: string[] = [];
    if (changes.managementType) parts.push(`type ${String((changes.managementType as any).from)} → ${String((changes.managementType as any).to)}`);
    if (changes.commissionRate) parts.push(`MOU commission ${pct((changes.commissionRate as any).from)} → ${pct((changes.commissionRate as any).to)}`);
    if (changes.startDate || changes.endDate) parts.push('MOU dates changed');
    if (changes.notes) parts.push('MOU notes changed');
    if (changes.fulfillmentMode) parts.push(`shipping by ${(changes.fulfillmentMode as any).to === 'platform' ? 'Edudeen' : 'the seller'} (new orders only)`);
    await this.log(actor, storeId, 'managed_store_updated', `Managed-store settings of "${store.name}": ${parts.join('; ')}`, { changes });
    return this.get(storeId);
  }

  async uploadDocument(actor: Actor, storeId: string, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Choose the signed MOU (PDF or photo) to upload');
    assertProofFile(file);
    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name managementType mou').lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.managementType !== 'managed') throw new BadRequestException('Mark the store as managed before uploading its MOU');
    const up = await this.upload.uploadPrivateFile(file, MOU_FOLDER);
    const document = { publicId: up.publicId, resourceType: up.resourceType, fileName: up.fileName, uploadedAt: new Date() };
    await this.storeModel.updateOne(
      { _id: storeId },
      {
        $set: { 'mou.document': document, 'mou.updatedBy': actor.id, 'mou.updatedAt': new Date() },
        $push: { 'mou.history': { $each: [{ action: 'document_uploaded', changes: { fileName: up.fileName }, actorId: actor.id, at: new Date() }], $slice: -200 } },
      },
    );
    await this.log(actor, storeId, 'managed_mou_uploaded', `Signed MOU uploaded for "${store.name}" (${up.fileName})`);
    return this.get(storeId);
  }

  async documentUrl(storeId: string) {
    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('+mou').lean();
    const d = store?.mou?.document;
    if (!d?.publicId) throw new NotFoundException('No signed MOU uploaded for this store');
    return { url: this.upload.generateSignedUrl(d.publicId, d.resourceType ?? 'raw', DOC_URL_TTL_SECONDS, d.fileName, true), fileName: d.fileName, expiresInSeconds: DOC_URL_TTL_SECONDS };
  }

  /** Admin accounts that can be assigned (owners and active staff), with how many stores each runs. */
  async team() {
    const admins: any[] = await this.adminModel.find({ isDelete: { $ne: true } }).select('name email isStaff staffStatus accessExpiresAt').sort({ name: 1 }).limit(500).lean();
    const counts = await this.assignmentModel.aggregate([{ $match: { active: true } }, { $group: { _id: '$adminId', n: { $sum: 1 } } }]);
    const byId = new Map(counts.map((c: any) => [String(c._id), c.n]));
    return admins
      .filter((a) => !a.isStaff || a.staffStatus !== 'suspended')
      .map((a) => ({ id: String(a._id), name: a.name ?? null, email: a.email, isStaff: !!a.isStaff, status: a.isStaff ? a.staffStatus ?? 'active' : 'owner', assignedStores: byId.get(String(a._id)) ?? 0 }));
  }

  async assign(actor: Actor, storeId: string, adminId: string, role: string | undefined) {
    const r = (role ?? 'account_manager') as StoreAssignmentRole;
    if (!(STORE_ASSIGNMENT_ROLES as readonly string[]).includes(r)) throw new BadRequestException('role must be account_manager or assistant');
    const [store, admin]: any[] = await Promise.all([
      this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name').lean(),
      this.adminModel.findById(adminId).select('name email isStaff staffStatus isDelete').lean(),
    ]);
    if (!store) throw new NotFoundException('Store not found');
    if (!admin || admin.isDelete) throw new NotFoundException('Team member not found');
    if (admin.isStaff && admin.staffStatus === 'suspended') throw new BadRequestException('This team member is suspended');
    const existing: any = await this.assignmentModel.findOne({ storeId, adminId, active: true }).lean();
    if (existing) {
      if (existing.role !== r) await this.assignmentModel.updateOne({ _id: existing._id }, { $set: { role: r } });
    } else {
      try {
        await this.assignmentModel.create({ storeId, adminId, role: r, assignedBy: actor.id, assignedAt: new Date(), active: true });
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // a concurrent identical assignment already won
      }
    }
    await this.log(actor, storeId, 'managed_store_assigned', `${admin.name ?? admin.email} assigned to "${store.name}" as ${r.replace('_', ' ')}`, { adminId, role: r });
    return this.get(storeId);
  }

  async unassign(actor: Actor, storeId: string, adminId: string) {
    const res = await this.assignmentModel.updateOne({ storeId, adminId, active: true }, { $set: { active: false, removedBy: actor.id, removedAt: new Date() } });
    if (!res.modifiedCount) throw new NotFoundException('This person is not assigned to the store');
    const [store, admin]: any[] = await Promise.all([
      this.storeModel.findById(storeId).select('name').lean(),
      this.adminModel.findById(adminId).select('name email').lean(),
    ]);
    await this.log(actor, storeId, 'managed_store_unassigned', `${admin?.name ?? admin?.email ?? adminId} removed from "${store?.name ?? storeId}"`, { adminId });
    return this.get(storeId);
  }

  /**
   * Daily: tells the owner admins and the store's assigned team when a managed store's MOU is about to end
   * (≤30 days) and when it has ended. Each notice is sent once per end date (guarded `mou.lastNotice` claim),
   * so overlapping runs or restarts never repeat it. Returns how many notices went out.
   */
  async sendMouNotices(now: Date = new Date()): Promise<number> {
    const stores: any[] = await this.storeModel
      .find({ isDelete: false, managementType: 'managed', 'mou.endDate': { $ne: null } })
      .select('name +mou')
      .limit(2000)
      .lean();
    let sent = 0;
    for (const s of stores) {
      const status = mouStatus(s.mou, now);
      if (status !== 'expiring_soon' && status !== 'expired') continue;
      const key = `${status}:${new Date(s.mou.endDate).toISOString().slice(0, 10)}`;
      if (s.mou.lastNotice === key) continue;
      const claimed = await this.storeModel.updateOne({ _id: s._id, 'mou.lastNotice': s.mou.lastNotice ?? null }, { $set: { 'mou.lastNotice': key } });
      if (!claimed.modifiedCount) continue;
      const storeId = String(s._id);
      const end = new Date(s.mou.endDate).toISOString().slice(0, 10);
      const title = status === 'expired' ? `MOU ended: ${s.name}` : `MOU ending soon: ${s.name}`;
      const body = status === 'expired'
        ? `The MOU for ${s.name} ended on ${end}. Its commission still applies until you renew it or switch the store to self-managed.`
        : `The MOU for ${s.name} ends on ${end}. Renew it or plan the handover.`;
      const link = `${webUrl()}/admin/stores?store=${storeId}`;
      const html = notificationEmailShell(escapeHtml(title), `<p>${escapeHtml(body)}</p>`, { label: 'Open the store', url: link });
      // Admin accounts have no in-app inbox on the notifications service (buyers/sellers only), so this is e-mail.
      const recipients = await this.noticeRecipients(storeId);
      await Promise.allSettled(recipients.map((to) => this.email.sendMail(to, title, html)));
      await this.activity.log({
        storeId, category: 'managed', action: status === 'expired' ? 'managed_mou_expired' : 'managed_mou_expiring',
        description: body, actorId: null, actorRole: 'system', targetId: storeId, targetType: 'store', metadata: { endDate: end, notified: recipients.length },
      });
      sent++;
    }
    return sent;
  }

  /** E-mail addresses of the owner admins and the store's assigned team members. */
  private async noticeRecipients(storeId: string): Promise<string[]> {
    const assigned = (await this.assignmentModel.find({ storeId, active: true }).select('adminId').lean()).map((a: any) => a.adminId);
    const admins: any[] = await this.adminModel
      .find({ isDelete: { $ne: true }, $or: [{ isStaff: { $ne: true } }, { _id: { $in: assigned } }] })
      .select('email')
      .lean();
    return [...new Set(admins.map((a) => a.email).filter((e): e is string => typeof e === 'string' && e.includes('@')))];
  }
}

const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 10000) / 100}%` : 'none');
