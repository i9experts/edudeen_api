/* eslint-disable prettier/prettier */

/**
 * Registry of every AI feature. The key is stored in `ai_generations.toolType`, used by the admin kill switches
 * (PlatformConfig.aiConfig.featureFlags / storeOverrides) and by the web app to show or hide the UI.
 * A missing flag means ENABLED; only an explicit `false` disables a feature.
 */
export const AI_FEATURE_DEFS = {
  // --- AI Studio (seller tools, flat credit cost per generation) ---
  listing_writer:    { label: 'Listing Writer',            group: 'studio',   credits: 5 },
  price_optimizer:   { label: 'Price Optimizer',           group: 'studio',   credits: 10 },
  worksheet_builder: { label: 'Worksheet Builder',         group: 'studio',   credits: 10 },
  seo_booster:       { label: 'SEO Booster',               group: 'studio',   credits: 5 },
  email_campaigns:   { label: 'Email Campaigns',           group: 'studio',   credits: 5 },
  image_enhancer:    { label: 'Image Enhancer / photo check', group: 'studio', credits: 15 },
  image_check:       { label: 'Photo check + alt text',    group: 'studio',   credits: 3 },
  // --- seller helpers (charged to the store wallet) ---
  translate_listing: { label: 'Urdu/English translation',  group: 'seller',   credits: 2 },
  review_reply:      { label: 'Review reply drafts',       group: 'seller',   credits: 2 },
  weekly_insights:   { label: 'Weekly insights digest',    group: 'seller',   credits: 5 },
  help_bot:          { label: 'Seller help bot',           group: 'seller',   credits: 0 },
  product_cover:     { label: 'Product cover text',        group: 'seller',   credits: 2 },
  // --- platform features (cost carried by Edudeen, logged only) ---
  moderation_review: { label: 'Listing pre-moderation',    group: 'platform', credits: 0 },
  smart_search:      { label: 'Smart search',              group: 'platform', credits: 0 },
  receipt_ocr:       { label: 'Bank-transfer receipt reading', group: 'platform', credits: 0 },
  shopping_assistant:{ label: 'Buyer shopping assistant',  group: 'platform', credits: 0 },
  cod_risk:          { label: 'COD risk explanation',      group: 'platform', credits: 0 },
  review_summary:    { label: 'Review summaries',          group: 'platform', credits: 0 },
  ask_data:          { label: 'Admin ask-your-data',       group: 'platform', credits: 0 },
  voice_search:      { label: 'Voice search (stub)',       group: 'platform', credits: 0 },
  quiz_audio:        { label: 'Quiz / audio (stub)',       group: 'platform', credits: 0 },
} as const;

export type AiFeatureKey = keyof typeof AI_FEATURE_DEFS;
export const AI_FEATURE_KEYS = Object.keys(AI_FEATURE_DEFS) as AiFeatureKey[];

export function isAiFeatureKey(value: unknown): value is AiFeatureKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_FEATURE_DEFS, value);
}

/** Pure: is a feature enabled given the admin's global flags + per-store overrides? */
export function isFeatureEnabled(
  feature: AiFeatureKey,
  flags: Record<string, unknown> | null | undefined,
  storeOverrides: Record<string, unknown> | null | undefined,
  storeId?: string | null,
): boolean {
  if (flags && flags.__all === false) return false;
  if (flags && flags[feature] === false) return false;
  if (storeId && storeOverrides) {
    const off = storeOverrides[storeId];
    if (Array.isArray(off) && (off.includes(feature) || off.includes('__all'))) return false;
  }
  return true;
}
