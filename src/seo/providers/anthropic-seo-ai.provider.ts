/* eslint-disable prettier/prettier */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ISeoAiProvider, SeoAiSuggestion, SeoAiSuggestionInput } from './seo-ai-provider.interface';

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    metaTitle: { type: 'string' },
    metaDescription: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['metaTitle', 'metaDescription', 'keywords'],
  additionalProperties: false,
};

/**
 * Claude-backed AI SEO suggestion generator — the first implementation of
 * `ISeoAiProvider`. Uses structured outputs (`output_config.format`) rather
 * than free-text parsing, so a malformed response is a hard API error
 * (caught below) instead of a silent bad-JSON parse downstream.
 *
 * Model is fixed to `claude-opus-4-8` — this is a short, low-volume,
 * cost-insensitive task (one call per seller-initiated suggestion), so there
 * is no reason to trade quality for a cheaper tier.
 */
@Injectable()
export class AnthropicSeoAiProvider implements ISeoAiProvider {
  private readonly logger = new Logger(AnthropicSeoAiProvider.name);
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  async generateSuggestion(input: SeoAiSuggestionInput): Promise<SeoAiSuggestion> {
    const prompt = buildPrompt(input);

    const response = await this.client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') {
      throw new ServiceUnavailableException('AI SEO suggestion request was declined by the safety classifier.');
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) {
      this.logger.error(`No text block in AI SEO suggestion response for entity "${input.name}"`);
      throw new ServiceUnavailableException('AI SEO suggestion generation returned no usable output.');
    }

    try {
      const parsed = JSON.parse(textBlock.text);
      return {
        metaTitle: String(parsed.metaTitle).slice(0, 70),
        metaDescription: String(parsed.metaDescription).slice(0, 320),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 15).map(String) : [],
      };
    } catch (err: any) {
      this.logger.error(`Failed to parse AI SEO suggestion JSON: ${err?.message}`);
      throw new ServiceUnavailableException('AI SEO suggestion generation returned malformed output.');
    }
  }
}

function buildPrompt(input: SeoAiSuggestionInput): string {
  const context = [
    `Entity type: ${input.entityType}`,
    `Name: ${input.name}`,
    input.description ? `Description: ${input.description}` : null,
    input.categoryName ? `Category: ${input.categoryName}` : null,
    input.storeName ? `Store: ${input.storeName}` : null,
    input.facts ? `Facts: ${input.facts}` : null,
  ].filter(Boolean).join('\n');

  const langLine = input.language === 'ur'
    ? 'Write metaTitle and metaDescription in clear, natural Urdu (Urdu script). Keep keywords in Urdu and English.\n'
    : 'Write in clear, simple English.\n';
  const tone = input.entityType === 'product'
    ? 'This is an education marketplace for parents, teachers and students: use a helpful, trustworthy education tone, mention the class/level and subject when known, and never invent facts, prices or claims.\n'
    : '';

  return `You are an SEO copywriter for an education marketplace. ${langLine}${tone}Given the following ${input.entityType} details, write:
- metaTitle: a compelling, keyword-rich page title, 50-60 characters
- metaDescription: an enticing meta description, 140-160 characters, that encourages clicks
- keywords: 5-10 relevant search keywords/phrases

${context}

Respond with only the requested fields — no extra commentary.`;
}
