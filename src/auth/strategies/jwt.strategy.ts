/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'), 
    });
  }

async validate(payload: any) {
  // Refresh tokens and order-download tokens are signed with the same secret
  // but must never authenticate an API request. Legacy access tokens carry
  // no `typ`, so only an explicit non-access type is refused.
  if (payload?.typ && payload.typ !== 'access') {
    throw new UnauthorizedException('Invalid token type');
  }
  if (!payload?.sub) throw new UnauthorizedException('Invalid token');
  return {
    userId: payload.sub,
    email: payload.email,
    role: payload.role || null,
    // Carried through so JwtAuthGuard can compare it against the account's
    // current DB value and reject a token issued before a suspend/deactivate.
    tokenVersion: payload.tokenVersion ?? 0,
  };
}
}
