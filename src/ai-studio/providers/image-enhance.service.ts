/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProviderError, ImageEnhanceAdapter, ImageEnhanceRequest, ImageEnhanceResult, ImageEnhancementType,
} from './ai-provider.interfaces';

/**
 * Image Enhancer provider selection (same pattern as TextGenerationService / PaymentGatewayService).
 *
 *  - CLOUDINARY_AI_ENABLED=true (+ CLOUDINARY_CLOUD_NAME) -> CloudinaryImageEnhanceProvider: uses Cloudinary's own
 *    on-the-fly transformations (e_upscale, e_improve, e_background_removal). Some of these are Cloudinary add-ons that
 *    must be enabled on the Cloudinary account; Cloudinary answers an error status if not, which we surface cleanly.
 *  - anything else -> UnavailableImageEnhanceProvider: the tool reports "not available" and NEVER charges credits.
 *
 * Claude cannot edit images; it is only used for the alt-text / photo-quality check (image_check).
 * To plug another vendor (Replicate, ...): implement ImageEnhanceAdapter and add it to the switch in the constructor.
 */

export const IMAGE_ENHANCE_TRANSFORMS: Record<ImageEnhancementType, string> = {
  upscale: 'e_upscale',
  denoise: 'e_improve',
  background_cleanup: 'e_background_removal',
};

/** Pure: insert the enhancement transformation after `/image/upload/`. Returns null when the URL is not one of our Cloudinary uploads. */
export function buildCloudinaryEnhanceUrl(imageUrl: string, type: ImageEnhancementType, cloudName: string): string | null {
  let u: URL;
  try { u = new URL(imageUrl); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com' || !cloudName) return null;
  const marker = `/${cloudName}/image/upload/`;
  const idx = u.pathname.indexOf(marker);
  if (idx !== 0) return null;
  const transform = IMAGE_ENHANCE_TRANSFORMS[type];
  if (!transform) return null;
  const rest = u.pathname.slice(marker.length);
  return `https://res.cloudinary.com${marker}${transform}/${rest}${u.search}`;
}

type FetchLike = (url: string, init?: any) => Promise<{ status: number; ok: boolean }>;

export class CloudinaryImageEnhanceProvider implements ImageEnhanceAdapter {
  readonly name = 'cloudinary';

  constructor(
    private readonly cloudName: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly maxPolls = 8,
  ) {}

  async enhance(request: ImageEnhanceRequest): Promise<ImageEnhanceResult> {
    const url = buildCloudinaryEnhanceUrl(request.imageUrl, request.enhancementType, this.cloudName);
    if (!url) {
      throw new AiProviderError('Only images uploaded to Edudeen can be enhanced. Upload the photo first, then try again.', { retryable: false, provider: this.name });
    }
    // Cloudinary builds the derived image lazily; AI effects answer 423 until ready.
    for (let attempt = 0; attempt < this.maxPolls; attempt++) {
      let status = 0;
      try { status = (await this.fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })).status; } catch { status = 0; }
      if (status === 200 || status === 206) {
        return { enhancedImageUrl: url, originalImageUrl: request.imageUrl, provider: this.name, note: `Enhanced with Cloudinary (${IMAGE_ENHANCE_TRANSFORMS[request.enhancementType]}).` };
      }
      if (status === 423 || status === 0 || status >= 500) { await this.sleep(Math.min(4000, 800 * (attempt + 1))); continue; }
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        throw new AiProviderError('This enhancement is not enabled on the image service yet. Please contact support.', { retryable: false, provider: this.name });
      }
      await this.sleep(1000);
    }
    throw new AiProviderError('The image is still being processed. Please try again in a minute.', { retryable: true, provider: this.name });
  }
}

class UnavailableImageEnhanceProvider implements ImageEnhanceAdapter {
  readonly name = 'unavailable';
  async enhance(): Promise<ImageEnhanceResult> {
    throw new AiProviderError('Image enhancement is not available right now.', { retryable: false, provider: this.name });
  }
}

@Injectable()
export class ImageEnhanceService implements ImageEnhanceAdapter, OnModuleInit {
  private readonly logger = new Logger(ImageEnhanceService.name);
  private readonly provider: ImageEnhanceAdapter;
  readonly providerName: string;

  constructor(config: ConfigService) {
    const flag = String(config.get<string>('CLOUDINARY_AI_ENABLED') ?? '').toLowerCase() === 'true';
    const cloud = config.get<string>('CLOUDINARY_CLOUD_NAME') ?? '';
    this.provider = flag && cloud ? new CloudinaryImageEnhanceProvider(cloud) : new UnavailableImageEnhanceProvider();
    this.providerName = this.provider.name;
  }

  /** True only when a real provider is configured (the Studio disables the tool otherwise). */
  get available(): boolean {
    return this.provider.name !== 'unavailable';
  }

  get name(): string {
    return this.provider.name;
  }

  onModuleInit() {
    if (!this.available) {
      this.logger.warn('Image Enhancer is OFF (set CLOUDINARY_AI_ENABLED=true to use Cloudinary AI transformations).');
    }
  }

  enhance(request: ImageEnhanceRequest): Promise<ImageEnhanceResult> {
    return this.provider.enhance(request);
  }
}
