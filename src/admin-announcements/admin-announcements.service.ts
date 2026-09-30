/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { UpdateAnnouncementStatusDto } from './dto/update-announcement-status.dto';
import { AnnouncementQueryDto } from './dto/announcement-query.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminAnnouncementsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() {
    return this.databaseService.repositories.announcementModel;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'announcements',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      targetType: 'announcement',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async create(dto: CreateAnnouncementDto, meta: AuditMeta) {
    if (dto.status === 'scheduled' && !dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required when status is "scheduled"');
    }

    const announcement = await this.model.create({
      title: dto.title,
      message: dto.message,
      audience: dto.audience ?? 'all',
      status: dto.status ?? 'draft',
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      publishedAt: dto.status === 'published' ? new Date() : null,
      createdBy: meta.adminId,
    });

    this.log('announcement_created', `Announcement "${dto.title}" created`, meta, String(announcement._id));
    return { success: true, message: 'Announcement created', data: announcement };
  }

  async list(query: AnnouncementQueryDto) {
    const filter: Record<string, unknown> = { isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.audience) filter.audience = query.audience;
    if (query.search) filter.title = { $regex: query.search, $options: 'i' };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      this.model.countDocuments(filter),
    ]);

    return { success: true, data: { items, total, page, limit } };
  }

  private async findOrThrow(id: string) {
    const announcement = await this.model.findOne({ _id: id, isDelete: false });
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement;
  }

  async update(id: string, dto: UpdateAnnouncementDto, meta: AuditMeta) {
    await this.findOrThrow(id);

    const update: Record<string, unknown> = {};
    if (dto.title !== undefined) update.title = dto.title;
    if (dto.message !== undefined) update.message = dto.message;
    if (dto.audience !== undefined) update.audience = dto.audience;
    if (dto.scheduledAt !== undefined) update.scheduledAt = new Date(dto.scheduledAt);

    const announcement = await this.model.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
    this.log('announcement_updated', `Announcement "${announcement!.title}" updated`, meta, id);
    return { success: true, message: 'Announcement updated', data: announcement };
  }

  async setStatus(id: string, dto: UpdateAnnouncementStatusDto, meta: AuditMeta) {
    await this.findOrThrow(id);

    if (dto.status === 'scheduled' && !dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required when status is "scheduled"');
    }

    const update: Record<string, unknown> = { status: dto.status };
    if (dto.status === 'scheduled') update.scheduledAt = new Date(dto.scheduledAt as string);
    if (dto.status === 'published') update.publishedAt = new Date();

    const announcement = await this.model.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
    this.log('announcement_status_changed', `Announcement "${announcement!.title}" set to ${dto.status}`, meta, id);
    return { success: true, message: `Announcement set to ${dto.status}`, data: announcement };
  }

  async remove(id: string, meta: AuditMeta) {
    const announcement = await this.findOrThrow(id);
    await this.model.findByIdAndUpdate(id, { $set: { isDelete: true } });
    this.log('announcement_deleted', `Announcement "${announcement.title}" deleted`, meta, id);
    return { success: true, message: 'Announcement deleted' };
  }

  // ─── Public consumption (buyer/seller) ──────────────────────────────────
  // No cron flips 'scheduled' -> 'published' in this codebase, so a scheduled
  // announcement whose time has already passed is treated as live here at
  // read-time instead.
  async getActiveForAudience(audience: 'buyers' | 'sellers') {
    const now = new Date();
    const items = await this.model
      .find({
        isDelete: false,
        audience: { $in: ['all', audience] },
        $or: [{ status: 'published' }, { status: 'scheduled', scheduledAt: { $lte: now } }],
      })
      .sort({ publishedAt: -1, scheduledAt: -1, createdAt: -1 })
      .limit(5);

    return { success: true, data: items };
  }
}
