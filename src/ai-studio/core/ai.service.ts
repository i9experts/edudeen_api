/* eslint-disable prettier/prettier */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import { DatabaseService } from 'src/database/databaseservice';
import { AiStudioCreditsService } from '../ai-studio-credits.service';
import { AiProviderError } from '../providers/ai-provider.interfaces';
import { AiFeatureKey } from './ai-features';
import { AiFlagsService } from './ai-flags.service';
import { loadGuidelines } from './guidelines';
import { stripPiiDeep } from './pii.util';
import { SlidingWindowLimiter } from './rate-limiter';

export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_RATE_LIMITED = 'AI_RATE_LIMITED';

export interface AiMessage { role: 'user' | 'assistant'; content: string | any[] }
export interface AiToolDef { name: string; description: string; input_schema: Record<string, any> }
export interface AiToolCall { id: string; name: string; input: Record<string, any> }
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }

export interface AiGenerateRequest {
  feature: AiFeatureKey;
  /** Feature-specific instructions. The shared Edudeen guidelines are always prepended and prompt-cached. */
  system: string;
  messages: AiMessage[];
  /** Tools the model may call (assistant / ask-data). */
  tools?: AiToolDef[];
  /** JSON schema -> structured output (implemented as a forced tool call, works on every model). */
  schema?: Record<string, any>;
  maxTokens?: number;
  /** 'fast' = ANTHROPIC_MODEL_FAST (cheap, high volume); 'standard' = ANTHROPIC_MODEL. */
  tier?: 'fast' | 'standard';
  storeId?: string | null;
  sellerId?: string | null;
  userId?: string | null;
  adminId?: string | null;
  /** Strip emails/phones/CNIC from the text sent to the model (default true). */
  stripPii?: boolean;
  /** Skip the ai_generations call log (only when the caller writes its own row). */
  skipLog?: boolean;
  timeoutMs?: number;
}

export interface AiGenerateResult {
  text: string;
  /** Parsed object when `schema` was given. */
  json: Record<string, any> | null;
  toolCalls: AiToolCall[];
  stopReason: string | null;
  content: any[];
  usage: AiUsage;
  costUsd: number;
  model: string;
  latencyMs: number;
}

/** USD per million tokens [input, output]. Estimates for the admin cost view; override with AI_PRICE_IN_PER_MTOK / AI_PRICE_OUT_PER_MTOK. */
export function pricePerMTok(model: string, env: Record<string, string | undefined> = process.env): [number, number] {
  const i = Number(env.AI_PRICE_IN_PER_MTOK); const o = Number(env.AI_PRICE_OUT_PER_MTOK);
  if (Number.isFinite(i) && Number.isFinite(o) && i > 0 && o > 0) return [i, o];
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return [1, 5];
  if (m.includes('opus')) return [15, 75];
  return [3, 15];
}

export function estimateCostUsd(model: string, u: AiUsage): number {
  const [pin, pout] = pricePerMTok(model);
  const cost = (u.inputTokens * pin + u.cacheCreateTokens * pin * 1.25 + u.cacheReadTokens * pin * 0.1 + u.outputTokens * pout) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

let currentAiService: AiService | null = null;
/** For modules that cannot import AiStudioModule without a circular dependency (e.g. manual-payments receipt reading). */
export function getAiService(): AiService | null { return currentAiService; }

const RETRY_STATUS =new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * One gateway for every Claude call in the app (new features). Responsibilities:
 * availability (no key -> clean 503 AI_UNAVAILABLE), kill switches, per-store/user rate limits, PII stripping,
 * shared cached system prompt, structured output via forced tool, timeout + retry with backoff,
 * token usage -> cost, and one ai_generations row per call (the admin AI oversight page reads these).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic | null = null;
  private readonly limiter: SlidingWindowLimiter;
  readonly modelStandard: string;
  readonly modelFast: string;
  /** Test hook: replace the sleep used between retries. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    config: ConfigService,
    private readonly db: DatabaseService,
    private readonly flags: AiFlagsService,
    private readonly credits?: AiStudioCreditsService,
  ) {
    this.modelStandard = config.get<string>('ANTHROPIC_MODEL') || config.get<string>('AI_TEXT_MODEL_ADVANCED') || 'claude-sonnet-5';
    this.modelFast = config.get<string>('ANTHROPIC_MODEL_FAST') || config.get<string>('AI_TEXT_MODEL_STANDARD') || 'claude-haiku-4-5';
    const perMin = Number(config.get<string>('AI_RATE_LIMIT_PER_MIN'));
    this.limiter = new SlidingWindowLimiter(Number.isFinite(perMin) && perMin > 0 ? perMin : 20, 60_000);
    this.apiKey = config.get<string>('ANTHROPIC_API_KEY') || '';
    currentAiService = this;
    const prov = (config.get<string>('AI_PROVIDER') || '').toLowerCase();
    this.providerMock = prov === 'mock';
  }

  private readonly apiKey: string;
  private readonly providerMock: boolean;

  /** True when a real key is configured (and AI_PROVIDER is not forced to mock). */
  isAvailable(): boolean { return !!this.apiKey && !this.providerMock || !!this.client; }

  /** Admin kill-switch state (global + per store). */
  isFeatureOn(feature: AiFeatureKey, storeId?: string | null): Promise<boolean> { return this.flags.isEnabled(feature, storeId); }

  /** Test hook. */
  setClientForTesting(client: any) { this.client = client; }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    if (!this.apiKey || this.providerMock) {
      throw new HttpException({ success: false, errorCode: AI_UNAVAILABLE, message: 'AI is not available right now. Please try again later.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    // We do our own retry/backoff, so the SDK must not retry on top.
    this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 0 });
    return this.client;
  }

  async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
    const client = this.getClient();
    await this.flags.assertEnabled(req.feature, req.storeId);

    const principal = req.storeId || req.userId || req.adminId || 'anon';
    if (!this.limiter.tryConsume(`${req.feature}:${principal}`) || !this.limiter.tryConsume(`all:${principal}`)) {
      throw new HttpException({ success: false, errorCode: AI_RATE_LIMITED, message: 'Too many AI requests. Please wait a minute and try again.' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const model = req.tier === 'fast' ? this.modelFast : this.modelStandard;
    const strip = req.stripPii !== false;
    const messages = strip ? stripPiiDeep(req.messages) : req.messages;
    const system = [
      { type: 'text', text: loadGuidelines(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: req.system },
    ];

    const tools: any[] = [...(req.tools ?? [])];
    let toolChoice: any;
    const STRUCT = 'emit_result';
    if (req.schema) {
      tools.push({ name: STRUCT, description: 'Return the final structured answer. Always call this exactly once.', input_schema: req.schema });
      toolChoice = tools.length === 1 ? { type: 'tool', name: STRUCT } : { type: 'any' };
    }
    const params: any = { model, max_tokens: req.maxTokens ?? 1500, system, messages };
    if (tools.length) params.tools = tools;
    if (toolChoice) params.tool_choice = toolChoice;

    const started = Date.now();
    let res: any;
    try {
      res = await this.callWithRetry(client, params, req.timeoutMs ?? 45_000);
    } catch (err) {
      const e = this.mapError(err);
      await this.log(req, model, null, Date.now() - started, e.message);
      throw new HttpException({
        success: false, errorCode: AI_UNAVAILABLE,
        message: 'The AI service could not complete this request. Please try again.',
        data: { retryable: e.retryable },
      }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const latencyMs = Date.now() - started;

    const usage: AiUsage = {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
      cacheCreateTokens: res.usage?.cache_creation_input_tokens ?? 0,
    };
    const content: any[] = res.content ?? [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const allCalls: AiToolCall[] = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    const structured = req.schema ? allCalls.find((c) => c.name === STRUCT) : undefined;
    const toolCalls = allCalls.filter((c) => c.name !== STRUCT);
    let json: Record<string, any> | null = structured ? structured.input : null;
    if (req.schema && !json && !toolCalls.length) json = AiService.extractJson(text);

    const result: AiGenerateResult = {
      text, json, toolCalls, stopReason: res.stop_reason ?? null, content, usage,
      costUsd: estimateCostUsd(model, usage), model, latencyMs,
    };

    if (res.stop_reason === 'refusal') {
      await this.log(req, model, result, latencyMs, 'refusal');
      throw new AiProviderError('The AI provider declined to generate this content.', { retryable: false, provider: 'claude' });
    }
    if (req.schema && !json && !toolCalls.length) {
      await this.log(req, model, result, latencyMs, 'unparseable output');
      throw new AiProviderError('The AI returned an unreadable answer.', { retryable: true, provider: 'claude' });
    }
    await this.log(req, model, result, latencyMs, null);
    return result;
  }

  /**
   * Multi-turn tool loop. `executeTool` runs YOUR code for each model tool call; the model never touches the DB.
   * Returns the final text plus every tool result (so callers can show/verify what the model used).
   */
  async runToolLoop(
    req: Omit<AiGenerateRequest, 'schema'> & { tools: AiToolDef[] },
    executeTool: (name: string, input: Record<string, any>) => Promise<unknown>,
    maxTurns = 5,
  ): Promise<{ text: string; toolResults: Array<{ name: string; input: any; output: unknown }>; usage: AiUsage; costUsd: number }> {
    const messages: AiMessage[] = [...req.messages];
    const toolResults: Array<{ name: string; input: any; output: unknown }> = [];
    const total: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    let cost = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      const r = await this.generate({ ...req, messages });
      total.inputTokens += r.usage.inputTokens; total.outputTokens += r.usage.outputTokens;
      total.cacheReadTokens += r.usage.cacheReadTokens; total.cacheCreateTokens += r.usage.cacheCreateTokens;
      cost += r.costUsd;
      if (!r.toolCalls.length) return { text: r.text, toolResults, usage: total, costUsd: cost };
      messages.push({ role: 'assistant', content: r.content });
      const results: any[] = [];
      for (const call of r.toolCalls) {
        let output: unknown; let isError = false;
        try { output = await executeTool(call.name, call.input); } catch (e: any) { output = { error: e?.message ?? 'tool failed' }; isError = true; }
        toolResults.push({ name: call.name, input: call.input, output });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output).slice(0, 20_000), ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: 'I could not finish that request. Please try rephrasing.', toolResults, usage: total, costUsd: cost };
  }

  /**
   * Credit-metered wrapper for store-scoped features: hold the feature's flat credit cost, run, capture on success,
   * refund on any failure. (Token usage is recorded on the call log; the credit price stays flat and predictable.)
   */
  async withCredits<T>(feature: AiFeatureKey, storeId: string, sellerId: string, fn: () => Promise<T>): Promise<T> {
    this.getClient(); // fail fast (no hold) when AI is unavailable
    await this.flags.assertEnabled(feature, storeId);
    if (!this.credits) return fn();
    const txn = await this.credits.hold(storeId, sellerId, feature, new Types.ObjectId().toString());
    try {
      const out = await fn();
      await this.credits.capture(txn);
      return out;
    } catch (err) {
      await this.credits.refund(txn, `${feature} failed: ${(err as Error)?.message ?? 'error'}`).catch(() => undefined);
      throw err;
    }
  }

  // ------------------------------------------------------------ internals

  private async callWithRetry(client: Anthropic, params: any, timeoutMs: number, maxRetries = 2): Promise<any> {
    let attempt = 0;
    for (;;) {
      try {
        return await client.messages.create(params, { timeout: timeoutMs });
      } catch (err: any) {
        const status: number | undefined = err?.status;
        const retryable = (status !== undefined && RETRY_STATUS.has(status)) || (status === undefined && !!err);
        if (!retryable || attempt >= maxRetries) throw err;
        attempt++;
        await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200));
      }
    }
  }

  private mapError(err: any): AiProviderError {
    const status: number | undefined = err?.status;
    return new AiProviderError(`AI provider error${status ? ` (${status})` : ''}: ${err?.message ?? 'unknown'}`.slice(0, 300), {
      retryable: status === undefined || RETRY_STATUS.has(status), provider: 'claude',
    });
  }

  private async log(req: AiGenerateRequest, model: string, r: AiGenerateResult | null, latencyMs: number, error: string | null) {
    if (req.skipLog) return;
    try {
      await this.db.repositories.aiGenerationModel.create({
        scope: req.storeId ? 'seller' : 'platform',
        sellerId: req.sellerId ?? null, storeId: req.storeId ?? null, adminId: req.adminId ?? null, userId: req.userId ?? null,
        toolType: req.feature, status: error ? 'failed' : 'succeeded',
        inputPayload: { feature: req.feature, tier: req.tier ?? 'standard' },
        outputPayload: r ? { preview: r.text.slice(0, 300), toolCalls: r.toolCalls.map((c) => c.name) } : null,
        errorMessage: error, providerUsed: 'claude', modelUsed: model, creditsCharged: 0,
        sessionId: new Types.ObjectId().toString(), isCallLog: true,
        tokensIn: r?.usage.inputTokens ?? 0, tokensOut: r?.usage.outputTokens ?? 0, cacheReadTokens: r?.usage.cacheReadTokens ?? 0,
        costUsd: r?.costUsd ?? 0, latencyMs,
      });
    } catch (e) {
      this.logger.warn(`AI call log failed: ${(e as Error).message}`);
    }
  }

  static extractJson(text: string): Record<string, any> | null {
    const t = (text || '').trim();
    for (const c of [t, t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')]) {
      try { const v = JSON.parse(c); if (v && typeof v === 'object') return v; } catch { /* next */ }
    }
    const s = t.indexOf('{'); const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* none */ } }
    return null;
  }
}
