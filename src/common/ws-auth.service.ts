import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { DatabaseService } from 'src/database/databaseservice';
import { RedisService } from 'src/redis/redis.service';

export interface WsIdentity {
  userId: string;
  role: string;
}

/**
 * The single place a WebSocket handshake is authenticated. It applies the SAME rules as the HTTP
 * JwtAuthGuard + JwtStrategy; the three gateways used to only check the signature, so:
 *  - refresh tokens (7 days) and order-download tokens (same secret) could open sockets,
 *  - suspending / deleting / logging out an account (tokenVersion bump, Redis session removal) did nothing
 *    to its ability to receive messages, notifications and store activity.
 */
@Injectable()
export class WsAuthService {
  private readonly logger = new Logger(WsAuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Handshake token: `auth.token` (what the mobile app sends) or an Authorization header. A `?token=` query
   *  value ends up in proxy/load-balancer access logs, so it is refused unless WS_ALLOW_QUERY_TOKEN=true. */
  extractToken(client: Socket): string | null {
    const fromAuth = client.handshake.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth) return fromAuth;
    const header = client.handshake.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    const fromQuery = client.handshake.query?.token;
    if (typeof fromQuery === 'string' && fromQuery) {
      if (process.env.WS_ALLOW_QUERY_TOKEN === 'true') return fromQuery;
      this.logger.warn('Rejected a socket handshake that sent its token in the query string (send it in `auth.token`)');
    }
    return null;
  }

  /** Returns the authenticated identity, or null if the handshake must be refused. */
  async authenticate(client: Socket): Promise<WsIdentity | null> {
    try {
      const token = this.extractToken(client);
      if (!token) return null;

      const payload = this.jwtService.verify(token, { secret: process.env.JWT_SECRET });
      // Refresh / download tokens share the secret but must never authenticate a session.
      if (payload?.typ && payload.typ !== 'access') return null;
      if (!payload?.sub || typeof payload.sub !== 'string') return null;

      // Same session rule as JwtAuthGuard: when Redis is up, the access token must still be a live session.
      if (this.redis.isConnected) {
        const session = await this.redis.get(token);
        if (!session) return null;
      }

      const model = this.modelForRole(payload.role);
      if (!model) return null;
      const account = await model.findById(payload.sub).select('tokenVersion status isDelete').lean();
      if (!account) return null;
      if (account.isDelete || ['deleted', 'suspended'].includes(account.status)) return null;
      if ((account.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)) return null;

      return { userId: payload.sub, role: payload.role };
    } catch {
      return null;
    }
  }

  // Widened to any for the same reason as JwtAuthGuard.modelForRole: User/Seller/Admin are different models.
  private modelForRole(role: unknown): any {
    const repos = this.db.repositories;
    if (role === 'user') return repos.userModel;
    if (role === 'seller') return repos.sellerModel;
    if (role === 'admin') return repos.adminModel;
    return null;
  }
}
