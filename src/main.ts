/* eslint-disable prettier/prettier */
import { AdminConfigService } from './admin-config/admin-config.service';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from './common/validation.config';

async function bootstrap() {
  // rawBody: Stripe webhook signature verification (payment + subscriptions
  // webhook controllers) needs the exact unparsed request bytes on
  // `req.rawBody` — without it every webhook is rejected with a 400.
  // In production only errors/warnings are logged — the per-route
  // "Mapped {...} route" startup lines (700+) otherwise blow through
  // Railway's 500 logs/sec limit and real messages get dropped.
  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: isProduction ? ['error', 'warn'] : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Behind a reverse proxy (Railway, Cloudflare, a load balancer) `req.ip` is the PROXY's address unless Express is
  // told how many proxy hops to trust. That makes the per-IP rate limiter share one bucket across every user and
  // records the proxy IP in audit logs. Opt-in via TRUST_PROXY (a hop count such as `1`, or `true`/`false`) so a
  // deployment sets it deliberately: trusting too many hops lets a client spoof X-Forwarded-For.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy !== undefined && trustProxy !== '') {
    const value: boolean | number = trustProxy === 'true' ? true : trustProxy === 'false' ? false : Number(trustProxy);
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 0)) {
      throw new Error('TRUST_PROXY must be "true", "false" or a non-negative integer hop count');
    }
    app.getHttpAdapter().getInstance().set('trust proxy', value);
  }

  app.use(cookieParser());

  // Maintenance mode: block only the area an admin marked as down (see admin-config/maintenance.util.ts).
  const adminConfig = app.get(AdminConfigService);
  app.use(async (req: any, res: any, next: any) => {
    try {
      const block = await adminConfig.maintenanceBlockFor(req.method, req.path, req.headers.authorization);
      if (block) {
        if (block.endsAt) res.setHeader('Retry-After', String(Math.max(60, Math.ceil((new Date(block.endsAt).getTime() - Date.now()) / 1000))));
        return res.status(503).json(block);
      }
    } catch { /* a config read failure must never take the site down */ }
    next();
  });

  // Global DTO validation. `transform: true` matches the local pipes already used across the app, so query DTOs
  // relying on @Type(() => Number) behave identically. `whitelist: true` strips any property a DTO does not declare:
  // most controllers have no local whitelist pipe, so `{ ...dto }` / `$set: dto` / `Object.assign(doc, dto)` in the
  // services let a client write fields it was never meant to (ownership ids, status, flags). Parameters typed `any`
  // (no DTO class) are not touched by the pipe and must pick their fields explicitly. See validation.config.ts.
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_OPTIONS));

  const config = new DocumentBuilder()
    .setTitle('Edudeen API')
    .setDescription('Edudeen Marketplace API')
    .addBearerAuth(
      {
        in: 'Header',
        scheme: 'Bearer',
        name: 'Authorization',
        type: 'http',
        bearerFormat: 'JWT',
      },
      'accessToken',
    )
    .build();

  const whitelist = [
    ...(process.env.NODE_ENV !== 'production'
      ? ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000']
      : []),
    'https://edudeen.com',
    'https://www.edudeen.com',
    'https://api.edudeen.com',
  ];

  // Every seller store is served from its OWN subdomain
  // (`<slug>.edudeen.com`) or, in dev, `<slug>.localhost:<port>` — there's
  // no way to enumerate those individually in a static whitelist, so any
  // origin under either base domain is allowed regardless of subdomain.
  // (A seller's own connected Custom Domain is a separate, still-open gap —
  // an arbitrary domain can't be pattern-matched here; it would need an
  // async DB lookup against verified custom domains, not implemented yet.)
  const isAllowedOrigin = (origin: string): boolean => {
    if (whitelist.includes(origin)) return true;
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (hostname === 'edudeen.com' || hostname.endsWith('.edudeen.com')) return true;
    // Local dev origins are never trusted with credentials in production.
    if (process.env.NODE_ENV !== 'production') {
      return hostname === 'localhost' || hostname.endsWith('.localhost');
    }
    return false;
  };

  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isAllowedOrigin(origin)) return cb(null, true);
      console.log('Blocked Origin:', origin);
      return cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin','Idempotency-Key','X-Request-Id'],
    exposedHeaders: ['Content-Length','X-Request-Id'],
  });

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // Railway injects PORT env var — use it, fall back to 3002 for local dev
  const port = process.env.PORT || 3002;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://localhost:${port}`);
}
bootstrap();
