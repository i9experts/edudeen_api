/* eslint-disable prettier/prettier */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';
import { StartConversationDto } from './dto/start-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { BlockDto } from './dto/block.dto';
import { ReportDto } from './dto/report.dto';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { MessagingGateway } from './messaging.gateway';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';

@Injectable()
export class MessagingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly gateway: MessagingGateway,
    private readonly notificationsService: NotificationsService,
  ) { }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private get convModel() { return this.db.repositories.conversationModel; }
  private get msgModel() { return this.db.repositories.messageModel; }
  private get blkModel() { return this.db.repositories.blockModel; }
  private get rptModel() { return this.db.repositories.reportModel; }

  private async getConversationOrThrow(conversationId: string) {
    if (!Types.ObjectId.isValid(conversationId)) throw new BadRequestException('Invalid conversation ID');
    const conv = await this.convModel.findById(conversationId);
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }

  private async getMessageOrThrow(messageId: string) {
    if (!Types.ObjectId.isValid(messageId)) throw new BadRequestException('Invalid message ID');
    const msg = await this.msgModel.findById(messageId);
    if (!msg) throw new NotFoundException('Message not found');
    return msg;
  }

  // Access is decided by whether this account is actually a participant in
  // THIS conversation (its buyerId or sellerId), never by the account's JWT
  // role — an account can be a buyer in one conversation and a seller (of a
  // different store) in another, so role alone can't tell you which side
  // you're on here.
  private assertConversationAccess(conv: any, userId: string, role: string) {
    if (role === 'admin') return;
    const isParticipant = conv.buyerId.toString() === userId || conv.sellerId.toString() === userId;
    if (!isParticipant) throw new ForbiddenException('Access denied');
  }

  // Spam detection hook: score based on URL density and length
  private spamScore(text: string | undefined): number {
    if (!text) return 0;
    const urlMatches = (text.match(/https?:\/\//gi) || []).length;
    if (urlMatches > 5) return 3;
    if (urlMatches > 2) return 1;
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async startOrGetConversation(buyerId: string, dto: StartConversationDto) {
    const { storeId } = dto;
    const store = await this.db.repositories.storeModel.findById(storeId);
    // Only live stores can be messaged (pending/suspended/rejected stores used to receive conversations).
    if (!store || store.isDelete || store.status !== 'active') throw new NotFoundException('Store not found');
    if (store.sellerId.toString() === buyerId) throw new BadRequestException('You cannot message your own store');

    // Check if buyer is blocked by seller or vice versa
    const block = await this.blkModel.findOne({
      $or: [
        { blockerId: store.sellerId.toString(), targetId: buyerId },
        { blockerId: buyerId, targetId: store.sellerId.toString() },
      ],
    });
    if (block) throw new ForbiddenException('Cannot start conversation — block is in place');

    const entry = await this.subscriptionBenefits.getActiveBenefits(buyerId, storeId);
    const isPriority = !!entry && entry.benefits.some((b: any) => b.type === 'priority_support' && b.enabled !== false);

    const conv = await this.convModel.findOneAndUpdate(
      { buyerId, storeId },
      {
        $setOnInsert: {
          buyerId,
          storeId,
          sellerId: store.sellerId.toString(),
          buyerUnread: 0,
          sellerUnread: 0,
          isPriority,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    // Restore if soft-deleted by buyer
    if (conv.deletedByBuyer) {
      conv.deletedByBuyer = false;
      await conv.save();
    }

    // Keep the flag current for an existing conversation too (buyer may have
    // subscribed/unsubscribed since the conversation was first started).
    if (conv.isPriority !== isPriority) {
      conv.isPriority = isPriority;
      await conv.save();
    }

    return conv;
  }

  async getConversations(userId: string, role: string, query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    let filter: any = {};

    // Disambiguate by the query shape, not the account's JWT role: a
    // storeId means "show me this store's inbox" (only that store's owner
    // may pass it); no storeId means "show me MY OWN conversations as a
    // buyer" — which must work even for an account that also happens to
    // have a seller role elsewhere.
    if (role === 'admin') {
      if (query.storeId) filter.storeId = query.storeId;
      if (query.buyerId) filter.buyerId = query.buyerId;
    } else if (query.storeId) {
      const store = await this.db.repositories.storeModel.findById(query.storeId);
      if (!store || store.sellerId.toString() !== userId) throw new ForbiddenException('Access denied');
      filter = { storeId: query.storeId, deletedBySeller: false };
      if (query.isArchived !== undefined) filter.isArchived = query.isArchived === 'true';
      if (query.isPinned !== undefined) filter.isPinned = query.isPinned === 'true';
    } else {
      filter = { buyerId: userId, deletedByBuyer: false };
    }

    if (query.q) {
      filter['lastMessage.text'] = { $regex: query.q, $options: 'i' };
    }

    // Priority (priority_support subscribers) sort above regular conversations, seller inbox only.
    const sort: any = query.storeId ? { isPriority: -1, updatedAt: -1 } : { updatedAt: -1 };

    const [conversations, total] = await Promise.all([
      this.convModel.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      this.convModel.countDocuments(filter),
    ]);

    // Attach buyer/store info
    const buyerIds = [...new Set(conversations.map((c: any) => c.buyerId))];
    const storeIds = [...new Set(conversations.map((c: any) => c.storeId))];

    const [buyers, stores] = await Promise.all([
      this.db.repositories.userModel.find({ _id: { $in: buyerIds } }).select('name profileImage').lean(),
      this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name logo slug badges').lean(),
    ]);

    const buyerMap = Object.fromEntries(buyers.map((b: any) => [b._id.toString(), b]));
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    const enriched = conversations.map((c: any) => ({
      ...c,
      buyer: buyerMap[c.buyerId] || null,
      store: storeMap[c.storeId] || null,
    }));

    return { conversations: enriched, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getConversationById(userId: string, role: string, conversationId: string) {
    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);

    const [buyer, store] = await Promise.all([
      this.db.repositories.userModel.findById(conv.buyerId).select('name profileImage email').lean(),
      this.db.repositories.storeModel.findById(conv.storeId).select('name logo slug badges').lean(),
    ]);

    return { ...conv.toObject(), buyer, store };
  }

  async archiveConversation(sellerId: string, conversationId: string, archive: boolean) {
    const conv = await this.getConversationOrThrow(conversationId);
    if (conv.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
    conv.isArchived = archive;
    await conv.save();
    return { isArchived: conv.isArchived };
  }

  async pinConversation(sellerId: string, conversationId: string, pin: boolean) {
    const conv = await this.getConversationOrThrow(conversationId);
    if (conv.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
    conv.isPinned = pin;
    await conv.save();
    return { isPinned: conv.isPinned };
  }

  async muteConversation(sellerId: string, conversationId: string, mute: boolean) {
    const conv = await this.getConversationOrThrow(conversationId);
    if (conv.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
    conv.isMuted = mute;
    await conv.save();
    return { isMuted: conv.isMuted };
  }

  async deleteConversationForSelf(userId: string, role: string, conversationId: string) {
    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);

    if (conv.buyerId.toString() === userId) conv.deletedByBuyer = true;
    else conv.deletedBySeller = true;
    await conv.save();
    return { deleted: true };
  }

  async searchConversations(userId: string, role: string, q: string, storeId?: string) {
    if (!q || q.trim().length < 2) throw new BadRequestException('Search query must be at least 2 characters');

    const filter: any = {};
    if (storeId) {
      const store = await this.db.repositories.storeModel.findById(storeId);
      if (!store || store.sellerId.toString() !== userId) throw new ForbiddenException('Access denied');
      filter.storeId = storeId;
    } else {
      filter.buyerId = userId;
    }

    // Search in last message text
    filter['lastMessage.text'] = { $regex: q.trim(), $options: 'i' };

    const results = await this.convModel.find(filter).sort({ updatedAt: -1 }).limit(30).lean();
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════════════════════════════

  async sendMessage(userId: string, role: string, conversationId: string, dto: SendMessageDto) {
    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);
    // Which side of THIS conversation the sender is on — not their JWT role,
    // since the same account can be a buyer here and a seller elsewhere.
    const iAmBuyer = conv.buyerId.toString() === userId;
    const senderRole = role === 'admin' ? 'admin' : iAmBuyer ? 'user' : 'seller';

    // Block check — the mirrored flags AND the Block collection (the flags can drift, e.g. a block created from
    // the other role, or before the conversation existed).
    if (conv.blockedByBuyer || conv.blockedBySeller) {
      throw new ForbiddenException('Cannot send message — conversation is blocked');
    }
    if (role !== 'admin') {
      const blocked = await this.blkModel.exists({
        $or: [
          { blockerId: conv.buyerId.toString(), targetId: conv.sellerId.toString() },
          { blockerId: conv.sellerId.toString(), targetId: conv.buyerId.toString() },
        ],
      });
      if (blocked) throw new ForbiddenException('Cannot send message — conversation is blocked');
    }

    // Validate content
    if (dto.type === 'text' && (!dto.text || !dto.text.trim())) {
      throw new BadRequestException('text is required for type "text"');
    }
    if (dto.type === 'product_share' && !dto.productShare?.productId) {
      throw new BadRequestException('productShare.productId is required for type "product_share"');
    }
    if (['image', 'video', 'pdf', 'document', 'voice'].includes(dto.type) && (!dto.attachments || !dto.attachments.length)) {
      throw new BadRequestException('attachments are required for this message type');
    }

    // Attachments must point at OUR Cloudinary account, not any host that happens to match the DTO's shape.
    if (dto.attachments?.length) {
      const cloud = process.env.CLOUDINARY_CLOUD_NAME;
      for (const a of dto.attachments) {
        if (cloud && !a.url.startsWith(`https://res.cloudinary.com/${cloud}/`)) {
          throw new BadRequestException('Attachment must be a file uploaded through the app');
        }
      }
    }

    // A reply quote is rebuilt from the real parent message in THIS conversation; the client only names it.
    let replyToSnapshot: any = null;
    if (dto.replyTo?.messageId) {
      const parent: any = await this.msgModel.findOne({ _id: dto.replyTo.messageId, conversationId }).lean();
      if (!parent) throw new BadRequestException('The message you are replying to was not found in this conversation');
      replyToSnapshot = {
        messageId: parent._id.toString(),
        text: parent.text ? String(parent.text).slice(0, 200) : null,
        type: parent.type,
        senderId: parent.senderId,
        senderRole: parent.senderRole,
      };
    }

    // Auto-fetch product details for product share
    let productShareSnapshot: any = null;
    if (dto.type === 'product_share') {
      // Only a live product can be shared (drafts / removed products used to be shareable by id).
      const product = await this.db.repositories.productModel.findOne({ _id: dto.productShare!.productId, status: 'active', isDelete: false });
      if (!product) throw new NotFoundException('Product not found');

      // Get lowest variant price
      const variants = await this.db.repositories.productVariantModel
        .find({ productId: dto.productShare!.productId, isDelete: false })
        .sort({ price: 1 })
        .limit(1)
        .lean();

      productShareSnapshot = {
        productId: product._id.toString(),
        title: product.name,
        price: variants[0]?.price ?? 0,
        image: product.images?.[0] || null,
        slug: product.slug,
      };
    }

    // Spam scoring
    const score = this.spamScore(dto.text);

    const message = await this.msgModel.create({
      conversationId,
      senderId: userId,
      senderRole,
      type: dto.type,
      text: dto.text?.trim() || null,
      attachments: dto.attachments || [],
      productShare: productShareSnapshot,
      replyTo: replyToSnapshot,
      // The claimed ORIGINAL sender of a forwarded message can't be verified server-side, so it is not stored.
      forwardedFrom: null,
      status: 'sent',
      spamScore: score,
      isFlagged: score >= 3,
    });

    // Update conversation: last message snapshot + unread counter
    const lastMessageSnapshot = {
      messageId: message._id.toString(),
      text: dto.text?.trim() || null,
      type: dto.type,
      senderId: userId,
      senderRole,
      sentAt: new Date(),
    };

    const unreadIncrement = iAmBuyer ? { sellerUnread: 1 } : { buyerUnread: 1 };

    const updatedConv = await this.convModel.findByIdAndUpdate(conversationId, {
      lastMessage: lastMessageSnapshot,
      $inc: unreadIncrement,
      // Restore soft-delete if sender had deleted
      ...(iAmBuyer ? { deletedByBuyer: false } : { deletedBySeller: false }),
      // Restore for the other side too (message reactivates conversation)
      ...(iAmBuyer ? { deletedBySeller: false } : { deletedByBuyer: false }),
    }, { returnDocument: 'after' }).lean();

    this.gateway.emitNewMessage(conversationId, message);
    if (updatedConv) {
      this.gateway.emitConversationUpdate([conv.buyerId, conv.sellerId], updatedConv);
    }

    // Only raise an inbox/push notification if the recipient isn't actively viewing the
    // thread — avoids double-buzzing someone who already sees the message live via socket.
    const recipientId = iAmBuyer ? conv.sellerId : conv.buyerId;
    const recipientRole = iAmBuyer ? 'seller' : 'user';
    if (!this.gateway.isOnline(recipientId)) {
      this.notificationsService.notify({
        recipientId,
        recipientRole,
        type: NOTIFICATION_TYPES.NEW_MESSAGE,
        title: 'New message',
        body: dto.type === 'text' ? dto.text!.trim().slice(0, 120) : 'Sent an attachment',
        data: { conversationId },
      }).catch(() => {});
    }

    return message;
  }

  async getMessages(userId: string, role: string, conversationId: string, query: any) {
    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);

    const limit = Math.min(50, parseInt(query.limit) || 30);
    const filter: any = {
      conversationId,
      deletedByUsers: { $ne: userId }, // exclude messages deleted by this user
    };

    // Cursor-based pagination: load messages older than the cursor
    if (query.before && Types.ObjectId.isValid(query.before)) {
      filter._id = { $lt: new Types.ObjectId(query.before) };
    }

    const messages = await this.msgModel
      .find(filter)
      .sort({ _id: -1 }) // newest first
      .limit(limit + 1)
      .lean();

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();
    const nextCursor = hasMore ? (messages[messages.length - 1] as any)._id.toString() : null;

    // Auto-deliver: mark messages from the other side as delivered if they were only 'sent'
    const otherSideSenderIds = messages
      .filter((m: any) => m.senderId !== userId && m.status === 'sent')
      .map((m: any) => m._id);

    if (otherSideSenderIds.length) {
      await this.msgModel.updateMany(
        { _id: { $in: otherSideSenderIds } },
        { $set: { status: 'delivered' } },
      );
    }

    return { messages: messages.reverse(), nextCursor, hasMore }; // reverse so oldest-first for display
  }

  async editMessage(userId: string, messageId: string, dto: EditMessageDto) {
    const message = await this.getMessageOrThrow(messageId);
    if (message.senderId.toString() !== userId) throw new ForbiddenException('You can only edit your own messages');
    if (message.type !== 'text') throw new BadRequestException('Only text messages can be edited');
    if (message.isDeleted) throw new BadRequestException('Cannot edit a deleted message');

    const EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
    const age = Date.now() - new Date((message as any).createdAt).getTime();
    if (age > EDIT_WINDOW_MS) throw new BadRequestException('Edit window has expired — messages can only be edited within 30 minutes of sending');

    message.text = dto.text.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();
    this.gateway.emitMessageEdited(message.conversationId, message);
    return message;
  }

  async deleteMessageForSelf(userId: string, messageId: string) {
    const message = await this.getMessageOrThrow(messageId);

    // Ensure user is part of the conversation
    const conv = await this.convModel.findById(message.conversationId);
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.buyerId.toString() !== userId && conv.sellerId.toString() !== userId) {
      throw new ForbiddenException('Access denied');
    }

    if (!message.deletedByUsers.includes(userId)) {
      message.deletedByUsers.push(userId);
    }

    // If both sides deleted: mark as fully deleted
    const bothDeleted =
      message.deletedByUsers.includes(conv.buyerId.toString()) &&
      message.deletedByUsers.includes(conv.sellerId.toString());

    if (bothDeleted) {
      message.isDeleted = true;
      message.deletedAt = new Date();
    }

    await message.save();
    this.gateway.emitMessageDeleted(message.conversationId, messageId);
    return { deleted: true };
  }

  async markSeen(userId: string, role: string, conversationId: string, lastMessageId: string) {
    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);

    if (!Types.ObjectId.isValid(lastMessageId)) throw new BadRequestException('Invalid message ID');

    const targetMsg = await this.msgModel.findById(lastMessageId);
    if (!targetMsg || targetMsg.conversationId !== conversationId) {
      throw new BadRequestException('Message does not belong to this conversation');
    }

    const seenAt = new Date();

    // Mark all messages up to lastMessageId (sent by the other side) as seen by this user
    await this.msgModel.updateMany(
      {
        conversationId,
        senderId: { $ne: userId },
        _id: { $lte: new Types.ObjectId(lastMessageId) },
        'seenBy.userId': { $ne: userId },
        status: { $ne: 'seen' },
      },
      {
        $push: { seenBy: { userId, seenAt } },
        $set: { status: 'seen' },
      },
    );

    // Reset unread counter for current user's side (by actual participancy
    // in this conversation, not JWT role — see assertConversationAccess).
    const unreadReset = conv.buyerId.toString() === userId ? { buyerUnread: 0 } : { sellerUnread: 0 };
    const updatedConv = await this.convModel.findByIdAndUpdate(conversationId, { $set: unreadReset }, { returnDocument: 'after' }).lean();

    this.gateway.emitMessagesSeen(conversationId, userId, lastMessageId);
    // Without this, the reader's own inbox list (this tab or any other) never
    // learns the unread badge should clear until a full refetch.
    if (updatedConv) {
      this.gateway.emitConversationUpdate([conv.buyerId, conv.sellerId], updatedConv);
    }
    return { seen: true };
  }

  async searchMessages(userId: string, role: string, conversationId: string, q: string) {
    if (!q || q.trim().length < 2) throw new BadRequestException('Search query must be at least 2 characters');

    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);

    const results = await this.msgModel
      .find({
        conversationId,
        type: 'text',
        isDeleted: false,
        deletedByUsers: { $ne: userId },
        text: { $regex: q.trim(), $options: 'i' },
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  async uploadAttachment(userId: string, role: string, conversationId: string, file: Express.Multer.File) {
    const conv = await this.getConversationOrThrow(conversationId);
    this.assertConversationAccess(conv, userId, role);

    if (!file) throw new BadRequestException('No file provided');

    const result = await this.uploadService.uploadFile(file);
    return {
      url: result.url,
      publicId: result.publicId,
      resourceType: result.resourceType,
      mimeType: file.mimetype,
      fileName: file.originalname,
      fileSize: file.size,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODERATION
  // ═══════════════════════════════════════════════════════════════════════════

  async blockUser(blockerId: string, blockerRole: string, dto: BlockDto) {
    if (blockerId === dto.targetId) throw new BadRequestException('Cannot block yourself');
    const { userModel, sellerModel } = this.db.repositories;
    const targetExists = (await userModel.exists({ _id: dto.targetId })) || (await sellerModel.exists({ _id: dto.targetId }));
    if (!targetExists) throw new NotFoundException('User not found');

    const existing = await this.blkModel.findOne({ blockerId, targetId: dto.targetId });
    if (existing) throw new ConflictException('User is already blocked');

    const block = await this.blkModel.create({
      blockerId,
      blockerRole,
      targetId: dto.targetId,
      targetRole: dto.targetRole,
      reason: dto.reason || null,
    });

    // Mirror block state into any existing conversation. The side is decided by who is the buyer / seller IN that
    // conversation, not by the blocker's account role (one account can be a buyer at one store and a seller at another).
    await this.convModel.updateMany({ buyerId: blockerId, sellerId: dto.targetId }, { $set: { blockedByBuyer: true } });
    await this.convModel.updateMany({ sellerId: blockerId, buyerId: dto.targetId }, { $set: { blockedBySeller: true } });
    return block;
  }

  async unblockUser(blockerId: string, targetId: string) {
    const block = await this.blkModel.findOneAndDelete({ blockerId, targetId });
    if (!block) throw new NotFoundException('Block not found');

    // Unblock in conversation (both possible sides — see blockUser)
    await this.convModel.updateMany({ buyerId: blockerId, sellerId: targetId }, { $set: { blockedByBuyer: false } });
    await this.convModel.updateMany({ sellerId: blockerId, buyerId: targetId }, { $set: { blockedBySeller: false } });

    return { unblocked: true };
  }

  async reportTarget(reporterId: string, reporterRole: string, dto: ReportDto) {
    // The reporter must be able to see what they report (a participant of the conversation / message / a
    // counterpart) — reports used to accept any id, letting users flood admins or brigade a seller.
    if (dto.targetType === 'conversation') {
      const conv = await this.convModel.findById(dto.targetId).lean();
      if (!conv || (conv.buyerId.toString() !== reporterId && conv.sellerId.toString() !== reporterId)) throw new NotFoundException('Nothing to report');
    } else if (dto.targetType === 'message') {
      const msg = await this.msgModel.findById(dto.targetId).lean();
      const conv = msg ? await this.convModel.findById(msg.conversationId).lean() : null;
      if (!conv || (conv.buyerId.toString() !== reporterId && conv.sellerId.toString() !== reporterId)) throw new NotFoundException('Nothing to report');
    } else {
      const shared = await this.convModel.exists({ $or: [{ buyerId: reporterId, sellerId: dto.targetId }, { sellerId: reporterId, buyerId: dto.targetId }] });
      if (!shared) throw new NotFoundException('Nothing to report');
    }
    const duplicate = await this.rptModel.exists({ reporterId, targetType: dto.targetType, targetId: dto.targetId, status: 'pending' });
    if (duplicate) throw new ConflictException('You have already reported this — it is awaiting review');

    const report = await this.rptModel.create({
      reporterId,
      reporterRole,
      targetType: dto.targetType,
      targetId: dto.targetId,
      reason: dto.reason,
      details: dto.details || null,
    });
    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════════════════

  async adminGetConversations(query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 30);
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.storeId) filter.storeId = query.storeId;
    if (query.buyerId) filter.buyerId = query.buyerId;
    if (query.sellerId) filter.sellerId = query.sellerId;
    if (query.isArchived !== undefined) filter.isArchived = query.isArchived === 'true';

    const [conversations, total] = await Promise.all([
      this.convModel.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      this.convModel.countDocuments(filter),
    ]);

    return { conversations, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async adminGetConversation(conversationId: string) {
    const conv = await this.getConversationOrThrow(conversationId);
    const [buyer, store, messages] = await Promise.all([
      this.db.repositories.userModel.findById(conv.buyerId).select('name profileImage email').lean(),
      this.db.repositories.storeModel.findById(conv.storeId).select('name logo slug badges').lean(),
      this.msgModel.find({ conversationId }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    return { ...conv.toObject(), buyer, store, recentMessages: messages.reverse() };
  }

  async adminGetReports(query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 30);
    const skip = (page - 1) * limit;
    const filter: any = {};
    if (query.status) filter.status = query.status;
    if (query.targetType) filter.targetType = query.targetType;

    const [reports, total] = await Promise.all([
      this.rptModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.rptModel.countDocuments(filter),
    ]);
    return { reports, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
