/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { UpdateBlogContentDto } from './dto/update-blog-content.dto';

const CONTENT_BLOCK_TYPES = ['paragraph', 'heading', 'image', 'quote', 'list', 'divider'];
const MAX_CONTENT_BLOCKS = 60;

function validateContent(content: { type: string; settings: Record<string, any> }[]) {
  if (content.length > MAX_CONTENT_BLOCKS) throw new BadRequestException(`A post cannot have more than ${MAX_CONTENT_BLOCKS} content blocks`);
  for (const block of content) {
    if (!CONTENT_BLOCK_TYPES.includes(block.type)) throw new BadRequestException(`Block type "${block.type}" is not allowed in post content`);
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

@Injectable()
export class StoreBlogService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get blogPostModel() {
    return this.databaseService.repositories.blogPostModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  private async findOwnedPost(storeId: string, sellerId: string, postId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const post = await this.blogPostModel.findOne({ _id: postId, storeId, isDelete: false });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const posts = await this.blogPostModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    return { success: true, data: posts };
  }

  async getForSeller(storeId: string, sellerId: string, postId: string) {
    const post = await this.findOwnedPost(storeId, sellerId, postId);
    return { success: true, data: post };
  }

  async createPost(storeId: string, sellerId: string, dto: CreateBlogPostDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const existing = await this.blogPostModel.findOne({ storeId, slug: dto.slug, isDelete: false });
    if (existing) throw new ConflictException(`A post with slug "${dto.slug}" already exists`);

    const post = await this.blogPostModel.create({
      storeId, title: dto.title, slug: dto.slug, excerpt: dto.excerpt ?? '', coverImage: dto.coverImage ?? null,
      content: [], status: 'draft',
    });
    return { success: true, message: 'Post created', data: post };
  }

  async updatePost(storeId: string, sellerId: string, postId: string, dto: UpdateBlogPostDto) {
    const post = await this.findOwnedPost(storeId, sellerId, postId);
    if (dto.slug !== undefined && dto.slug !== post.slug) {
      const conflict = await this.blogPostModel.findOne({ storeId, slug: dto.slug, isDelete: false, _id: { $ne: postId } });
      if (conflict) throw new ConflictException(`A post with slug "${dto.slug}" already exists`);
    }

    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.slug !== undefined) set.slug = dto.slug;
    if (dto.excerpt !== undefined) set.excerpt = dto.excerpt;
    if (dto.coverImage !== undefined) set.coverImage = dto.coverImage;
    if (dto.tags !== undefined) set.tags = dto.tags;

    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: set }, { returnDocument: 'after' });
    return { success: true, message: 'Post updated', data: updated };
  }

  async updateContent(storeId: string, sellerId: string, postId: string, dto: UpdateBlogContentDto) {
    await this.findOwnedPost(storeId, sellerId, postId);
    validateContent(dto.content);
    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: { content: dto.content } }, { returnDocument: 'after' });
    return { success: true, message: 'Content updated', data: updated };
  }

  async publish(storeId: string, sellerId: string, postId: string) {
    const post = await this.findOwnedPost(storeId, sellerId, postId);
    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: { status: 'published', publishedAt: post.publishedAt ?? new Date() } }, { returnDocument: 'after' });
    return { success: true, message: 'Post published', data: updated };
  }

  async unpublish(storeId: string, sellerId: string, postId: string) {
    await this.findOwnedPost(storeId, sellerId, postId);
    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: { status: 'draft' } }, { returnDocument: 'after' });
    return { success: true, message: 'Post unpublished', data: updated };
  }

  async deletePost(storeId: string, sellerId: string, postId: string) {
    await this.findOwnedPost(storeId, sellerId, postId);
    await this.blogPostModel.findByIdAndUpdate(postId, { $set: { isDelete: true } });
    return { success: true, message: 'Post deleted' };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async listPublic(storeId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [posts, total] = await Promise.all([
      this.blogPostModel.find({ storeId, status: 'published', isDelete: false })
        .sort({ publishedAt: -1 }).skip(skip).limit(limit)
        .select('title slug coverImage excerpt tags publishedAt').lean(),
      this.blogPostModel.countDocuments({ storeId, status: 'published', isDelete: false }),
    ]);
    return { success: true, data: { posts, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } } };
  }

  async getPublicBySlug(storeId: string, slug: string) {
    const post = await this.blogPostModel.findOne({ storeId, slug, status: 'published', isDelete: false }).lean();
    if (!post) throw new NotFoundException('Post not found');
    return { success: true, data: post };
  }
}
