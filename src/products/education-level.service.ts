/* eslint-disable prettier/prettier */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

// ── Step 1: regex-based normalization for numeric/roman grade patterns ──────
// "Class 5", "Grade 5", "5th Class", "Grade-5" -> "grade-5"; "Grade V" -> "grade-5"
const GRADE_REGEXES: RegExp[] = [
  /^(?:class|grade)\s*-?\s*(\d{1,2})\s*(?:st|nd|rd|th)?$/i,
  /^(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:class|grade)$/i,
];
const GRADE_ROMAN_REGEX = /^(?:class|grade)\s*-?\s*([ivx]{1,5})$/i;
const ROMAN_TO_INT: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

// ── Step 2: admin-curated alias table — seeded on boot, ready for a future admin UI ──
const SEED_ALIASES: { matchKey: string; canonicalSlug: string; canonicalDisplayName: string }[] = [
  { matchKey: 'hifzcourse',        canonicalSlug: 'hifz',      canonicalDisplayName: 'Hifz' },
  { matchKey: 'hifzquran',         canonicalSlug: 'hifz',      canonicalDisplayName: 'Hifz' },
  { matchKey: 'hifzqurancourse',   canonicalSlug: 'hifz',      canonicalDisplayName: 'Hifz' },
  { matchKey: 'nazraquran',        canonicalSlug: 'nazra',     canonicalDisplayName: 'Nazra Quran' },
  { matchKey: 'nazraqurancourse',  canonicalSlug: 'nazra',     canonicalDisplayName: 'Nazra Quran' },
  { matchKey: 'aalimcourse',       canonicalSlug: 'aalim',     canonicalDisplayName: 'Aalim Course' },
  { matchKey: 'olevel',            canonicalSlug: 'o-level',   canonicalDisplayName: 'O-Level' },
  { matchKey: 'alevel',            canonicalSlug: 'a-level',   canonicalDisplayName: 'A-Level' },
  { matchKey: 'matric',            canonicalSlug: 'matric',    canonicalDisplayName: 'Matric' },
  { matchKey: 'matriculation',     canonicalSlug: 'matric',    canonicalDisplayName: 'Matric' },
  { matchKey: 'fsc',               canonicalSlug: 'fsc',       canonicalDisplayName: 'FSc' },
  { matchKey: 'ib',                canonicalSlug: 'ib',        canonicalDisplayName: 'IB' },
  { matchKey: 'cambridge',         canonicalSlug: 'cambridge', canonicalDisplayName: 'Cambridge' },
];

function slugify(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}
// strips ALL punctuation/spacing so "O-Level" / "O Level" / "OLevel" collapse to one lookup key
function alnumKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

@Injectable()
export class EducationLevelService implements OnModuleInit {
  constructor(private readonly db: DatabaseService) {}

  private get aliasModel() { return this.db.repositories.educationLevelAliasModel; }
  private get productModel() { return this.db.repositories.productModel; }

  async onModuleInit() {
    const count = await this.aliasModel.countDocuments();
    if (count > 0) return;
    await this.aliasModel.insertMany(SEED_ALIASES.map(a => ({ ...a, createdBy: null })));
  }

  /** Regex pass, then alias-table pass, else the raw text becomes its own new bucket. */
  async normalizeCustomLevel(raw: string): Promise<{ customLevel: string; normalizedCustomLevel: string }> {
    const trimmed = raw.trim();

    for (const re of GRADE_REGEXES) {
      const m = trimmed.match(re);
      if (m) return { customLevel: trimmed, normalizedCustomLevel: `grade-${parseInt(m[1], 10)}` };
    }
    const romanMatch = trimmed.match(GRADE_ROMAN_REGEX);
    if (romanMatch) {
      const n = ROMAN_TO_INT[romanMatch[1].toLowerCase()];
      if (n) return { customLevel: trimmed, normalizedCustomLevel: `grade-${n}` };
    }

    const key = alnumKey(trimmed);
    const alias = key ? await this.aliasModel.findOne({ matchKey: key }).lean() : null;
    if (alias) return { customLevel: trimmed, normalizedCustomLevel: alias.canonicalSlug };

    return { customLevel: trimmed, normalizedCustomLevel: slugify(trimmed) };
  }

  /** Tier-1 + Tier-2 counts from live products only — backs the buyer-side dynamic filter chips. */
  async getFacets() {
    const baseMatch = { productType: 'educational', status: 'active', isDelete: false, isTest: { $ne: true } };

    const levelRows = await this.productModel.aggregate([
      { $match: { ...baseMatch, educationLevel: { $ne: null } } },
      { $group: { _id: '$educationLevel', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const otherRows = await this.productModel.aggregate([
      { $match: { ...baseMatch, educationLevel: 'other', normalizedCustomLevel: { $ne: null } } },
      { $group: { _id: '$normalizedCustomLevel', count: { $sum: 1 }, sampleLabel: { $first: '$customLevel' } } },
      { $sort: { count: -1 } },
    ]);

    const slugs = otherRows.map((r) => r._id);
    const aliases = slugs.length ? await this.aliasModel.find({ canonicalSlug: { $in: slugs } }).lean() : [];
    const displayBySlug = new Map(aliases.map((a) => [a.canonicalSlug, a.canonicalDisplayName]));

    return {
      levels: levelRows.map((r) => ({ level: r._id as string, count: r.count as number })),
      otherLevels: otherRows.map((r) => ({
        slug: r._id as string,
        displayName: displayBySlug.get(r._id) ?? r.sampleLabel ?? r._id,
        count: r.count as number,
      })),
    };
  }

  /** Seller-side autocomplete while typing a custom level — existing distinct labels, most-used first. */
  async getCustomLevelSuggestions(q: string): Promise<string[]> {
    const term = q.trim();
    if (!term) return [];
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = await this.productModel.aggregate([
      { $match: { productType: 'educational', educationLevel: 'other', customLevel: { $regex: escaped, $options: 'i' } } },
      { $group: { _id: '$customLevel', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]);
    return rows.map((r) => r._id as string);
  }
}
