import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

const MAX_DEPTH = 12;
const MAX_NODES = 50_000;

/** True when any object key (at any depth) starts with `$` — i.e. a MongoDB operator such as `$ne` / `$gt` / `$where`. */
export function hasOperatorKey(value: unknown): boolean {
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v !== 'object') return false;
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return true; // absurdly deep / wide: treat as hostile, never walk it all
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith('$')) return true;
      if (walk(child, depth + 1)) return true;
    }
    return false;
  };
  return walk(value, 0);
}

/**
 * NoSQL operator-injection guard for the whole API. Many handlers take an untyped body (`@Body() body: any`) or a
 * single field (`@Body('email') email: string`) and put it into a Mongo filter; a JSON body like
 * `{"email":{"$ne":null}}` then becomes a query operator. No legitimate client sends `$`-prefixed keys, so any
 * request whose body or query contains one is rejected before it reaches a handler.
 */
@Injectable()
export class NoOperatorKeysInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context
        .switchToHttp()
        .getRequest<{ body?: unknown; query?: unknown }>();
      if (hasOperatorKey(req.body) || hasOperatorKey(req.query)) {
        throw new BadRequestException('Request contains invalid field names');
      }
    }
    return next.handle();
  }
}
