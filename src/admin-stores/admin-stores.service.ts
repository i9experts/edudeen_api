/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { StoreService } from '../store/store.service';
import { AuthService } from '../auth/auth.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EmailService } from '../otp/services/email.service';
import { CreateStoreForSellerDto } from './dto/create-store-for-seller.dto';

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
    const link = `${base}/forgot-password`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#141413"><h2 style="margin:0 0 12px">Your Edudeen store is ready</h2><p>Hi ${esc(name || 'there')},</p><p>The Edudeen team has set up your store <b>${esc(storeName)}</b>. To start using it, choose your own password:</p><ol><li>Open <a href="${link}">${link}</a></li><li>Select <b>Seller</b> and enter this e-mail address.</li><li>Type the code we send you and pick a password.</li></ol><p style="font-size:12px;color:#5d6570">If you were not expecting this e-mail, you can ignore it.</p></div>`;
    try { return await this.email.sendMail(to, 'Your Edudeen store is ready', html); } catch (e: any) { this.logger.warn(`seller invite e-mail failed: ${e?.message}`); return false; }
  }

  /** 30-minute, store-locked seller session for the admin. Never refreshable. Audited before the token is handed out. */
  async manageSession(admin: AdminActor, storeId: string) {
    const { storeModel, sellerModel } = this.db.repositories;
    const store: any = await storeModel.findById(storeId).select('name slug status sellerId isDelete').lean();
    if (!store || store.isDelete) throw new NotFoundException('Store not found');
    if (store.status === 'suspended' || store.status === 'rejected') throw new ForbiddenException(`This store is ${store.status}`);
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
