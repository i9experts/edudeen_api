/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Own collection: no change to the User / Product schemas.
/** A child profile a parent/teacher shops for. `educationLevel` uses the same values as Product.educationLevel. */
@Schema({ timestamps: true, collection: 'childprofiles' })
export class ChildProfile {
  @Prop({ type: String, required: true, index: true }) userId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) educationLevel: string;
  /** Free-text label shown to the parent, e.g. "Class 3". */
  @Prop({ type: String, default: '' }) gradeLabel: string;
  @Prop({ type: Number, default: null }) age: number | null;
  @Prop({ type: [String], default: [] }) subjects: string[];
}
export type ChildProfileDocument = ChildProfile & Document;
export const ChildProfileSchema = SchemaFactory.createForClass(ChildProfile);
