/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EducationLevelAliasDocument = EducationLevelAlias & Document;

/**
 * Admin-curated synonym map for Tier-2 custom education levels (e.g.
 * "hifz course" / "hifz quran" both -> canonicalSlug "hifz"). No admin CRUD
 * UI exists yet — EducationLevelService seeds this collection with a starter
 * set on boot if it's empty, and reads from it on every normalization pass so
 * an admin UI can manage rows later without any code/deploy change.
 */
@Schema({ timestamps: true })
export class EducationLevelAlias {
  // lowercased/trimmed lookup key, e.g. "hifz course"
  @Prop({ required: true, unique: true })
  matchKey: string;

  @Prop({ required: true })
  canonicalSlug: string;

  @Prop({ required: true })
  canonicalDisplayName: string;

  // null for the boot-seeded starter set — real admin id once an admin UI writes here
  @Prop({ type: String, default: null })
  createdBy: string | null;
}

export const EducationLevelAliasSchema = SchemaFactory.createForClass(EducationLevelAlias);

EducationLevelAliasSchema.index({ canonicalSlug: 1 });
