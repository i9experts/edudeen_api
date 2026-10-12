import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminReauthService } from './admin-reauth.service';

/**
 * Applied after JwtAuthGuard/RolesGuard. Only enforces when the request carries
 * `X-Inline-Edit: 1` (the on-site editor), so normal admin pages are unaffected.
 * Then a valid `X-Admin-Reauth` token for the same admin is mandatory.
 */
@Injectable()
export class AdminReauthGuard implements CanActivate {
  constructor(private readonly reauth: AdminReauthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (String(req.headers['x-inline-edit'] ?? '') !== '1') return true;
    const ok = await this.reauth.isValid(req.user?.userId, req.headers['x-admin-reauth']);
    if (!ok) throw new ForbiddenException({ statusCode: 403, code: 'REAUTH_REQUIRED', message: 'Password confirmation required' });
    return true;
  }
}