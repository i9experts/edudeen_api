// Backend-fixed defaults for digital product previews — not seller-configurable,
// to keep the seller-facing config surface (DigitalPreview) minimal.
export const PREVIEW_PDF_PAGE_COUNT = 3;
export const PREVIEW_CLIP_SECONDS = 30;
export const PREVIEW_IMAGE_MAX_WIDTH = 1000;
export const PREVIEW_WATERMARK_TEXT = 'EDUDEEN PREVIEW';
export const PREVIEW_URL_TTL_SECONDS = 300; // 5 min
export const PREVIEW_RATE_LIMIT_MAX = 20;
export const PREVIEW_RATE_LIMIT_WINDOW_SECONDS = 3600;
export const PREVIEW_SOURCE_FOLDER = 'private/digital-preview-sources';
