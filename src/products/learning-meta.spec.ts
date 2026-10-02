import { BadRequestException } from '@nestjs/common';
import { cleanLearningMeta, cleanLicenseTiers, licenseFromVariant } from './product-input.util';
import { sanitizeDigitalForPublicView } from './product-public-view.util';

describe('learning metadata', () => {
  it('accepts known boards and an age range, and only returns what was sent', () => {
    expect(cleanLearningMeta({ curricula: ['punjab', 'cambridge_o', 'punjab'], ageMin: 6, ageMax: 8 }))
      .toEqual({ curricula: ['punjab', 'cambridge_o'], ageMin: 6, ageMax: 8 });
    expect(cleanLearningMeta({})).toEqual({});
    expect(cleanLearningMeta({ ageMin: null })).toEqual({ ageMin: null });
  });

  it('rejects unknown boards, bad ages and an upside-down range', () => {
    expect(() => cleanLearningMeta({ curricula: ['narnia'] })).toThrow(BadRequestException);
    expect(() => cleanLearningMeta({ ageMin: -1 })).toThrow(/ageMin/);
    expect(() => cleanLearningMeta({ ageMin: 5.5 })).toThrow(/ageMin/);
    expect(() => cleanLearningMeta({ ageMin: 10, ageMax: 6 })).toThrow(/more than/);
  });
});

describe('license tiers', () => {
  it('validates each license once with a real price', () => {
    expect(cleanLicenseTiers([{ license: 'single_classroom', price: 1500 }, { license: 'school', price: 6000, compareAtPrice: 8000 }]))
      .toEqual([{ license: 'single_classroom', price: 1500, compareAtPrice: null }, { license: 'school', price: 6000, compareAtPrice: 8000 }]);
    expect(cleanLicenseTiers(null)).toEqual([]);
    expect(() => cleanLicenseTiers([{ license: 'school', price: 1 }, { license: 'school', price: 2 }])).toThrow(/once/);
    expect(() => cleanLicenseTiers([{ license: 'galaxy', price: 1 }])).toThrow(/license/);
    expect(() => cleanLicenseTiers([{ license: 'school', price: -5 }])).toThrow(/price/);
  });

  it('reads the license a buyer picked from the variant option', () => {
    expect(licenseFromVariant({ options: [{ name: 'License', value: 'Whole school' }] })).toBe('school');
    expect(licenseFromVariant({ options: [{ name: 'Colour', value: 'Red' }] })).toBeNull();
    expect(licenseFromVariant(null)).toBeNull();
  });
});

describe('free sample in public views', () => {
  it('says a sample exists without leaking its storage path', () => {
    const out: any = sanitizeDigitalForPublicView({
      digital: { files: [{ url: 'private/a' }], sampleFile: { url: 'private/sample', name: 'sample.pdf' }, preview: { enabled: false } },
    });
    expect(out.digital).toEqual(expect.objectContaining({ sampleAvailable: true, sampleName: 'sample.pdf', fileCount: 1 }));
    expect(JSON.stringify(out)).not.toContain('private/sample');
  });
});
