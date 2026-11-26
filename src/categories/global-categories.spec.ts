/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { GLOBAL_TAXONOMY, TAXONOMY_MOVES, TaxonomyNode } from './global-taxonomy.data';
import { MAX_CREATE_DEPTH } from './category-tree.util';
import { assertKindAllowed, cleanCategorySettings, effectiveCategoryRules, productKind } from './category-settings.util';
import {
  AUDIENCES, CURRICULA, CURRICULUM_INFO, PRODUCT_LANGUAGES, PRODUCT_LANGUAGE_LABELS, curriculaByRegion, inferAudiences,
} from '../common/edu-filters.const';
import { cleanLearningMeta, resolveSellerPublishStatus } from '../products/product-input.util';
import { buildProductFilter, normalizeFilters } from '../ai-studio/features/catalog.service';
import { buildAllWordsFilter } from '../search/search-terms.util';

describe('global taxonomy data', () => {
  const walk = (nodes: TaxonomyNode[], depth: number, fn: (n: TaxonomyNode, d: number) => void) => {
    for (const n of nodes) { fn(n, depth); walk(n.subs ?? [], depth + 1, fn); }
  };

  it('puts the Islamic groups first', () => {
    expect(GLOBAL_TAXONOMY.slice(0, 4).map((n) => n.name)).toEqual(['Quran & Tajweed', 'Islamic Studies', 'Arabic Language', 'Islamic Lifestyle & Family']);
  });

  it('stays within the creatable depth and has unique sibling names', () => {
    const check = (nodes: TaxonomyNode[]) => {
      const names = nodes.map((n) => n.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      for (const n of nodes) check(n.subs ?? []);
    };
    check(GLOBAL_TAXONOMY);
    walk(GLOBAL_TAXONOMY, 1, (_n, d) => expect(d).toBeLessThanOrEqual(MAX_CREATE_DEPTH));
  });

  it('has no audience or country as a main category (those are filters)', () => {
    const mains = GLOBAL_TAXONOMY.map((n) => n.name.toLowerCase());
    for (const bad of ['kids', 'parents', 'teachers', 'schools', 'pakistan studies', 'social studies & pakistan studies']) expect(mains).not.toContain(bad);
  });

  it('every node carries settings the API would accept', () => {
    walk(GLOBAL_TAXONOMY, 1, (n) => {
      expect(() => cleanCategorySettings({ icon: n.icon, color: n.color, nameTranslations: n.nameTranslations, allowedProductTypes: n.allowedProductTypes, requiresListingReview: n.requiresListingReview })).not.toThrow();
    });
  });

  it('every move targets a path that exists in the taxonomy and ends with the moved node', () => {
    for (const mv of TAXONOMY_MOVES) {
      let level: TaxonomyNode[] | undefined = GLOBAL_TAXONOMY;
      for (const name of mv.to) level = level?.find((n) => n.name === name)?.subs;
      expect(level?.some((n) => n.name === mv.name)).toBe(true);
    }
  });
});

describe('filters beside the tree', () => {
  it('keeps every curriculum key that older products may store', () => {
    for (const old of ['federal', 'punjab', 'sindh', 'kpk', 'balochistan', 'ajk_gb', 'cambridge_o', 'cambridge_a', 'igcse', 'ib', 'aku_eb', 'madrasa']) {
      expect(CURRICULA).toContain(old);
    }
    for (const c of CURRICULA) expect(CURRICULUM_INFO[c]).toBeDefined();
    expect(curriculaByRegion().flatMap((g) => g.curricula.map((x) => x.key)).sort()).toEqual([...CURRICULA].sort());
  });

  it('keeps old language codes and labels every language', () => {
    for (const old of ['ur', 'en', 'ar', 'mixed']) expect(PRODUCT_LANGUAGES).toContain(old);
    for (const l of PRODUCT_LANGUAGES) expect(PRODUCT_LANGUAGE_LABELS[l]).toBeTruthy();
  });

  it('cleans audiences: valid only, canonical order, null clears', () => {
    expect(cleanLearningMeta({ audiences: ['teachers', 'kids', 'kids'] }).audiences).toEqual(['kids', 'teachers']);
    expect(cleanLearningMeta({ audiences: null }).audiences).toEqual([]);
    expect(cleanLearningMeta({}).audiences).toBeUndefined();
    expect(() => cleanLearningMeta({ audiences: ['aliens'] })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ audiences: 'kids' })).toThrow(BadRequestException);
    expect(cleanLearningMeta({ curricula: ['gcse', 'malaysia_kssm'], language: 'ms' })).toMatchObject({ curricula: ['gcse', 'malaysia_kssm'], language: 'ms' });
  });

  it('AI search accepts and applies audiences', () => {
    const f = normalizeFilters({ keywords: ['quran'], audiences: ['kids', 'martians', 'kids'] });
    expect(f.audiences).toEqual(['kids']);
    expect(buildProductFilter(f, ['s1']).audiences).toEqual({ $in: ['kids'] });
  });

  it('keyword search understands the new language words', () => {
    expect(JSON.stringify(buildAllWordsFilter('malay'))).toContain('"language":"ms"');
  });

  it('infers audiences conservatively', () => {
    expect(inferAudiences({ rootCategoryName: 'Teacher Resources', subCategoryName: 'Lesson Plans' })).toEqual(['teachers']);
    expect(inferAudiences({ rootCategoryName: 'Mathematics', ageMin: 5, ageMax: 8 })).toEqual(['kids']);
    expect(inferAudiences({ rootCategoryName: 'Exam Prep & Past Papers', ageMin: 14, ageMax: 17 })).toEqual(['teens']);
    expect(inferAudiences({ rootCategoryName: 'School & Madrasa Supplies' })).toEqual(['schools', 'madrasas']);
    expect(inferAudiences({ rootCategoryName: 'Science', licenseType: 'school' })).toEqual(['schools']);
    expect(inferAudiences({ rootCategoryName: 'Mathematics' })).toEqual([]);
    for (const a of inferAudiences({ rootCategoryName: 'Homeschool & Parenting', educationLevel: 'university' })) expect(AUDIENCES).toContain(a);
  });
});

describe('category settings', () => {
  it('validates and normalises', () => {
    expect(cleanCategorySettings({ color: '#abc', icon: ' 📖 ', allowedProductTypes: ['course', 'physical'], nameTranslations: { ar: ' قرآن ', ur: '' } }))
      .toEqual({ color: '#ABC', icon: '📖', allowedProductTypes: ['physical', 'course'], nameTranslations: { ar: 'قرآن' } });
    expect(cleanCategorySettings({ icon: null, color: '', allowedProductTypes: null, nameTranslations: null }))
      .toEqual({ icon: null, color: null, allowedProductTypes: [], nameTranslations: {} });
    expect(() => cleanCategorySettings({ icon: '<script>' })).toThrow(BadRequestException);
    expect(() => cleanCategorySettings({ requiresListingReview: 'yes' })).toThrow(BadRequestException);
    expect(() => cleanCategorySettings({ nameTranslations: { en: 'x' } })).toThrow(/keys/); // English is the default name
  });

  it('nearest allowed-types rule wins; review is required if any ancestor asks', () => {
    const rules = effectiveCategoryRules([
      { name: 'Online Quran Classes', allowedProductTypes: [] },
      { name: 'Courses & Tutoring', allowedProductTypes: ['course'], requiresListingReview: false },
      { name: 'root', allowedProductTypes: ['physical'], requiresListingReview: true },
    ]);
    expect(rules).toEqual({ allowedProductTypes: ['course'], requiresListingReview: true, ruleFrom: 'Courses & Tutoring' });
    expect(() => assertKindAllowed(rules, 'physical')).toThrow(/does not take physical products/);
    expect(() => assertKindAllowed(rules, 'course')).not.toThrow();
    expect(() => assertKindAllowed(effectiveCategoryRules([{ name: 'Any' }]), 'physical')).not.toThrow();
  });

  it('maps products to kinds', () => {
    expect(productKind('physical', 'course')).toBe('physical');
    expect(productKind('digital', 'course')).toBe('course');
    expect(productKind('digital', 'download')).toBe('digital');
    expect(productKind('digital', null)).toBe('digital');
  });

  it('a review-required category holds a first publish even on a paid plan, but not an approved product', () => {
    expect(resolveSellerPublishStatus('active', null, true, true)).toBe('pending_review');
    expect(resolveSellerPublishStatus('scheduled', null, true, true)).toBe('pending_review');
    expect(resolveSellerPublishStatus('draft', null, true, true)).toBe('draft');
    expect(resolveSellerPublishStatus('active', { status: 'inactive', approvedAt: new Date() }, false, true)).toBe('active');
    expect(resolveSellerPublishStatus('active', null, true, false)).toBe('active'); // unchanged behaviour
  });
});
