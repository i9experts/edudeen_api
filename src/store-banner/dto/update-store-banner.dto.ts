/* eslint-disable prettier/prettier */
import { PartialType } from '@nestjs/swagger';
import { CreateStoreBannerDto } from './create-store-banner.dto';

// Images are replaced by re-uploading, never by supplying a URL/publicId — the update service only reads the
// declared fields of CreateStoreBannerDto.
export class UpdateStoreBannerDto extends PartialType(CreateStoreBannerDto) {}
