/* eslint-disable prettier/prettier */
import { WsAuthService } from 'src/common/ws-auth.service';
import { Logger, Optional } from '@nestjs/common';
import { PRIVATE_TOPICS, RealtimeService } from 'src/realtime/realtime.service';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

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
 * Realtime delivery for the notification inbox — badge counts and new-item
 * pushes while the app is foregrounded. Mirrors MessagingGateway's shape:
 * clients join a personal `user:{userId}` room on connect; NotificationsService
 * calls the emit* methods after each persisted write. Background/killed-app
 * delivery goes through FCM (FirebaseAdminService) instead, not this socket.
 */
@WebSocketGateway({
  namespace: '/notifications',
  cors: { origin: WHITELIST, credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  async handleConnection(client: Socket) {
    const identity = await this.wsAuth.authenticate(client);
    if (!identity) {
      client.disconnect();
      return;
    }
    client.data.userId = identity.userId;
    client.data.role = identity.role;
    await client.join(`user:${identity.userId}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  emitNewNotification(userId: string, notification: unknown) {
    this.server?.to(`user:${userId}`).emit('notification:new', notification);
    // Almost every cross-party event (order placed/shipped, payout sent, return asked, review left...) creates a
    // notification, so this one person's open screens re-read their own lists too - no refresh, and no broadcast.
    this.realtime?.emitTo({ users: [userId], admin: false }, PRIVATE_TOPICS);
  }

  emitUnreadCount(userId: string, unreadCount: number) {
    this.server?.to(`user:${userId}`).emit('notification:unread-count', { unreadCount });
  }
}
