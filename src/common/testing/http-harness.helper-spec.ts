/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- test helper */
/**
 * Test-only helper (not a spec itself; excluded from the build by the
 * `*spec.ts` pattern): boots ONE controller over real HTTP with mocked
 * providers, so a spec can assert real status codes (pipes, guards, DTO
 * validation) without a database. The JWT guard is replaced by a stub that
 * reads the caller from `x-test-user: <userId>:<role>`; the real RolesGuard
 * runs unchanged.
 */
import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, Type, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { GLOBAL_VALIDATION_OPTIONS } from '../validation.config';

class StubJwtGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const raw = String(req.headers['x-test-user'] ?? '');
    if (!raw) throw new UnauthorizedException('Token missing');
    const [userId, role] = raw.split(':');
    req.user = { userId, _id: userId, id: userId, role };
    return true;
  }
}

export async function bootController(
  controller: Type<unknown>,
  providers: { provide: any; useValue: any }[],
  extraGuards: Type<unknown>[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ controllers: [controller], providers })
    .overrideGuard(JwtAuthGuard)
    .useValue(new StubJwtGuard());
  for (const g of extraGuards) builder = builder.overrideGuard(g).useValue({ canActivate: () => true });
  const mod = await builder.compile();
  const app = mod.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_OPTIONS));
  await app.init();
  return app;
}

export const OID = '0123456789abcdef01234567';
