import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NewsletterService } from './newsletter.service';
import { SubscribeNewsletterDto } from './dto/subscribe-newsletter.dto';

// Public — no auth guard. Anyone (logged in or not) can subscribe from the footer.
@ApiTags('Newsletter (public)')
@Controller('api/newsletter')
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('subscribe')
  subscribe(@Body() dto: SubscribeNewsletterDto) {
    return this.newsletterService.subscribe(dto.email, dto.source ?? 'footer');
  }

  @Get('unsubscribe/:token')
  @Header('Content-Type', 'text/html')
  unsubscribe(@Param('token') token: string) {
    return this.newsletterService.unsubscribeByToken(token);
  }
}
