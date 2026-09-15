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
 * Powers the "Live" toggle on the Activity Log screen. A client connects,
 * authenticates with its JWT, then joins a room for the one store it wants
 * to watch. ActivityLogService pushes into that room after every successful
 * write — no polling needed on the frontend.
 */
@WebSocketGateway({
  namespace: '/activity-log',
  cors: { origin: WHITELIST, credentials: true },
})
export class ActivityLogGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ActivityLogGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly databaseService: DatabaseService,
  ) {}

  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token || client.handshake.query?.token) as string;
      if (!token) throw new Error('Missing token');

      const payload = this.jwtService.verify(token, { secret: process.env.JWT_SECRET });
      (client.data).userId = payload.sub;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-store')
  async handleJoinStore(@ConnectedSocket() client: Socket, @MessageBody() storeId: string) {
    const sellerId = (client.data).userId;
    if (!sellerId || !storeId) {
      client.emit('activity:error', 'storeId required');
      return;
    }

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });

    if (!store) {
      client.emit('activity:error', 'Not authorized for this store');
      return;
    }

    client.join(`store:${storeId}`);
    client.emit('activity:joined', storeId);
  }

  @SubscribeMessage('leave-store')
  handleLeaveStore(@ConnectedSocket() client: Socket, @MessageBody() storeId: string) {
    client.leave(`store:${storeId}`);
  }

  /** Called by ActivityLogService right after a log entry is persisted. */
  emitNewActivity(storeId: string, entry: unknown) {
    this.server?.to(`store:${storeId}`).emit('activity:new', entry);
  }
}
