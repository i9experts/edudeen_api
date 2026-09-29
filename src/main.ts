/* eslint-disable prettier/prettier */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  // rawBody: Stripe webhook signature verification (payment + subscriptions
  // webhook controllers) needs the exact unparsed request bytes on
  // `req.rawBody` — without it every webhook is rejected with a 400.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(cookieParser());

  // Global DTO validation. Before this, only the ~27 controllers that opted
  // in with a local @UsePipes ran their class-validator rules — every other
  // DTO (auth, cart, messaging, categories, ...) was decoration only.
  // `transform: true` matches the local pipes already used across the app,
  // so query DTOs relying on @Type(() => Number) behave identically.
  // No `whitelist` here on purpose: stripping unknown props globally could
  // silently drop fields that `body: any` handlers still rely on.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

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
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept','Origin'],
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
