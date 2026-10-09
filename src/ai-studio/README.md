# AI Studio (seller-only)

Six seller-facing AI tools behind `api/ai-studio/:storeId/*` — Listing Writer,
SEO Booster, Email Campaigns, Worksheet Builder, Price Optimizer, and an
Image Enhancer **stub**. Buyers get a 403 on every route
(`JwtAuthGuard + RolesGuard + @Roles('seller')` plus per-request store-ownership
checks).

## Endpoints

| Route | Notes |
|---|---|
| `GET  :storeId/credits` | balance, monthly allowance, per-tool costs, this month's usage, last 50 transactions |
| `GET  :storeId/generations` | history; filters: `toolType`, `sessionId`, `page`, `limit` |
| `GET  :storeId/generations/:id` | single generation |
| `POST :storeId/generations/:id/accept` | "Use This"; `{applyToProduct: true, productId?}` writes listing/SEO output onto the product |
| `POST :storeId/listing-writer/generate` | `{productType, keywords, tone}` → `{title, description, suggestedTags}` |
| `POST :storeId/seo-booster/generate` | `{productId \| title, description?, currentTags?}` → `{optimizedTitle, optimizedTags[{tag,isVerifiedData}], rankingNotes, lowConfidence}` |
| `POST :storeId/email-campaigns/generate` | `{campaignGoal, productIds?, tone}` → `{subject, previewText, body}` |
| `POST :storeId/worksheet-builder/generate` | `{subject, gradeLevel, topics, questionCount, includeAnswerKey}` → structured `{title, sections[]}` JSON (a separate non-AI renderer makes the file) |
| `POST :storeId/price-optimizer/generate` | `{productId \| categoryId, attributes?}` → `{suggestedPrice/Min/Max, comparableListingsSampleSize, explanation, externalMarketNote?, lowConfidence}` |
| `POST :storeId/image-enhancer/generate` | `{imageUrl, enhancementType}` → `{jobId}` immediately (async) |
| `GET  :storeId/image-enhancer/jobs/:jobId` | poll → `{status, enhancedImageUrl, originalImageUrl}` |

Every `generate` route accepts an optional `regenerateFromId` (creates a NEW
history row in the same `sessionId` — never overwrites) and the optional
`Idempotency-Key` header (same interceptor as other charge-bearing mutations).

## Credits

The balance lives in the **existing** `AiCreditsWallet`
(`platform-plans/ai-credits.service.ts`) — monthly allowance comes from the
platform plan's `aiCreditsPerMonth`, the monthly reset cron already exists, and
**"Buy Credits" is the existing add-on purchase**
(`POST api/platform-plans/:storeId/addons`, `addonType: 'extra_ai_credits'`,
500 credits/unit) — no new payment flow was built.

This module adds charge-on-success semantics (`ai-studio-credits.service.ts`):
credits are **held** when a generation starts, **captured** only if the
provider call succeeds, and **auto-refunded** on any provider failure/timeout.
`AiCreditTransaction` rows are the per-generation audit trail.

Frontend-mappable error codes:

- `402 INSUFFICIENT_AI_CREDITS` → show the "Buy Credits" prompt (`data.required`, `data.balance`)
- `503 AI_PROVIDER_UNAVAILABLE` → retryable, credits were refunded
- `422 AI_GENERATION_REJECTED` → not retryable as-is (e.g. provider refusal), credits refunded

Per-tool costs (env-overridable): `AI_CREDIT_COST_LISTING_WRITER=5`,
`AI_CREDIT_COST_SEO_BOOSTER=5`, `AI_CREDIT_COST_EMAIL_CAMPAIGNS=5`,
`AI_CREDIT_COST_WORKSHEET_BUILDER=10`, `AI_CREDIT_COST_PRICE_OPTIMIZER=10`,
`AI_CREDIT_COST_IMAGE_ENHANCER=15`.

## Provider configuration — where to plug in real keys

Provider selection mirrors `PAYMENT_PROVIDER` (env-selected, no call-site
changes). Everything defaults to **mock/stub** so the module runs end-to-end
with no API keys.

```bash
# --- TextGenerationAdapter (providers/text-generation.service.ts) ---
AI_PROVIDER=claude                        # default: mock (canned responses, no spend)
ANTHROPIC_API_KEY=sk-ant-...              # required when AI_PROVIDER=claude
AI_TEXT_MODEL_STANDARD=claude-haiku-4-5   # Listing Writer, Email Campaigns, SEO writing step
AI_TEXT_MODEL_ADVANCED=claude-sonnet-5    # Worksheet Builder structured JSON + all web-search calls

# --- KeywordDataAdapter (providers/keyword-data.service.ts) ---
# Currently Claude + built-in web search via the text provider above — every
# signal is flagged isVerifiedData:false. To upgrade to a dedicated
# keyword-metrics API (Ahrefs/Semrush/etc.): implement KeywordDataAdapter in a
# new provider class, set isVerifiedData:true, and swap it into
# KeywordDataService. Callers don't change.

# --- PricingDataAdapter (providers/pricing-data.service.ts) ---
# Primary source is our own listings DB (no key needed). Optional secondary
# web-signal note (Claude + web search, requires AI_PROVIDER=claude):
AI_PRICING_WEB_CHECK=true                 # default: off

# --- ImageEnhanceAdapter (providers/image-enhance.service.ts) — STUB ---
# Claude cannot enhance images (understanding only). To go live: implement
# ImageEnhanceAdapter against Replicate (Real-ESRGAN/GFPGAN) or a commercial
# upscale API, register it in ImageEnhanceService's constructor, then:
AI_IMAGE_PROVIDER=stub                    # today: 'stub' only (pass-through)
```

The Image Enhancer's credits/history/jobId-polling plumbing is fully wired —
swapping in a real provider is a one-file change in
`providers/image-enhance.service.ts` (marked with
`TODO: integrate image enhancement provider`).


## Phase 5 follow-ups (embeddings, voice, quiz, digest, enhancer)
Env (all optional; each feature is simply OFF when its env is missing - clean "unavailable", never a crash, never a credit debit):
- Semantic search: `VOYAGE_API_KEY`, `VOYAGE_MODEL` (default voyage-3.5-lite), `VOYAGE_OUTPUT_DIM`, `EMBEDDINGS_BATCH_SIZE` (32), `EMBEDDINGS_MIN_INTERVAL_MS` (400), `SEMANTIC_MAX_CANDIDATES` (1500), `SEMANTIC_MIN_SCORE` (0.3), `ATLAS_VECTOR_INDEX` (name of an Atlas Vector Search index on `product_embeddings.vector`; when set `$vectorSearch` is used, otherwise cosine runs in-process).
  Vectors live in their own collection `product_embeddings` (never on the product document). Incremental sync runs every 5 min (recent updates) and nightly (full, capped); admin: `GET /api/admin/ai/embeddings/status`, `POST /api/admin/ai/embeddings/backfill {limit}`. Only changed text (hash) is re-embedded.
- Voice search: browser speech-to-text only (Web Speech API). `POST /api/ai/voice-search {transcript}` is a text alias of `GET /api/ai/search`; no audio reaches our servers. Admin flag `voice_search`.
- Quiz generator (`quiz_generator`, credit metered): `POST /api/ai/seller/:storeId/quiz`; free helpers `sheet/html`, `sheet/save-as-product` (English PDF via pdf-lib -> private upload -> DRAFT digital product, price 0, `aiGenerated: true`; Urdu content is refused with 422 `PDF_URDU_UNSUPPORTED`, use the printable HTML). Listen = browser SpeechSynthesis. Server TTS is an adapter interface (`providers/tts.service.ts`, `TTS_PROVIDER`, disabled by default).
- Weekly digest: opt-in per store (`PUT /api/ai/seller/:storeId/insights/settings`), hourly job runs it once per ISO week only for opted-in stores, only when the wallet can pay (otherwise skipped + one notification), respects the `weekly_insights` kill switch.
- Image Enhancer: `CLOUDINARY_AI_ENABLED=true` (+ `CLOUDINARY_CLOUD_NAME`) uses Cloudinary transformations (`e_upscale`, `e_improve`, `e_background_removal`; some are Cloudinary add-ons that must be enabled on the account). Otherwise the tool answers 503 before any credit hold. Claude is only used for alt text / photo check.
- Legacy Studio on the dev mock provider: no credit hold, `creditsCharged: 0`, response carries `isSample: true` + `sampleNotice`. Production without a key still answers 503.
- Rate limit: `AI_RATE_LIMIT_PER_MIN` is now enforced through Redis (fixed window, shared across instances) with an in-memory fallback when Redis is down.