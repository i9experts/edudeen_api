/* eslint-disable prettier/prettier */
import { isValidObjectId } from 'mongoose';
import { WsAuthService } from 'src/common/ws-auth.service';
import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from 'src/database/databaseservice';

const WHITELIST = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'https://staging.edudeen.com',
  'https://edudeen.com',
  'https://www.edudeen.com',
  'https://api.edudeen.com',
];

/**
 * Powers realtime messaging: instant unread badges, conversation reordering,
 * read receipts, typing indicators, and online presence. Clients join their
 * personal `user:{userId}` room on connect (for inbox-level events) and a
 * `conversation:{id}` room per open thread (for message-level events).
 * MessagingService calls the emit* methods after each successful write —
 * no polling needed on the frontend.
 */
@WebSocketGateway({
  namespace: '/messaging',
  cors: { origin: WHITELIST, credentials: true },
})
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MessagingGateway.name);

  // In-memory online presence: userId -> number of live sockets
  private readonly onlineCounts = new Map<string, number>();

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly databaseService: DatabaseService,
  ) {}

  async handleConnection(client: Socket) {
    const identity = await this.wsAuth.authenticate(client);
    if (!identity) {
      client.disconnect();
      return;
    }
    const userId = identity.userId;
    client.data.userId = userId;
    client.data.role = identity.role;
    client.data.joinedConversations = new Set<string>();

    await client.join(`user:${userId}`);

    const count = (this.onlineCounts.get(userId) || 0) + 1;
    this.onlineCounts.set(userId, count);
    if (count === 1) {
      // Presence goes only to sockets that are WATCHING this user (their conversation counterparts) — it used to
      // be a namespace-wide broadcast, i.e. every connected account learned every other account's id + status.
      this.server.to(`watch:${userId}`).emit(`presence:${userId}`, { userId, online: true });
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data)?.userId;
    if (!userId) return;

    const count = Math.max(0, (this.onlineCounts.get(userId) || 1) - 1);
    if (count === 0) {
      this.onlineCounts.delete(userId);
      this.server.to(`watch:${userId}`).emit(`presence:${userId}`, { userId, online: false, lastSeen: new Date() });
    } else {
      this.onlineCounts.set(userId, count);
    }

    const joined: Set<string> = (client.data)?.joinedConversations || new Set();
    joined.forEach((conversationId) => {
      client.to(`conversation:${conversationId}`).emit('typing', { conversationId, userId, isTyping: false });
    });

    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  isOnline(userId: string) {
    return this.onlineCounts.has(userId);
  }

  @SubscribeMessage('join-conversation')
  async handleJoinConversation(@ConnectedSocket() client: Socket, @MessageBody() conversationId: string) {
    const userId = (client.data).userId;
    if (!userId || typeof conversationId !== 'string' || !isValidObjectId(conversationId)) return;

    const conv = await this.databaseService.repositories.conversationModel.findById(conversationId).lean();
    if (!conv || (conv.buyerId !== userId && conv.sellerId !== userId)) {
      client.emit('messaging:error', 'Not authorized for this conversation');
      return;
    }

    client.join(`conversation:${conversationId}`);
    (client.data).joinedConversations.add(conversationId);

    const otherUserId = conv.buyerId === userId ? conv.sellerId : conv.buyerId;
    await client.join(`watch:${otherUserId}`); // this conversation's counterpart's presence changes reach this socket
    client.emit('messaging:joined', { conversationId, otherUserId, otherOnline: this.isOnline(otherUserId) });
  }

  @SubscribeMessage('leave-conversation')
  handleLeaveConversation(@ConnectedSocket() client: Socket, @MessageBody() conversationId: string) {
    client.leave(`conversation:${conversationId}`);
    (client.data)?.joinedConversations?.delete(conversationId);
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string; isTyping: boolean },
  ) {
    const userId = (client.data).userId;
    // Only into a conversation this socket actually joined (join-conversation verified participation);
    // any socket used to be able to emit typing into any conversation room.
    if (!userId || typeof body?.conversationId !== 'string' || !(client.data.joinedConversations as Set<string>)?.has(body.conversationId)) return;
    client.to(`conversation:${body.conversationId}`).emit('typing', {
      conversationId: body.conversationId,
      userId,
      isTyping: !!body.isTyping,
    });
  }

  @SubscribeMessage('presence:check')
  async handlePresenceCheck(@ConnectedSocket() client: Socket, @MessageBody() userIds: string[]) {
    const me = (client.data).userId;
    if (!me || !Array.isArray(userIds)) return;
    // Bounded, and limited to people this user actually has a conversation with — it used to answer for ANY
    // user id (account enumeration + online/last-seen for everyone), with an unbounded array.
    const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string').slice(0, 50))];
    if (ids.length === 0) return;
    const convs = await this.databaseService.repositories.conversationModel
      .find({ $or: [{ buyerId: me, sellerId: { $in: ids } }, { sellerId: me, buyerId: { $in: ids } }] })
      .select('buyerId sellerId')
      .lean();
    const allowed = new Set<string>();
    for (const c of convs) allowed.add(c.buyerId === me ? c.sellerId : c.buyerId);
    for (const id of allowed) await client.join(`watch:${id}`);
    client.emit('presence:status', [...allowed].map((id) => ({ userId: id, online: this.isOnline(id) })));
  }

  // ── Called by MessagingService after DB writes ────────────────────────────

  emitNewMessage(conversationId: string, message: unknown) {
    this.server?.to(`conversation:${conversationId}`).emit('message:new', message);
  }

  emitMessageEdited(conversationId: string, message: unknown) {
    this.server?.to(`conversation:${conversationId}`).emit('message:edited', message);
  }

  emitMessageDeleted(conversationId: string, messageId: string) {
    this.server?.to(`conversation:${conversationId}`).emit('message:deleted', { messageId });
  }

  emitMessagesSeen(conversationId: string, userId: string, lastMessageId: string) {
    this.server?.to(`conversation:${conversationId}`).emit('message:seen', { conversationId, userId, lastMessageId });
  }

  /** Pushed to each participant's personal room — drives inbox reordering + unread badge without opening the thread. */
  emitConversationUpdate(participantIds: string[], conversation: unknown) {
    participantIds.forEach((id) => this.server?.to(`user:${id}`).emit('conversation:update', conversation));
  }
}
