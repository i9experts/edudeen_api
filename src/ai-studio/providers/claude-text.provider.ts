/* eslint-disable prettier/prettier */
import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import {
  AiProviderError, TextGenerationAdapter, TextGenerationRequest, TextGenerationResult,
} from './ai-provider.interfaces';

export interface ClaudeModelConfig {
  /** High-volume writing: Listing Writer, Email Campaigns, SEO writing step. */
  standardModel: string; // default claude-haiku-4-5
  /** Structured JSON + web-search grounding: Worksheet Builder, keyword/pricing lookups. */
  advancedModel: string; // default claude-sonnet-5
}

/**
 * TextGenerationAdapter backed by the Anthropic Messages API.
 *
 * - schema + no webSearch → native structured outputs (`output_config.format`
 *   with a json_schema) so the response is guaranteed parseable.
 * - webSearch → the built-in `web_search_20260209` server tool. Search results
 *   carry citations, which are incompatible with structured outputs on the
 *   API, so those calls use prompt-level JSON instructions + defensive
 *   parsing instead. Web-search calls always run on the advanced model
 *   (the newest search tool variant requires it).
 */
export class ClaudeTextGenerationProvider implements TextGenerationAdapter {
  readonly name = 'claude';
  private readonly logger = new Logger(ClaudeTextGenerationProvider.name);
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly models: ClaudeModelConfig) {
    // The SDK defaults (10 min timeout, 2 retries) let one hung call hold a seller's
    // credits for many minutes and multiply provider cost on retries.
    this.client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    const useWebSearch = !!request.webSearch;
    const model = useWebSearch || request.tier === 'advanced'
      ? this.models.advancedModel
      : this.models.standardModel;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.system,
      messages: [{ role: 'user', content: this.buildUserPrompt(request, useWebSearch) }],
    };

    if (useWebSearch) {
      params.tools = [{
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: request.webSearch?.maxUses ?? 3,
      } as any];
    } else if (request.schema) {
      (params as any).output_config = {
        format: { type: 'json_schema', schema: request.schema },
      };
    }

    let response: Anthropic.Message;
    try {
      response = await this.callWithPauseTurnResume(params);
    } catch (error) {
      throw this.mapError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new AiProviderError('The AI provider declined to generate this content.', { retryable: false, provider: this.name });
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AiProviderError('Generation exceeded the output limit — try a smaller request.', { retryable: true, provider: this.name });
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let json: Record<string, any> | null = null;
    if (request.schema) {
      json = this.extractJson(text);
      if (!json) {
        throw new AiProviderError('Provider returned output that could not be parsed as JSON.', { retryable: true, provider: this.name });
      }
    }

    const u: any = (response as any).usage ?? {};
    return {
      json, text, provider: this.name, model, usedWebSearch: useWebSearch,
      usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0 },
    };
  }

  /** Server-side tool loops can pause at their iteration limit — resume by re-sending. */
  private async callWithPauseTurnResume(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    let response = await this.client.messages.create(params);
    let resumes = 0;
    while (response.stop_reason === 'pause_turn' && resumes < 3) {
      response = await this.client.messages.create({
        ...params,
        messages: [...params.messages, { role: 'assistant', content: response.content }],
      });
      resumes++;
    }
    return response;
  }

  private buildUserPrompt(request: TextGenerationRequest, useWebSearch: boolean): string {
    if (!request.schema || !useWebSearch) return request.prompt;
    // Web-search path: schema enforcement via prompt (see class doc).
    return [
      request.prompt,
      '',
      'Respond with ONLY a single JSON object (no markdown fences, no prose before or after) matching this JSON schema:',
      JSON.stringify(request.schema),
    ].join('\n');
  }

  /** Tolerant JSON extraction — handles stray prose/fences around the object. */
  private extractJson(text: string): Record<string, any> | null {
    const trimmed = text.trim();
    for (const candidate of [trimmed, trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')]) {
      try { return JSON.parse(candidate); } catch { /* fall through */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }

  private mapError(error: any): AiProviderError {
    if (error instanceof Anthropic.RateLimitError) {
      return new AiProviderError('AI provider rate limit hit — try again shortly.', { retryable: true, provider: this.name });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new AiProviderError('Could not reach the AI provider.', { retryable: true, provider: this.name });
    }
    if (error instanceof Anthropic.APIError) {
      const status = (error as any).status as number | undefined;
      const retryable = !!status && (status >= 500 || status === 429);
      this.logger.error(`Claude API error (${status}): ${error.message}`);
      return new AiProviderError(`AI provider error${status ? ` (${status})` : ''}.`, { retryable, provider: this.name });
    }
    this.logger.error(`Unexpected AI provider failure: ${error?.message ?? error}`);
    return new AiProviderError('Unexpected AI provider failure.', { retryable: true, provider: this.name });
  }
}
