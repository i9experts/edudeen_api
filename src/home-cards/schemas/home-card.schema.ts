import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HomeCardDocument = HydratedDocument<HomeCard>;

export const HOME_CARD_LAYOUTS = ['grid4', 'single'] as const;
export type HomeCardLayout = (typeof HOME_CARD_LAYOUTS)[number];
export const HOME_CARD_STATUSES = ['active', 'draft'] as const;
export type HomeCardStatus = (typeof HOME_CARD_STATUSES)[number];

@Schema({ _id: false })
export class HomeCardTile {
  @Prop({ type: String, default: '' })
  label: string;

  // Empty = the web falls back to the linked category's photo / illustration.
  @Prop({ type: String, default: '' })
  imageUrl: string;

  // In-site path built by the admin link picker, e.g. "/?category=maths".
  @Prop({ type: String, default: '' })
  link: string;
}
export const HomeCardTileSchema = SchemaFactory.createForClass(HomeCardTile);

/** One Amazon-style card on the home page (title + 4 small tiles, or one large image). Admin adds as many as needed. */
@Schema({ timestamps: true, collection: 'home_cards' })
export class HomeCard {
  _id: string;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ type: String, enum: HOME_CARD_LAYOUTS, default: 'grid4' })
  layout: HomeCardLayout;

  @Prop({ type: [HomeCardTileSchema], default: [] })
  tiles: HomeCardTile[];

  // 'single' layout image.
  @Prop({ type: String, default: '' })
  imageUrl: string;

  // Where the card's "See more" link (and the single image) goes.
  @Prop({ type: String, default: '' })
  link: string;

  @Prop({ type: String, default: '' })
  ctaLabel: string;

  @Prop({ type: String, enum: HOME_CARD_STATUSES, default: 'active' })
  status: HomeCardStatus;

  @Prop({ default: 0 })
  order: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const HomeCardSchema = SchemaFactory.createForClass(HomeCard);
HomeCardSchema.index({ status: 1, order: 1 });