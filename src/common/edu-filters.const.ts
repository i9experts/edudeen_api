/* eslint-disable prettier/prettier */
/**
 * Buyer-facing filters that sit BESIDE the category tree (not inside it): who a resource is for (audience),
 * which exam board / syllabus it follows (curriculum, grouped by region so Edudeen can serve every market),
 * and which language it is written in.
 *
 * Self-contained on purpose (no imports, no enums): the one-off scripts in src/scripts load this file directly
 * with `node --experimental-strip-types`, so it must not depend on anything that needs a build step.
 */

// ── Audience ──────────────────────────────────────────────────────────────
/** Who a product is meant for. A product can have several (a Quran workbook can suit kids AND parents). */
export const AUDIENCES = [
  'kids', 'teens', 'parents', 'teachers', 'schools', 'madrasas', 'homeschoolers', 'adult_learners',
] as const;
export type Audience = (typeof AUDIENCES)[number];

export const AUDIENCE_LABELS: Record<Audience, string> = {
  kids: 'Kids',
  teens: 'Teens',
  parents: 'Parents',
  teachers: 'Teachers',
  schools: 'Schools',
  madrasas: 'Madrasas & Maktabs',
  homeschoolers: 'Homeschoolers',
  adult_learners: 'Adult learners',
};

export const isAudience = (v: unknown): v is Audience => typeof v === 'string' && (AUDIENCES as readonly string[]).includes(v);

// ── Curriculum (exam board / syllabus), grouped by region ─────────────────
/** Every key ever stored stays here: removing one would make old products fail validation. Append only. */
export const CURRICULA = [
  // Pakistan (the original list)
  'federal', 'punjab', 'sindh', 'kpk', 'balochistan', 'ajk_gb', 'aku_eb',
  // International
  'cambridge_o', 'cambridge_a', 'igcse', 'ib',
  // Islamic
  'madrasa', 'wifaq_ul_madaris', 'al_azhar',
  // United Kingdom
  'uk_national', 'gcse', 'a_level_uk',
  // United States / Canada
  'us_common_core', 'us_homeschool', 'canada_provincial',
  // Gulf / Middle East
  'saudi_moe', 'uae_moe', 'qatar_moe', 'kuwait_moe', 'egypt_moe',
  // South & South-East Asia
  'india_cbse', 'india_icse', 'bangladesh_nctb', 'malaysia_kssm', 'indonesia_kurikulum_merdeka',
  // Africa / Europe / Oceania
  'nigeria_waec', 'south_africa_caps', 'turkey_meb', 'australia_acara',
] as const;
export type Curriculum = (typeof CURRICULA)[number];

export const CURRICULUM_REGIONS = [
  'international', 'islamic', 'pakistan', 'uk', 'north_america', 'middle_east', 'asia', 'africa', 'europe', 'oceania',
] as const;
export type CurriculumRegion = (typeof CURRICULUM_REGIONS)[number];

export const CURRICULUM_REGION_LABELS: Record<CurriculumRegion, string> = {
  international: 'International',
  islamic: 'Islamic',
  pakistan: 'Pakistan',
  uk: 'United Kingdom',
  north_america: 'North America',
  middle_east: 'Middle East & Gulf',
  asia: 'South & South-East Asia',
  africa: 'Africa',
  europe: 'Europe',
  oceania: 'Oceania',
};

export const CURRICULUM_INFO: Record<Curriculum, { label: string; region: CurriculumRegion }> = {
  federal: { label: 'Federal Board (FBISE)', region: 'pakistan' },
  punjab: { label: 'Punjab Board', region: 'pakistan' },
  sindh: { label: 'Sindh Board', region: 'pakistan' },
  kpk: { label: 'KPK Board', region: 'pakistan' },
  balochistan: { label: 'Balochistan Board', region: 'pakistan' },
  ajk_gb: { label: 'AJK & Gilgit-Baltistan', region: 'pakistan' },
  aku_eb: { label: 'Aga Khan University Examination Board', region: 'pakistan' },
  cambridge_o: { label: 'Cambridge O Level', region: 'international' },
  cambridge_a: { label: 'Cambridge A Level', region: 'international' },
  igcse: { label: 'IGCSE', region: 'international' },
  ib: { label: 'International Baccalaureate (IB)', region: 'international' },
  madrasa: { label: 'Madrasa / Dars-e-Nizami', region: 'islamic' },
  wifaq_ul_madaris: { label: 'Wifaq ul Madaris', region: 'islamic' },
  al_azhar: { label: 'Al-Azhar', region: 'islamic' },
  uk_national: { label: 'UK National Curriculum', region: 'uk' },
  gcse: { label: 'GCSE', region: 'uk' },
  a_level_uk: { label: 'A Level (UK boards)', region: 'uk' },
  us_common_core: { label: 'US Common Core', region: 'north_america' },
  us_homeschool: { label: 'US Homeschool', region: 'north_america' },
  canada_provincial: { label: 'Canada (provincial)', region: 'north_america' },
  saudi_moe: { label: 'Saudi Arabia (MoE)', region: 'middle_east' },
  uae_moe: { label: 'UAE (MoE)', region: 'middle_east' },
  qatar_moe: { label: 'Qatar (MoEHE)', region: 'middle_east' },
  kuwait_moe: { label: 'Kuwait (MoE)', region: 'middle_east' },
  egypt_moe: { label: 'Egypt (MoE)', region: 'middle_east' },
  india_cbse: { label: 'India CBSE', region: 'asia' },
  india_icse: { label: 'India ICSE', region: 'asia' },
  bangladesh_nctb: { label: 'Bangladesh NCTB', region: 'asia' },
  malaysia_kssm: { label: 'Malaysia KSSR / KSSM', region: 'asia' },
  indonesia_kurikulum_merdeka: { label: 'Indonesia Kurikulum Merdeka', region: 'asia' },
  nigeria_waec: { label: 'WAEC (West Africa)', region: 'africa' },
  south_africa_caps: { label: 'South Africa CAPS', region: 'africa' },
  turkey_meb: { label: 'Turkey (MEB)', region: 'europe' },
  australia_acara: { label: 'Australian Curriculum', region: 'oceania' },
};

export const isCurriculum = (v: unknown): v is Curriculum => typeof v === 'string' && (CURRICULA as readonly string[]).includes(v);

/** Curricula grouped by region, in display order (for filter menus). */
export function curriculaByRegion(): { region: CurriculumRegion; label: string; curricula: { key: Curriculum; label: string }[] }[] {
  return CURRICULUM_REGIONS.map((region) => ({
    region,
    label: CURRICULUM_REGION_LABELS[region],
    curricula: CURRICULA.filter((c) => CURRICULUM_INFO[c].region === region).map((key) => ({ key, label: CURRICULUM_INFO[key].label })),
  })).filter((g) => g.curricula.length > 0);
}

// ── Content language ──────────────────────────────────────────────────────
/** ISO 639-1 codes plus 'mixed'. Append only (old products store 'ur' | 'en' | 'ar' | 'mixed'). */
export const PRODUCT_LANGUAGES = [
  'ur', 'en', 'ar', 'mixed',
  'fr', 'ms', 'id', 'tr', 'bn', 'so', 'fa', 'hi', 'sw', 'ha', 'de', 'es',
] as const;
export type ProductLanguage = (typeof PRODUCT_LANGUAGES)[number];

export const PRODUCT_LANGUAGE_LABELS: Record<ProductLanguage, string> = {
  ur: 'Urdu', en: 'English', ar: 'Arabic', mixed: 'Mixed / bilingual',
  fr: 'French', ms: 'Malay', id: 'Indonesian', tr: 'Turkish', bn: 'Bengali', so: 'Somali',
  fa: 'Persian', hi: 'Hindi', sw: 'Swahili', ha: 'Hausa', de: 'German', es: 'Spanish',
};

/** Languages a category name can be translated into (the default `name` is English). */
export const CATEGORY_NAME_LANGUAGES = PRODUCT_LANGUAGES.filter((l) => l !== 'en' && l !== 'mixed');

// ── Audience inference (used once, to backfill existing products) ─────────
export interface AudienceHints {
  rootCategoryName?: string | null;
  subCategoryName?: string | null;
  ageMin?: number | null;
  ageMax?: number | null;
  licenseType?: string | null;
  educationLevel?: string | null;
  deliveryFormat?: string | null;
}

const has = (s: string | null | undefined, re: RegExp) => !!s && re.test(s);

/**
 * Best guess at who an existing product is for, from data it already has. Conservative: returns [] when nothing
 * points anywhere, so the seller (or admin) fills it in rather than Edudeen guessing wrong.
 */
export function inferAudiences(h: AudienceHints): Audience[] {
  const out = new Set<Audience>();
  const cat = `${h.rootCategoryName ?? ''} / ${h.subCategoryName ?? ''}`;

  // Category signals
  if (has(cat, /teacher|lesson plan|classroom|rubric|assessment/i)) out.add('teachers');
  if (has(cat, /homeschool/i)) { out.add('homeschoolers'); out.add('parents'); }
  if (has(cat, /parent|family/i)) out.add('parents');
  if (has(cat, /school\s*&\s*madrasa|school supplies|uniform|furniture|lab equipment/i)) { out.add('schools'); out.add('madrasas'); }
  if (has(cat, /early learning|toy|colouring|coloring|rhyme|kids/i)) out.add('kids');
  if (has(cat, /exam prep|past paper|entry test|o level|a level|matric|intermediate|gcse|igcse/i)) out.add('teens');
  if (has(cat, /spoken english|ielts|professional/i)) out.add('adult_learners');

  // Licence: a classroom / school licence is bought by teachers / schools
  if (h.licenseType === 'single_classroom') out.add('teachers');
  if (h.licenseType === 'school') out.add('schools');

  // Age range (an open end does not count)
  if (h.ageMax != null && h.ageMax <= 12) out.add('kids');
  if (h.ageMin != null && h.ageMax != null && h.ageMin >= 12 && h.ageMax <= 19) out.add('teens');
  if (h.ageMin != null && h.ageMin >= 18) out.add('adult_learners');

  // Legacy coarse level
  if (h.educationLevel === 'preschool' || h.educationLevel === 'primary_school') out.add('kids');
  if (h.educationLevel === 'middle_school' || h.educationLevel === 'secondary_school') out.add('teens');
  if (h.educationLevel === 'university' || h.educationLevel === 'professional_courses') out.add('adult_learners');

  return AUDIENCES.filter((a) => out.has(a));
}
