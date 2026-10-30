import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsAuthService } from 'src/common/ws-auth.service';
import { DatabaseService } from 'src/database/databaseservice';
import { RealtimeService, adminRoom, storeRoom, userRoom } from './realtime.service';

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
 * "Something changed" channel (topic names only, never data). Everyone, guests included, hears PUBLIC topics
 * (prices, banners, config...). A signed-in client additionally joins its own rooms - `user:<id>`, `store:<id>`
 * for each store it owns, and `admin` for admin/staff - which is where private topics (orders, finance...) go.
 * Clients are not able to send anything.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      if (!origin) return cb(null, true);
      if (WHITELIST.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        // Seller stores live on <slug>.edudeen.com.
        if (host === 'edudeen.com' || host.endsWith('.edudeen.com')) return cb(null, true);
      } catch {
        /* fall through */
      }
      cb(null, false);
    },
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly wsAuth: WsAuthService,
    private readonly db: DatabaseService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  async handleConnection(client: Socket) {
    // A guest (no token / bad token) simply stays in the public channel.
    try {
      if (!this.wsAuth.extractToken(client)) return;
      const identity = await this.wsAuth.authenticate(client);
      if (!identity) return;
      await client.join(userRoom(identity.userId));
      if (identity.role === 'admin') await client.join(adminRoom);
      if (identity.role === 'seller') {
        const { storeModel } = this.db.repositories as any;
        const stores: Array<{ _id: unknown }> = await storeModel.find({ sellerId: identity.userId }).select('_id').limit(50).lean();
        for (const s of stores) await client.join(storeRoom(String(s._id)));
      }
    } catch (err) {
      this.logger.debug(`Realtime room join skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
