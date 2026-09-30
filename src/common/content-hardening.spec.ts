import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method, @typescript-eslint/require-await -- mock-heavy tests */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StoreBannerService } from '../store-banner/store-banner.service';
import { StoreThemeService } from '../store-theme/store-theme.service';
import { StorePagesService } from '../store-pages/store-pages.service';
import { StoreBlogService } from '../store-blog/store-blog.service';
import { StoreService } from '../store/store.service';
import { validateSectionSettings } from './store-content/section-settings.validator';
import { assertSafePublicJson } from './query-safety.util';
import { isStoreLive } from './store-live.util';
import { cleanAiText, cleanAiTags } from '../ai-studio/ai-output.util';
import { UpdateThemeDto } from '../store-theme/dto/update-theme.dto';
import { UpdateBlogPostDto } from '../store-blog/dto/update-blog-post.dto';

const SID = '64f0c0ffee0c0ffee0c0ff01';
const chain = (v: any) => { const r: any = Promise.resolve(v); r.lean = () => Promise.resolve(v); r.select = () => r; return r; };
const storeModel = (live: boolean): any => ({ exists: jest.fn().mockResolvedValue(live ? { _id: SID } : null), findOne: jest.fn() });

describe('isStoreLive', () => {
  it('only an active, non-deleted store with a valid id is live', async () => {
    expect(await isStoreLive(storeModel(true), SID)).toBe(true);
    expect(await isStoreLive(storeModel(false), SID)).toBe(false);
    expect(await isStoreLive(storeModel(true), 'nope')).toBe(false);
    expect(await isStoreLive(storeModel(true), { $ne: 1 })).toBe(false);
  });
});

describe('store banners', () => {
  const make = (current: any = { linkType: 'external', linkTarget: 'https://ok.example' }) => {
    const model: any = { findByIdAndUpdate: jest.fn().mockResolvedValue({}), find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [{ _id: 'b' }] }) }) }) };
    const svc: any = Object.create(StoreBannerService.prototype);
    svc.databaseService = { repositories: { storeBannerModel: model, storeModel: storeModel(true) } };
    svc.log = jest.fn();
    svc.findOwned = jest.fn().mockResolvedValue(current);
    svc.adminConfigService = { getPlacementLimit: jest.fn().mockResolvedValue(4) };
    return { svc, model };
  };

  it('an update writes ONLY the declared fields — status / storeId / imageUrl / publicId in the body are ignored', async () => {
    const { svc, model } = make();
    await svc.update(SID, 's1', 'b1', { ctaLabel: 'Shop', status: 'active', storeId: 'other', imageUrl: 'javascript:alert(1)', publicId: 'someone-elses-asset' } as any);
    expect(model.findByIdAndUpdate.mock.calls[0][1].$set).toEqual({ ctaLabel: 'Shop' });
  });

  it('rejects javascript:/data:/protocol-relative/http external links and non-id internal links', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', 'http://plain.example']) {
      await expect(make().svc.update(SID, 's1', 'b1', { linkType: 'external', linkTarget: bad } as any)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(make().svc.update(SID, 's1', 'b1', { linkType: 'product', linkTarget: 'not-an-id' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.update(SID, 's1', 'b1', { linkType: 'external', linkTarget: 'https://ok.example/x' } as any)).resolves.toBeDefined();
  });

  it('an empty update is a 400, and a non-live store serves no banners', async () => {
    await expect(make().svc.update(SID, 's1', 'b1', {} as any)).rejects.toThrow(/Nothing to update/);
    const { svc } = make();
    svc.databaseService.repositories.storeModel = storeModel(false);
    expect((await svc.findActiveForStore(SID)).data).toEqual([]);
  });
});

describe('store theme', () => {
  const make = (live = true) => {
    const model: any = {
      findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue(chain({ storeId: SID, theme: {} })) }),
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
    };
    const svc: any = Object.create(StoreThemeService.prototype);
    svc.databaseService = { repositories: { storeThemeModel: model, storeModel: storeModel(live) } };
    svc.ensureDefaultTheme = jest.fn().mockResolvedValue(undefined);
    return { svc, model };
  };

  it('updateTheme writes only declared keys — an unknown/dotted key is never turned into a draft.theme.<key> write', async () => {
    const { svc, model } = make();
    jest.spyOn(require('./store-ownership.util') as any, 'verifyStoreOwnershipStrict').mockResolvedValue(undefined);
    await svc.updateTheme(SID, 's1', { primaryColor: '#123456', 'a.b': 'x', $where: '1', evil: { nested: true } } as any).catch(() => undefined);
    const set = model.findOneAndUpdate.mock.calls[0]?.[1]?.$set ?? {};
    expect(Object.keys(set)).toEqual(['draft.theme.primaryColor']);
  });

  it('the public theme never includes the unpublished draft, and a non-live store has none', async () => {
    const { svc, model } = make();
    await svc.getPublic(SID);
    expect(model.findOne.mock.results[0].value.select).toBeDefined();
    const sel = jest.fn().mockReturnValue(chain({}));
    model.findOne.mockReturnValue({ select: sel });
    await svc.getPublic(SID);
    expect(sel).toHaveBeenCalledWith('-draft');
    const off = make(false);
    expect((await off.svc.getPublic(SID)).data).toBeNull();
  });

  it('font must be a plain family name (CSS injection) and baseThemeId is bounded', async () => {
    const errs = async (b: object) => (await validate(plainToInstance(UpdateThemeDto, b))).map((e) => e.property);
    expect(await errs({ font: 'x;} body{background:url(//evil/track)}' })).toContain('font');
    expect(await errs({ font: 'Open Sans' })).not.toContain('font');
    expect(await errs({ baseThemeId: 'x'.repeat(61) })).toContain('baseThemeId');
  });
});

describe('public store content reads', () => {
  it('pages and blog refuse a non-live store (pending / suspended / deleted content used to be served by id)', async () => {
    const pages: any = Object.create(StorePagesService.prototype);
    const storePageModel = { findOne: jest.fn(), find: jest.fn() };
    pages.databaseService = { repositories: { storeModel: storeModel(false), storePageModel } };
    for (const call of [() => pages.getPublicHome(SID), () => pages.getPublicPage(SID, 'about'), () => pages.listPublicPages(SID)]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(storePageModel.findOne).not.toHaveBeenCalled();

    const blog: any = Object.create(StoreBlogService.prototype);
    const blogPostModel = { find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() };
    blog.databaseService = { repositories: { storeModel: storeModel(false), blogPostModel } };
    await expect(blog.listPublic(SID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(blog.getPublicBySlug(SID, 'x')).rejects.toBeInstanceOf(NotFoundException);
    expect(blogPostModel.find).not.toHaveBeenCalled();
  });

  it('a store is capped at 50 pages and 500 posts, and a page at ~60KB', async () => {
    const pages: any = Object.create(StorePagesService.prototype);
    jest.spyOn(require('./store-ownership.util') as any, 'verifyStoreOwnershipStrict').mockResolvedValue(undefined);
    pages.databaseService = { repositories: { storeModel: storeModel(true), storePageModel: { findOne: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(50) } } };
    await expect(pages.createPage(SID, 's1', { slug: 'new', title: 'T' } as any)).rejects.toThrow(/at most 50 pages/);

    const blog: any = Object.create(StoreBlogService.prototype);
    blog.databaseService = { repositories: { storeModel: storeModel(true), blogPostModel: { findOne: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(500) } } };
    await expect(blog.createPost(SID, 's1', { slug: 'p', title: 'T' } as any)).rejects.toThrow(/at most 500 posts/);
  });

  it('blog DTO: coverImage must be https; tags are bounded', async () => {
    const errs = async (b: object) => (await validate(plainToInstance(UpdateBlogPostDto, b))).map((e) => e.property);
    expect(await errs({ coverImage: 'javascript:alert(1)' })).toContain('coverImage');
    expect(await errs({ coverImage: 'https://cdn.example/x.png' })).not.toContain('coverImage');
    expect(await errs({ tags: Array.from({ length: 21 }, () => 't') })).toContain('tags');
    expect(await errs({ tags: [{ a: 1 }] })).toContain('tags');
  });
});

describe('legacy builderConfig', () => {
  it('assertSafePublicJson: size, depth, long strings, dangerous schemes and operator/proto keys', () => {
    expect(() => assertSafePublicJson({ a: 'x'.repeat(70_000) }, 'builderConfig')).toThrow(/too large/);
    expect(() => assertSafePublicJson({ a: 'x'.repeat(2001) }, 'builderConfig')).toThrow(/too long/);
    let deep: any = 'x'; for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(() => assertSafePublicJson(deep, 'builderConfig')).toThrow(/nested too deeply/);
    expect(() => assertSafePublicJson({ link: 'javascript:alert(1)' }, 'builderConfig')).toThrow(/not allowed/);
    expect(() => assertSafePublicJson({ link: ' DATA:text/html,x' }, 'builderConfig')).toThrow(/not allowed/);
    expect(() => assertSafePublicJson(JSON.parse('{"__proto__": {"x":1}}'), 'builderConfig')).toThrow(/key that is not allowed/);
    expect(() => assertSafePublicJson({ $where: 'x' }, 'builderConfig')).toThrow(/key that is not allowed/);
    expect(() => assertSafePublicJson({ title: 'Hello', items: [{ url: 'https://ok.example' }] }, 'builderConfig')).not.toThrow();
  });

  it('saveBuilderConfig refuses a suspended store and a javascript: cover image', async () => {
    const svc: any = Object.create(StoreService.prototype);
    const findOne = jest.fn().mockResolvedValue({ sellerId: 's1', status: 'suspended' });
    svc.databaseService = { repositories: { storeModel: { findOne, findByIdAndUpdate: jest.fn() } } };
    await expect(svc.saveBuilderConfig('s1', { storeId: SID, builderConfig: { a: 1 } })).rejects.toThrow(/suspended/);
    findOne.mockResolvedValue({ sellerId: 's1', status: 'active' });
    await expect(svc.saveBuilderConfig('s1', { storeId: SID, builderConfig: { a: 1 }, coverImage: 'javascript:x' })).rejects.toThrow(/https URL/);
  });
});

describe('section settings validator', () => {
  it('text fields must be text (objects / arrays / numbers were stored verbatim) and free of control characters', () => {
    expect(() => validateSectionSettings('hero' as any, { heading: { $ne: 1 } })).toThrow(/must be text/);
    expect(() => validateSectionSettings('hero' as any, { heading: ['a'] })).toThrow(/must be text/);
    expect(() => validateSectionSettings('hero' as any, { heading: 'a\u0000b' })).toThrow(/not allowed/);
    expect(() => validateSectionSettings('hero' as any, { heading: 'Welcome' })).not.toThrow();
  });
});

describe('AI output → product', () => {
  it('markup is stripped, lengths bounded, tags de-duplicated and capped', () => {
    expect(cleanAiText('<script>alert(1)</script>Great <b>worksheet</b>', 200)).toBe('alert(1) Great worksheet');
    expect(cleanAiText('x'.repeat(500), 200)!.length).toBe(200);
    expect(cleanAiText({ evil: 1 }, 200)).toBeNull();
    expect(cleanAiTags(['Math', 'math', ' <i>Algebra</i> ', { tag: 'Grade 5' }, 5, ''])).toEqual(['Math', 'Algebra', 'Grade 5']);
    expect(cleanAiTags(Array.from({ length: 50 }, (_, i) => `t${i}`))!.length).toBe(20);
    expect(cleanAiTags('nope')).toBeNull();
  });
});
