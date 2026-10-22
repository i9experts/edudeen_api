import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminReauthService } from './admin-reauth.service';

export const REQUIRE_REAUTH_KEY = 'adminReauthStrict';
/**
 * Marks a money-sensitive route: an ADMIN (owner or staff) must always send a valid `X-Admin-Reauth` token,
 * with or without the inline-edit header. Non-admin callers (e.g. a seller on a shared route) are not asked.
 */
export const RequireReauth = () => SetMetadata(REQUIRE_REAUTH_KEY, true);

/**
 * Applied after JwtAuthGuard/RolesGuard. Default mode only enforces when the request carries
 * `X-Inline-Edit: 1` (the on-site editor), so normal admin pages are unaffected.
 * Routes marked `@RequireReauth()` enforce it for every admin request.
 * Then a valid `X-Admin-Reauth` token for the same admin is mandatory.
 */
@Injectable()
export class AdminReauthGuard implements CanActivate {
  constructor(private readonly reauth: AdminReauthService, @Optional() private readonly reflector?: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const strict = !!this.reflector?.getAllAndOverride<boolean>(REQUIRE_REAUTH_KEY, [context.getHandler(), context.getClass()]);
    if (strict) {
      if (req.user?.role !== 'admin') return true;
    } else if (String(req.headers['x-inline-edit'] ?? '') !== '1') return true;
    const ok = await this.reauth.isValid(req.user?.userId, req.headers['x-admin-reauth']);
    if (!ok) throw new ForbiddenException({ statusCode: 403, code: 'REAUTH_REQUIRED', message: 'Password confirmation required' });
    return true;
  }
}