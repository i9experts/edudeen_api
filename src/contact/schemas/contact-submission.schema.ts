import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ContactSubmissionDocument = HydratedDocument<ContactSubmission>;

export type ContactSubmissionStatus = 'new' | 'read' | 'resolved';

@Schema({ timestamps: true })
export class ContactSubmission {
  _id: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, trim: true, lowercase: true })
  email: string;

  @Prop({ required: true, trim: true })
  topic: string;

  @Prop({ required: true, trim: true })
  message: string;

  @Prop({ enum: ['new', 'read', 'resolved'], default: 'new' })
  status: ContactSubmissionStatus;

  // Edudeen Premium priority support: the sender's email belongs to an active premium member.
  @Prop({ type: Boolean, default: false })
  priority: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ContactSubmissionSchema =
  SchemaFactory.createForClass(ContactSubmission);

ContactSubmissionSchema.index({ status: 1 });
ContactSubmissionSchema.index({ createdAt: -1 });

ContactSubmissionSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
