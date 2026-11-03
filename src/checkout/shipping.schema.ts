/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ShippingZoneDocument = ShippingZone & Document;

@Schema({ timestamps: true })
export class ShippingZone {

  // country name
  @Prop({ required: true })
  country: string;

  // province / state
  @Prop({ type: String, default: null })
  province: string | null;

  // city
  @Prop({ type: String, default: null })
  city: string | null;

  // shipping charges
  @Prop({ required: true, default: 0 })
  shippingPrice: number;

  // estimated delivery time
  // example: 3-5 Days
  @Prop({ type: String, default: null })
  estimatedDeliveryTime: string;

  
  // shipping active/inactive
  @Prop({
    enum: ['active', 'inactive'],
    default: 'active',
  })
  status: string;

  // soft delete
  @Prop({ default: false })
  isDelete: boolean;

}

export const ShippingZoneSchema =
  SchemaFactory.createForClass(ShippingZone);

/** One document (key 'default'): the admin's weight-based delivery rate table (see shipping-rate.util.ts). */
@Schema({ timestamps: true, collection: 'shipping_rate_tables' })
export class ShippingRateTable {
  @Prop({ required: true, unique: true, default: 'default' })
  key: string;

  @Prop({ type: Object, default: {} })
  table: Record<string, any>;

  // Admin courier settings (courier-settings.util.ts): which couriers sellers may pick, live-rate switch, markup.
  @Prop({ type: Object, default: null })
  couriers: Record<string, any> | null;
}
export type ShippingRateTableDocument = ShippingRateTable & Document;
export const ShippingRateTableSchema = SchemaFactory.createForClass(ShippingRateTable);

// indexes
ShippingZoneSchema.index({ country: 1 });
ShippingZoneSchema.index({ province: 1 });
ShippingZoneSchema.index({ city: 1 });