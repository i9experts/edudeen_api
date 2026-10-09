/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProviderError, TextGenerationAdapter, TextGenerationRequest, TextGenerationResult,
} from './ai-provider.interfaces';
import { ClaudeTextGenerationProvider } from './claude-text.provider';
import { MockTextGenerationProvider } from './mock-text.provider';

/**
 * TextGenerationService — delegates to the active provider selected via env,
 * mirroring PaymentGatewayService's provider-selection pattern.
 *
 * AI_PROVIDER=mock    → MockTextGenerationProvider (default — no API key, no spend)
 * AI_PROVIDER=claude  → ClaudeTextGenerationProvider (requires ANTHROPIC_API_KEY)
 *
 * Model IDs come from env so upgrades never require a code change:
 *   AI_TEXT_MODEL_STANDARD  (default: claude-haiku-4-5)   — Listing Writer, Email
 *                            Campaigns, SEO Booster writing step
 *   AI_TEXT_MODEL_ADVANCED  (default: claude-sonnet-5)    — Worksheet Builder
 *                            structured JSON + all web-search-grounded calls
 */
class UnavailableTextProvider implements TextGenerationAdapter {
  readonly name = 'unavailable';
  async generate(): Promise<TextGenerationResult> {
    throw new AiProviderError('AI is not available right now (not configured).', { retryable: true, provider: 'unavailable' });
  }
}

@Injectable()
export class TextGenerationService implements TextGenerationAdapter, OnModuleInit {
  private readonly logger = new Logger(TextGenerationService.name);
  private readonly provider: TextGenerationAdapter;
  readonly providerName: 'mock' | 'claude';

  constructor(config: ConfigService) {
    // AI_PROVIDER wins; when unset, a configured ANTHROPIC_API_KEY turns the real provider on (no key -> mock).
    this.providerName = (config.get<string>('AI_PROVIDER') as 'mock' | 'claude')
      ?? (config.get<string>('ANTHROPIC_API_KEY') ? 'claude' : 'mock');

    if (this.providerName === 'claude') {
      const apiKey = config.get<string>('ANTHROPIC_API_KEY');
      if (!apiKey) {
        // Never crash the app over a missing key: AI tools answer with a clear 'unavailable' error instead.
        this.provider = new UnavailableTextProvider();
      } else this.provider = new ClaudeTextGenerationProvider(apiKey, {
        standardModel: config.get<string>('ANTHROPIC_MODEL_FAST') ?? config.get<string>('AI_TEXT_MODEL_STANDARD') ?? 'claude-haiku-4-5',
        advancedModel: config.get<string>('ANTHROPIC_MODEL') ?? config.get<string>('AI_TEXT_MODEL_ADVANCED') ?? 'claude-sonnet-5',
      });
    } else {
      // Mock only for local dev / explicit AI_PROVIDER=mock; production without a key gets 'unavailable', not fake text.
      this.provider = config.get<string>('AI_PROVIDER') === 'mock' || config.get<string>('NODE_ENV') !== 'production'
        ? new MockTextGenerationProvider()
        : new UnavailableTextProvider();
    }
  }

  /** False when no AI provider is configured (production without ANTHROPIC_API_KEY). */
  get available(): boolean {
    return this.provider.name !== 'unavailable';
  }

  get name(): string {
    return this.provider.name;
  }

  onModuleInit() {
    this.logger.log(`AI Studio text generation running on provider: "${this.providerName}"`);
    if (this.providerName === 'mock') {
      this.logger.warn('AI_PROVIDER=mock — canned responses only. Set AI_PROVIDER=claude with ANTHROPIC_API_KEY for real generations.');
    }
  }

  generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    return this.provider.generate(request);
  }
}
