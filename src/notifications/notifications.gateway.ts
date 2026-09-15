/* eslint-disable prettier/prettier */
import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

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

  constructor(private readonly jwtService: JwtService) {}

  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token || client.handshake.query?.token) as string;
      if (!token) throw new Error('Missing token');

      const payload = this.jwtService.verify(token, { secret: process.env.JWT_SECRET });
      const userId = payload.sub;
      (client.data).userId = userId;
      client.join(`user:${userId}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  emitNewNotification(userId: string, notification: unknown) {
    this.server?.to(`user:${userId}`).emit('notification:new', notification);
  }

  emitUnreadCount(userId: string, unreadCount: number) {
    this.server?.to(`user:${userId}`).emit('notification:unread-count', { unreadCount });
  }
}
