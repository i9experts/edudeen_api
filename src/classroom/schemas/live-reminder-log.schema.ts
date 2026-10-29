/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LiveReminderLogDocument = LiveReminderLog & Document;

/**
 * One row per reminder actually sent. The unique key includes `startsAt`, so moving a class to a new time
 * re-arms every reminder automatically, and the 1-minute cron can never send the same one twice.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class LiveReminderLog {
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: Date, required: true }) startsAt: Date;
  @Prop({ type: String, required: true }) recipientId: string;
  @Prop({ type: Number, required: true }) offsetMinutes: number;
}
export const LiveReminderLogSchema = SchemaFactory.createForClass(LiveReminderLog);
LiveReminderLogSchema.index({ productId: 1, startsAt: 1, recipientId: 1, offsetMinutes: 1 }, { unique: true });
// Rows are only needed while the class can still send reminders.
LiveReminderLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });
