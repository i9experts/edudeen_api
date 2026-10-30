/* eslint-disable prettier/prettier */

/**
 * Per-tool JSON output schemas + prompt builders. Kept out of the service so
 * prompt tuning never touches orchestration (credits/history/error handling).
 * Schemas follow structured-outputs rules: additionalProperties:false and an
 * explicit required list on every object.
 */

export const LISTING_WRITER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    suggestedTags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'description', 'suggestedTags'],
  additionalProperties: false,
};

export function buildListingWriterPrompt(input: { productType: string; keywords: string[]; tone: string }): { system: string; prompt: string } {
  return {
    system: `You are an expert e-commerce copywriter for a marketplace of physical and digital products. Write in a ${input.tone} tone. Titles must be under 80 characters and front-load the most searched words. Descriptions are 2-4 short paragraphs, benefit-led, honest (never invent specs the seller didn't give), and scannable. Suggest 5-10 lowercase tags.`,
    prompt: [
      `Write a product listing.`,
      `Product type: ${input.productType}`,
      `Keywords to work in naturally: ${input.keywords.join(', ')}`,
    ].join('\n'),
  };
}

export const SEO_WRITING_SCHEMA = {
  type: 'object',
  properties: {
    optimizedTitle: { type: 'string' },
    optimizedTags: { type: 'array', items: { type: 'string' } },
    rankingNotes: { type: 'string' },
  },
  required: ['optimizedTitle', 'optimizedTags', 'rankingNotes'],
  additionalProperties: false,
};

export function buildSeoWritingPrompt(input: {
  title: string;
  description?: string;
  currentTags: string[];
  keywordSignals: Array<{ keyword: string; searchIntent?: string; competition?: string; rationale?: string }>;
}): { system: string; prompt: string } {
  const signalBlock = input.keywordSignals.length
    ? `Researched keyword signals (from live web search — treat as directional, not measured volume):\n${input.keywordSignals
        .map((k) => `- "${k.keyword}"${k.competition ? ` (competition: ${k.competition})` : ''}${k.searchIntent ? ` — intent: ${k.searchIntent}` : ''}`)
        .join('\n')}`
    : 'No keyword research data is available for this niche — optimize using general marketplace SEO best practices and say so in the notes.';

  return {
    system: 'You are a marketplace SEO specialist. Optimize listings for internal marketplace search and Google Shopping-style queries. Keep titles under 80 characters, keyword-first but human-readable. Return 8-13 lowercase tags, preferring researched signals over invented ones. rankingNotes: 2-4 sentences explaining what changed and why it should rank better.',
    prompt: [
      `Current title: ${input.title}`,
      input.description ? `Current description: ${input.description.slice(0, 1500)}` : '',
      `Current tags: ${input.currentTags.length ? input.currentTags.join(', ') : '(none)'}`,
      '',
      signalBlock,
    ].filter(Boolean).join('\n'),
  };
}

export const EMAIL_CAMPAIGN_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    previewText: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['subject', 'previewText', 'body'],
  additionalProperties: false,
};

export function buildEmailCampaignPrompt(input: {
  campaignGoal: string;
  tone: string;
  storeName?: string;
  products: Array<{ name: string; price?: number | null }>;
}): { system: string; prompt: string } {
  return {
    system: `You draft buyer-facing marketing emails for independent marketplace sellers. Tone: ${input.tone}. Subject under 60 characters, previewText under 110 characters, body 120-250 words of plain text with short paragraphs and one clear call to action. Never fabricate discounts, percentages, or deadlines the seller didn't specify — use placeholders like [DISCOUNT] where the seller must fill in specifics.`,
    prompt: [
      `Campaign goal: ${input.campaignGoal.replace(/_/g, ' ')}`,
      input.storeName ? `Store name: ${input.storeName}` : '',
      input.products.length
        ? `Featured products:\n${input.products.map((p) => `- ${p.name}${p.price != null ? ` ($${p.price})` : ''}`).join('\n')}`
        : 'No specific products — write for the store generally.',
    ].filter(Boolean).join('\n'),
  };
}

export const WORKSHEET_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instructions: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                type: { type: 'string', enum: ['multiple_choice', 'short_answer', 'fill_in_blank', 'true_false', 'open_ended'] },
                choices: { type: 'array', items: { type: 'string' } },
                answer: { type: 'string' },
              },
              required: ['prompt', 'type'],
              additionalProperties: false,
            },
          },
        },
        required: ['instructions', 'questions'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'sections'],
  additionalProperties: false,
};

export function buildWorksheetPrompt(input: {
  subject: string;
  gradeLevel: string;
  topics: string[];
  questionCount: number;
  includeAnswerKey: boolean;
}): { system: string; prompt: string } {
  return {
    system: 'You are an experienced curriculum designer producing structured worksheet CONTENT as JSON. A separate non-AI renderer turns your JSON into the downloadable file — do NOT produce any file formatting, markdown, or layout markup; only clean question text. Questions must be age-appropriate, factually correct, and unambiguous. multiple_choice questions must include 3-5 choices; other types omit choices.',
    prompt: [
      `Create a worksheet.`,
      `Subject: ${input.subject}`,
      `Grade level: ${input.gradeLevel}`,
      `Topics: ${input.topics.join(', ')}`,
      `Total questions across all sections: exactly ${input.questionCount}. Group them into 1-4 logical sections, each with brief student-facing instructions.`,
      input.includeAnswerKey
        ? 'Include the correct answer for every question in its "answer" field.'
        : 'Omit the "answer" field entirely on every question.',
    ].join('\n'),
  };
}

export const PRICE_EXPLANATION_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' } },
  required: ['explanation'],
  additionalProperties: false,
};

export function buildPriceExplanationPrompt(input: {
  productName: string;
  categoryName?: string;
  sampleSize: number;
  suggestedPrice: number;
  suggestedPriceMin: number;
  suggestedPriceMax: number;
  medianPrice: number;
}): { system: string; prompt: string } {
  return {
    system: 'You explain pricing suggestions to marketplace sellers in 3-5 plain sentences. CRITICAL: the numbers were computed statistically from real comparable listings — narrate them exactly as given, never adjust them, never introduce new figures.',
    prompt: [
      `Product: ${input.productName}${input.categoryName ? ` (category: ${input.categoryName})` : ''}`,
      `Computed from ${input.sampleSize} comparable active listings on this marketplace:`,
      `- suggested price: $${input.suggestedPrice} (the category median is $${input.medianPrice})`,
      `- suggested range: $${input.suggestedPriceMin} - $${input.suggestedPriceMax} (25th-75th percentile of comparables)`,
      'Explain what these numbers mean and how the seller should position within the range.',
    ].join('\n'),
  };
}
