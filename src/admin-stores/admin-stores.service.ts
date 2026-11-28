/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { StoreService } from '../store/store.service';
import { AuthService } from '../auth/auth.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EmailService } from '../otp/services/email.service';
import { brandedEmailHtml } from '../common/branded-email.util';
import { CreateStoreForSellerDto } from './dto/create-store-for-seller.dto';
import { ManagedStoresService } from '../managed-stores/managed-stores.service';

export interface AdminActor { id: string; ip?: string; userAgent?: string }

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[ch]);

@Injectable()
export class AdminStoresService {
  private readonly logger = new Logger(AdminStoresService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly stores: StoreService,
    private readonly auth: AuthService,
    private readonly activity: ActivityLogService,
    private readonly managed: ManagedStoresService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /** The seller must be a usable account (not deleted / suspended). */
  private assertUsableSeller(seller: any) {
    if (!seller || seller.isDelete || seller.status === 'deleted') throw new NotFoundException('Seller not found');
    if (seller.status === 'suspended') throw new ForbiddenException('This seller account is suspended');
  }

  /**
   * Admin creates a store FOR a seller. The seller owns it (sellerId = seller); the admin never becomes the owner.
   * Reuses StoreService.createStore for every validation. A brand-new seller gets an invitation e-mail and sets their
   * own password through the normal "Forgot password" flow, so the admin never sees or chooses a password.
   */
  async createForSeller(admin: AdminActor, dto: CreateStoreForSellerDto) {
    if (!!dto.sellerId === !!dto.newSeller) throw new BadRequestException('Pick an existing seller OR enter a new seller, not both');
    const { sellerModel } = this.db.repositories;

    let seller: any;
    let createdSeller = false;
    if (dto.sellerId) {
      seller = await sellerModel.findById(dto.sellerId);
      this.assertUsableSeller(seller);
    } else {
      const email = dto.newSeller!.email.trim().toLowerCase();
      if (await sellerModel.exists({ email })) throw new ConflictException('A seller with this e-mail already exists. Pick them from the list instead.');
      seller = new sellerModel({ email, role: 'seller' });
      Object.assign(seller, {
        name: dto.newSeller!.name.trim(),
        phone: dto.newSeller!.phone?.trim() || undefined,
        // Unusable random password: the seller sets a real one by e-mail OTP (Forgot password).
        password: await bcrypt.hash(randomBytes(32).toString('hex'), 10),
        isVerified: true,
        status: 'active',
      });
      await seller.save();
      createdSeller = true;
    }

    let result: any;
    try {
      result = await this.stores.createStore(String(seller._id), dto.store);
    } catch (err) {
      // Do not leave an empty seller account behind when the store was refused.
      if (createdSeller) await sellerModel.deleteOne({ _id: seller._id }).catch(() => undefined);
      throw err;
    }
    const store = result?.data;
    const storeId = String(store?._id);
    await this.db.repositories.storeModel.updateOne({ _id: store._id }, { $set: { createdByAdmin: { adminId: admin.id, at: new Date() } } });

    const logged = await this.activity.log({
      storeId, category: 'settings', action: 'admin_store_created',
      description: `Admin created store "${store?.name}" for seller ${seller.email}${createdSeller ? ' (new seller account, invitation sent)' : ''}`,
      actorId: admin.id, actorRole: 'admin', targetId: storeId, targetType: 'store',
      ip: admin.ip, userAgent: admin.userAgent,
      metadata: { sellerId: String(seller._id), newSeller: createdSeller },
    });
    if (!logged) this.logger.error(`audit entry for admin_store_created ${storeId} was not stored`);

    const emailSent = createdSeller ? await this.sendInvite(seller.email, seller.name, String(store?.name)) : false;
    return { store: { id: storeId, name: store?.name, slug: store?.slug }, seller: { id: String(seller._id), email: seller.email, name: seller.name }, createdSeller, emailSent };
  }

  private async sendInvite(to: string, name: string, storeName: string): Promise<boolean> {
    if (!this.email) return false;
    const base = (process.env.WEB_APP_URL || 'https://edudeen.com').replace(/\/+$/, '');
    const link = `${base}/forgot-password?email=${encodeURIComponent(to)}`;
    const step = (n: number, text: string) =>
      `<tr><td width="34" valign="top" style="padding:0 0 12px;"><div style="width:24px; height:24px; line-height:24px; border-radius:12px; background:#EAF2F8; color:#174771; font-size:13px; font-weight:bold; text-align:center;">${n}</div></td><td valign="top" style="padding:2px 0 12px; font-size:15px; line-height:1.5; color:#1F3A52;">${text}</td></tr>`;
    const html = brandedEmailHtml({
      title: 'Your Edudeen store is ready',
      preheader: `${storeName} is set up. Choose your password to start selling.`,
      bodyHtml:
        `<p style="margin:0 0 14px;">Hi ${esc(name || 'there')},</p>` +
        `<p style="margin:0 0 14px;">The Edudeen team has set up your store <strong style="color:#174771;">${esc(storeName)}</strong>. To start using it, choose your own password:</p>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 0;">` +
        step(1, 'Click <strong>Set my password</strong> below.') +
        step(2, `Check that your e-mail address (<strong>${esc(to)}</strong>) is filled in, then click <strong>Send Reset Code</strong>.`) +
        step(3, 'Type the code we e-mail you and choose a password.') +
        `</table>`,
      button: { label: 'Set my password', url: link },
      note: 'If you were not expecting this e-mail, you can ignore it.',
    });
    try { return await this.email.sendMail(to, 'Your Edudeen store is ready', html); } catch (e: any) { this.logger.warn(`seller invite e-mail failed: ${e?.message}`); return false; }
  }

  /** 30-minute, store-locked seller session for the admin. Never refreshable. Audited before the token is handed out. */
  async manageSession(admin: AdminActor, storeId: string) {
    const { storeModel, sellerModel } = this.db.repositories;
    const store: any = await storeModel.findById(storeId).select('name slug status sellerId isDelete').lean();
    if (!store || store.isDelete) throw new NotFoundException('Store not found');
    if (store.status === 'suspended' || store.status === 'rejected') throw new ForbiddenException(`This store is ${store.status}`);
    // Team members run only the stores assigned to them; the owner admin may open any store.
    await this.managed.assertMayOperate(admin.id, storeId);
    const seller: any = await sellerModel.findById(store.sellerId).select('email status isDelete tokenVersion').lean();
    this.assertUsableSeller(seller);

    const logged = await this.activity.log({
      storeId, category: 'security', action: 'admin_manage_session_started',
      description: `Admin opened a manage-as-seller session for "${store.name}"`,
      actorId: admin.id, actorRole: 'admin', targetId: storeId, targetType: 'store',
      ip: admin.ip, userAgent: admin.userAgent, isSecurityAlert: false,
      metadata: { sellerId: String(store.sellerId), minutes: 30 },
    });
    if (!logged) throw new ServiceUnavailableException('Could not record this action. Try again.');

    const session = await this.auth.issueManageSession(seller, storeId, admin.id);
    return { accessToken: session.accessToken, expiresInSeconds: session.expiresInSeconds, store: { id: storeId, name: store.name, slug: store.slug } };
  }
}
