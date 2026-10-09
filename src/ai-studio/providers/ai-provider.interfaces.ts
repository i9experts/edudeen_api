/**
 * AI Studio provider abstraction layer.
 *
 * Business logic (ai-studio.service.ts) talks ONLY to these interfaces —
 * never to a vendor SDK directly. Concrete implementations today:
 *
 *   TextGenerationAdapter → ClaudeTextGenerationProvider (Anthropic Messages API)
 *                           MockTextGenerationProvider   (canned, no API key)
 *   KeywordDataAdapter    → KeywordDataService (Claude + web search; every signal
 *                           flagged isVerifiedData:false — swap in a dedicated
 *                           keyword-metrics API later without breaking callers)
 *   PricingDataAdapter    → PricingDataService (OWN listings DB is the primary
 *                           source; Claude+web search only for a side note)
 *   ImageEnhanceAdapter   → StubImageEnhanceProvider (no-op; real provider TBD)
 *
 * Selection mirrors payment-gateway.service.ts: env var picks the provider,
 * call sites never change.
 */

// ---------- Text generation ----------

/** 'standard' = high-volume/cost-sensitive writing; 'advanced' = reliable structured JSON / web-search grounding. */
export type TextModelTier = 'standard' | 'advanced';

export interface TextGenerationRequest {
  prompt: string;
  system?: string;
  tier?: TextModelTier;
  /**
   * JSON schema the response must conform to. With schema + no webSearch the
   * provider may use native structured output; with webSearch it must fall
   * back to prompt-level JSON instructions (search citations are incompatible
   * with structured outputs on the Claude API) and parse defensively.
   */
  schema?: Record<string, any>;
  /** Enable provider-native web search so output is grounded in live data. */
  webSearch?: { maxUses?: number };
  maxTokens?: number;
}

export interface TextGenerationResult {
  /** Parsed object when a schema was requested; null for free-text calls. */
  json: Record<string, any> | null;
  text: string;
  provider: string;
  model: string;
  usedWebSearch: boolean;
  /** Token usage reported by the provider (absent for the mock). */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface TextGenerationAdapter {
  readonly name: string;
  generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
}

/** Normalized provider failure — `retryable` drives refund + HTTP mapping upstream. */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly provider: string;
  constructor(message: string, opts: { retryable: boolean; provider: string }) {
    super(message);
    this.name = 'AiProviderError';
    this.retryable = opts.retryable;
    this.provider = opts.provider;
  }
}

// ---------- Keyword data (SEO Booster) ----------

export interface KeywordSignal {
  keyword: string;
  searchIntent?: string;
  competition?: 'low' | 'medium' | 'high';
  rationale?: string;
  /**
   * false for the current web-search-grounded LLM implementation — honest
   * confidence labeling for sellers. A future dedicated keyword-metrics API
   * (real volume/competition numbers) sets this true, drop-in.
   */
  isVerifiedData: boolean;
}

export interface KeywordLookupResult {
  keywords: KeywordSignal[];
  provider: string;
  /** true when no usable signals could be gathered (new niche, provider down). */
  lowConfidence: boolean;
}

export interface KeywordDataAdapter {
  lookupKeywords(params: {
    topic: string;
    categoryName?: string;
    currentTags?: string[];
    maxKeywords?: number;
  }): Promise<KeywordLookupResult>;
}

// ---------- Pricing data (Price Optimizer) ----------

export interface ComparablePricingStats {
  sampleSize: number;
  minPrice: number | null;
  maxPrice: number | null;
  medianPrice: number | null;
  p25Price: number | null;
  p75Price: number | null;
  /** true when there aren't enough comparable listings to trust the numbers. */
  lowConfidence: boolean;
}

export interface PricingDataAdapter {
  /** PRIMARY: statistical range from comparable active listings on our own platform. */
  getComparableStats(params: {
    categoryId: string;
    productType?: string;
    excludeProductId?: string;
  }): Promise<ComparablePricingStats>;

  /**
   * SECONDARY: rough external web signal, surfaced separately and clearly
   * labeled — never blended into the primary suggested price. Null when
   * unavailable (mock provider, lookup failure, feature disabled).
   */
  getExternalMarketNote(params: {
    productName: string;
    categoryName?: string;
  }): Promise<string | null>;
}

// ---------- Image enhancement (STUB for this pass) ----------

export type ImageEnhancementType = 'upscale' | 'denoise' | 'background_cleanup';

export interface ImageEnhanceRequest {
  imageUrl: string;
  enhancementType: ImageEnhancementType;
}

export interface ImageEnhanceResult {
  enhancedImageUrl: string;
  originalImageUrl: string;
  provider: string;
  note?: string;
}

export interface ImageEnhanceAdapter {
  readonly name: string;
  enhance(request: ImageEnhanceRequest): Promise<ImageEnhanceResult>;
}
