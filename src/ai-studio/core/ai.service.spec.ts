/* eslint-disable prettier/prettier */
import { HttpException } from '@nestjs/common';
import { AiService, estimateCostUsd, pricePerMTok } from './ai.service';
import { AiFlagsService } from './ai-flags.service';
import { isFeatureEnabled } from './ai-features';
import { stripPii, stripPiiDeep } from './pii.util';
import { SlidingWindowLimiter } from './rate-limiter';
import { loadGuidelines } from './guidelines';

const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as any;

function makeService(env: Record<string, string> = { ANTHROPIC_API_KEY: 'test-key' }, flagState: Record<string, any> = {}) {
  const created: any[] = [];
  const db: any = { repositories: {
    aiGenerationModel: { create: jest.fn(async (row: any) => { created.push(row); return row; }) },
    platformConfigModel: { findOne: () => ({ select: () => ({ lean: async () => ({ aiConfig: flagState }) }) }) },
  } };
  const flags = new AiFlagsService(db);
  const credits: any = { hold: jest.fn(async () => 'txn1'), capture: jest.fn(async () => undefined), refund: jest.fn(async () => undefined), costOf: () => 2 };
  const svc = new AiService(cfg(env), db, flags, credits);
  svc.sleep = async () => undefined;
  return { svc, created, credits, db };
}

const okResponse = (content: any[], usage: any = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 }) => ({ content, usage, stop_reason: 'end_turn' });

describe('AiService', () => {
  it('is unavailable without a key and throws a clean 503 (never crashes on construct)', async () => {
    const { svc } = makeService({});
    expect(svc.isAvailable()).toBe(false);
    await expect(svc.generate({ feature: 'listing_writer', system: 's', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ status: 503 });
  });

  it('returns structured output from the forced tool, sends cached guidelines + stripped PII, and logs usage/cost', async () => {
    const { svc, created } = makeService();
    const create = jest.fn(async () => okResponse([{ type: 'tool_use', id: 't1', name: 'emit_result', input: { a: 1 } }]));
    svc.setClientForTesting({ messages: { create } });
    const r = await svc.generate({
      feature: 'smart_search', tier: 'fast', storeId: 'st1', system: 'do it', schema: { type: 'object', properties: { a: { type: 'number' } } },
      messages: [{ role: 'user', content: 'mail me at ali@example.com or 0300-1234567' }],
    });
    expect(r.json).toEqual({ a: 1 });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 80 });
    expect(r.costUsd).toBeGreaterThan(0);

    const params: any = (create.mock.calls[0] as any[])[0];
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.system[0].text).toContain('Edudeen');
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'emit_result' });
    expect(JSON.stringify(params.messages)).not.toContain('ali@example.com');
    expect(JSON.stringify(params.messages)).not.toContain('1234567');
    expect(params.model).toBe('claude-haiku-4-5'); // fast tier default

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolType: 'smart_search', status: 'succeeded', isCallLog: true, tokensIn: 100, tokensOut: 50, storeId: 'st1', scope: 'seller' });
    expect(created[0].costUsd).toBe(r.costUsd);
  });

  it('honours ANTHROPIC_MODEL / ANTHROPIC_MODEL_FAST', async () => {
    const { svc } = makeService({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'big-1', ANTHROPIC_MODEL_FAST: 'small-1' });
    const create = jest.fn(async () => okResponse([{ type: 'text', text: 'hello' }]));
    svc.setClientForTesting({ messages: { create } });
    await svc.generate({ feature: 'help_bot', system: 's', messages: [{ role: 'user', content: 'x' }] });
    await svc.generate({ feature: 'help_bot', tier: 'fast', system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect((create.mock.calls[0] as any[])[0].model).toBe('big-1');
    expect((create.mock.calls[1] as any[])[0].model).toBe('small-1');
  });

  it('retries 429/5xx with backoff then succeeds; gives up on 400', async () => {
    const { svc } = makeService();
    const create = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))
      .mockResolvedValueOnce(okResponse([{ type: 'text', text: 'ok' }]));
    svc.setClientForTesting({ messages: { create } });
    const r = await svc.generate({ feature: 'help_bot', system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBe('ok');
    expect(create).toHaveBeenCalledTimes(3);

    const bad = jest.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    svc.setClientForTesting({ messages: { create: bad } });
    await expect(svc.generate({ feature: 'help_bot', system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(HttpException);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('logs a failed call with the error message', async () => {
    const { svc, created } = makeService();
    svc.setClientForTesting({ messages: { create: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 400 })) } });
    await expect(svc.generate({ feature: 'help_bot', system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeDefined();
    expect(created[0]).toMatchObject({ status: 'failed', toolType: 'help_bot' });
  });

  it('respects the kill switch (global and per store) with 403', async () => {
    const off = makeService(undefined, { featureFlags: { help_bot: false }, storeOverrides: { s9: ['smart_search'] } });
    off.svc.setClientForTesting({ messages: { create: jest.fn() } });
    await expect(off.svc.generate({ feature: 'help_bot', system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 403 });
    await expect(off.svc.generate({ feature: 'smart_search', storeId: 's9', system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 403 });
  });

  it('rate limits per principal (429)', async () => {
    const { svc } = makeService({ ANTHROPIC_API_KEY: 'k', AI_RATE_LIMIT_PER_MIN: '2' });
    svc.setClientForTesting({ messages: { create: jest.fn(async () => okResponse([{ type: 'text', text: 'ok' }])) } });
    const call = () => svc.generate({ feature: 'help_bot', userId: 'u1', system: 's', messages: [{ role: 'user', content: 'x' }] });
    await call(); await call();
    await expect(call()).rejects.toMatchObject({ status: 429 });
  });

  it('runToolLoop executes ONLY the supplied tool executor and feeds results back', async () => {
    const { svc } = makeService();
    const create = jest.fn()
      .mockResolvedValueOnce(okResponse([{ type: 'tool_use', id: 'c1', name: 'search_products', input: { keywords: ['urdu'] } }]))
      .mockResolvedValueOnce(okResponse([{ type: 'text', text: 'Found one.' }]));
    svc.setClientForTesting({ messages: { create } });
    const exec = jest.fn(async () => ({ count: 1 }));
    const out = await svc.runToolLoop({ feature: 'shopping_assistant', system: 's', messages: [{ role: 'user', content: 'urdu book' }], tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object' } }] }, exec);
    expect(out.text).toBe('Found one.');
    expect(exec).toHaveBeenCalledWith('search_products', { keywords: ['urdu'] });
    const second: any = (create.mock.calls[1] as any[])[0];
    expect(second.messages[second.messages.length - 1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
  });

  it('withCredits holds, captures on success and refunds on failure', async () => {
    const { svc, credits } = makeService();
    svc.setClientForTesting({ messages: { create: jest.fn() } });
    await expect(svc.withCredits('translate_listing', 'st', 'sl', async () => 7)).resolves.toBe(7);
    expect(credits.hold).toHaveBeenCalledWith('st', 'sl', 'translate_listing', expect.any(String));
    expect(credits.capture).toHaveBeenCalledWith('txn1');
    await expect(svc.withCredits('translate_listing', 'st', 'sl', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(credits.refund).toHaveBeenCalled();
  });

  it('withCredits fails fast (no hold) when AI is unavailable', async () => {
    const { svc, credits } = makeService({});
    await expect(svc.withCredits('translate_listing', 'st', 'sl', async () => 1)).rejects.toMatchObject({ status: 503 });
    expect(credits.hold).not.toHaveBeenCalled();
  });
});

describe('ai helpers', () => {
  it('cost estimate uses model family + cache discounts', () => {
    expect(pricePerMTok('claude-haiku-4-5', {})).toEqual([1, 5]);
    expect(pricePerMTok('claude-sonnet-5', {})).toEqual([3, 15]);
    expect(estimateCostUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })).toBe(1);
    expect(estimateCostUsd('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 })).toBeCloseTo(0.1);
  });
  it('feature flags: missing = on, false = off, store overrides and __all', () => {
    expect(isFeatureEnabled('help_bot', {}, {}, 's')).toBe(true);
    expect(isFeatureEnabled('help_bot', { help_bot: false }, {}, 's')).toBe(false);
    expect(isFeatureEnabled('help_bot', {}, { s: ['help_bot'] }, 's')).toBe(false);
    expect(isFeatureEnabled('help_bot', {}, { s: ['help_bot'] }, 'other')).toBe(true);
    expect(isFeatureEnabled('smart_search', { __all: false }, {}, null)).toBe(false);
    expect(isFeatureEnabled('smart_search', {}, { s: ['__all'] }, 's')).toBe(false);
  });
  it('strips PII but keeps prices and grades', () => {
    const s = stripPii('Email a.b@x.com, call +92 300 1234567 or 03001234567, CNIC 35202-1234567-1. Class 5 costs Rs 1500 in 2025.');
    expect(s).not.toMatch(/a\.b@x\.com|1234567/);
    expect(s).toContain('Class 5 costs Rs 1500 in 2025');
    expect(stripPiiDeep({ a: ['x@y.io'], b: { c: 'ok' }, n: 5 })).toEqual({ a: ['[email]'], b: { c: 'ok' }, n: 5 });
    const img = { type: 'image', source: { data: 'a@b.co' } };
    expect(stripPiiDeep(img)).toBe(img);
  });
  it('sliding window limiter', () => {
    let t = 0; const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect(l.tryConsume('k')).toBe(true); expect(l.tryConsume('k')).toBe(true); expect(l.tryConsume('k')).toBe(false);
    t = 1500; expect(l.tryConsume('k')).toBe(true); expect(l.tryConsume('other')).toBe(true);
  });
  it('guidelines load and mention key rules', () => {
    const g = loadGuidelines();
    expect(g).toMatch(/hadith/i);
    expect(g).toMatch(/Urdu/);
  });
});
