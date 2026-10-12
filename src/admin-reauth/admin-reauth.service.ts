import { Injectable, ServiceUnavailableException, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { ActivityLogService } from '../activity-log/activity-log.service';

export const REAUTH_TTL_SECONDS = 300;
export const REAUTH_MAX_FAILURES = 5;
export const REAUTH_LOCK_SECONDS = 600;

const tokenKey = (token: string) => `admin-reauth:token:${createHash('sha256').update(token).digest('hex')}`;
const failKey = (adminId: string) => `admin-reauth:fail:${adminId}`;

/**
 * Step-up authentication for inline site editing. The admin re-enters their
 * password; on success a short-lived random token (bound to that admin, held
 * only in Redis) is issued. Protected writes must present it (AdminReauthGuard).
 */
@Injectable()
export class AdminReauthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async verifyPassword(adminId: string, password: string, meta: { ip?: string; userAgent?: string } = {}) {
    // Fail closed: without Redis we can neither rate-limit nor store the token.
    if (!this.redis.isConnected) throw new ServiceUnavailableException('Confirmation is temporarily unavailable');

    const failures = Number((await this.redis.get(failKey(adminId))) ?? 0);
    if (failures >= REAUTH_MAX_FAILURES) {
      throw new HttpException('Too many wrong attempts. Try again in 10 minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const admin: any = await this.databaseService.repositories.adminModel
      .findOne({ _id: adminId, isDelete: false })
      .select('password name email status')
      .lean();
    const ok = !!admin?.password && admin.status !== 'suspended' && (await bcrypt.compare(password, admin.password));

    if (!ok) {
      const count = await this.redis.incrWithTtl(failKey(adminId), REAUTH_LOCK_SECONDS);
      await this.activityLog.log({
        category: 'security',
        action: 'admin_reauth_failed',
        description: 'Wrong password on inline-edit confirmation',
        actorId: adminId,
        actorName: admin?.name ?? null,
        actorRole: 'admin',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        isSecurityAlert: count >= REAUTH_MAX_FAILURES,
        metadata: { attempt: count },
      });
      throw new UnauthorizedException('Wrong password');
    }

    await this.redis.del(failKey(adminId));
    const reauthToken = randomBytes(32).toString('hex');
    await this.redis.set(tokenKey(reauthToken), adminId, REAUTH_TTL_SECONDS);
    return { success: true, data: { reauthToken, expiresInSeconds: REAUTH_TTL_SECONDS } };
  }

  /** True only if the token exists, is unexpired and was issued to this admin. */
  async isValid(adminId: string | undefined, token: string | undefined): Promise<boolean> {
    if (!adminId || !token || typeof token !== 'string' || token.length > 200) return false;
    const owner = await this.redis.get(tokenKey(token));
    return !!owner && owner === adminId;
  }
}