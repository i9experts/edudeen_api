/* eslint-disable prettier/prettier */
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
    private readonly jwtService: JwtService,
    private readonly databaseService: DatabaseService,
  ) {}

  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token || client.handshake.query?.token) as string;
      if (!token) throw new Error('Missing token');

      const payload = this.jwtService.verify(token, { secret: process.env.JWT_SECRET });
      const userId = payload.sub;
      (client.data).userId = userId;
      (client.data).joinedConversations = new Set<string>();

      client.join(`user:${userId}`);

      const count = (this.onlineCounts.get(userId) || 0) + 1;
      this.onlineCounts.set(userId, count);
      if (count === 1) {
        this.server.emit(`presence:${userId}`, { userId, online: true });
      }
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data)?.userId;
    if (!userId) return;

    const count = Math.max(0, (this.onlineCounts.get(userId) || 1) - 1);
    if (count === 0) {
      this.onlineCounts.delete(userId);
      this.server.emit(`presence:${userId}`, { userId, online: false, lastSeen: new Date() });
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
    if (!userId || !conversationId) return;

    const conv = await this.databaseService.repositories.conversationModel.findById(conversationId).lean();
    if (!conv || (conv.buyerId !== userId && conv.sellerId !== userId)) {
      client.emit('messaging:error', 'Not authorized for this conversation');
      return;
    }

    client.join(`conversation:${conversationId}`);
    (client.data).joinedConversations.add(conversationId);

    const otherUserId = conv.buyerId === userId ? conv.sellerId : conv.buyerId;
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
    if (!userId || !body?.conversationId) return;
    client.to(`conversation:${body.conversationId}`).emit('typing', {
      conversationId: body.conversationId,
      userId,
      isTyping: !!body.isTyping,
    });
  }

  @SubscribeMessage('presence:check')
  handlePresenceCheck(@ConnectedSocket() client: Socket, @MessageBody() userIds: string[]) {
    if (!Array.isArray(userIds)) return;
    const statuses = userIds.map((id) => ({ userId: id, online: this.isOnline(id) }));
    client.emit('presence:status', statuses);
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
