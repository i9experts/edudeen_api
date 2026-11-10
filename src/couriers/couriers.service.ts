import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { courierDeliveryEnabled, DEFAULT_COURIER_SETTINGS, DELIVERY_COURIER_IDS } from 'src/checkout/courier-settings.util';
import { ShippingRatesService } from 'src/checkout/shipping-rates.service';
import { timingSafeEqual } from 'crypto';
import { DatabaseService } from 'src/database/databaseservice';
import { OrdersService } from 'src/orders/orders.service';
import { parseWeightKg } from 'src/products/price-rules.util';
import { buildCouriers } from './courier.adapters';
import type { CourierAdapter, CourierId, ShipmentInput } from './courier.types';

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Injectable()
export class CouriersService {
  private readonly logger = new Logger(CouriersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ordersService: OrdersService,
    @Optional() private readonly shippingRates?: ShippingRatesService,
  ) {}

  /** Delivery methods a seller may choose, each with a reason when it is not selectable. */
  async deliveryOptions() {
    const settings = this.shippingRates ? await this.shippingRates.getCourierSettings() : DEFAULT_COURIER_SETTINGS;
    const adapters = this.adapters();
    const switchedOn = courierDeliveryEnabled();
    const couriers = DELIVERY_COURIER_IDS.map((id) => {
      const a = adapters.find((x) => x.id === id);
      const configured = !!a?.isConfigured();
      const enabled = settings.enabled[id] === true;
      const available = switchedOn && enabled && configured;
      return {
        id,
        label: a?.label ?? id,
        available,
        reason: available ? null : !switchedOn ? 'Coming soon' : !enabled ? 'Not offered by Edudeen yet' : 'Edudeen has not connected this courier yet',
      };
    });
    const anyCourier = couriers.some((c) => c.available);
    // Read-only hint for the seller Shipping page: is the admin's weight-based table switched on?
    let weightBasedRates = false;
    try { weightBasedRates = (await this.shippingRates?.get?.())?.enabled === true; } catch { weightBasedRates = false; }
    return {
      success: true,
      data: {
        self: { available: true, reason: null },
        couriers,
        auto: { available: anyCourier, reason: anyCourier ? null : switchedOn ? 'No courier is available yet' : 'Coming soon' },
        useLiveRates: settings.useLiveRates,
        weightBasedRates,
      },
    };
  }

  private adapters(): CourierAdapter[] { return buildCouriers(process.env); }
  private adapter(id: string): CourierAdapter | null { return this.adapters().find((c) => c.id === (id as CourierId)) ?? null; }

  /** Couriers a seller can pick. Manual tracking is always available and is not listed here. */
  listCouriers() {
    return { success: true, data: this.adapters().map((c) => ({ id: c.id, label: c.label, configured: c.isConfigured() })) };
  }

  private async loadSellerOrder(sellerId: string, storeId: string, orderId: string) {
    const { orderModel, storeModel } = this.db.repositories;
    const store: any = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id deliveryMethod').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const idx = order.sellerOrders.findIndex((so: any) => so.storeId === storeId && so.sellerId === sellerId);
    if (idx === -1) throw new ForbiddenException('Unauthorized');
    return { order, idx, so: order.sellerOrders[idx], store };
  }

  /**
   * The courier this package must be booked with, or null when the seller is free to choose.
   * Store method 'self'/none = free choice. A specific courier (or 'auto' that already priced a courier) locks it.
   */
  requiredCourier(store: { deliveryMethod?: string | null } | null, so: any): CourierId | null {
    const m = courierDeliveryEnabled() ? store?.deliveryMethod : null;
    if (m !== 'tcs' && m !== 'leopards' && m !== 'postex' && m !== 'auto') return null;
    const quoted = so?.shippingCourier?.courier;
    if (quoted === 'tcs' || quoted === 'leopards' || quoted === 'postex') return quoted;
    return m === 'auto' ? null : m;
  }

  /** Books a shipment with the chosen courier and stores the tracking number (order status is NOT changed; the seller still marks it shipped). */
  async createShipment(sellerId: string, body: { orderId?: string; storeId?: string; courier?: string; weightKg?: number }) {
    const { orderId, storeId } = body ?? {};
    if (!orderId || !storeId) throw new BadRequestException('orderId and storeId are required');

    const { order, idx, so, store } = await this.loadSellerOrder(sellerId, storeId, orderId);
    // Store method / quoted courier decides the courier; the seller cannot book a different one.
    const required = this.requiredCourier(store, so);
    const courierId = body.courier || required;
    if (!courierId) throw new BadRequestException('orderId, storeId and courier are required');
    if (required && body.courier && body.courier !== required) {
      throw new BadRequestException(`This package was priced for ${this.adapter(required)?.label ?? required}, so it must be booked with that courier`);
    }
    const adapter = this.adapter(courierId);
    if (!adapter || !adapter.isConfigured()) throw new BadRequestException('This courier is not set up yet');
    if (so.fulfillmentType === 'digital') throw new BadRequestException('Digital orders are not shipped');
    if (!['pending', 'processing'].includes(so.status)) throw new BadRequestException(`This order is already ${so.status}`);
    if (so.shipment?.trackingNumber) throw new BadRequestException('A shipment is already booked for this order');
    const a = order.shippingAddress;
    if (!a?.addressLine1 || !a?.city || !a?.phoneNumber) throw new BadRequestException('The delivery address is incomplete');

    // Per-package paid state wins on a multi-seller COD order (this package may already be collected).
    const isCod = order.paymentType === 'cash_on_delivery' && !order.isPaid && so.isPaid !== true;
    if (isCod && order.currency !== 'PKR') throw new BadRequestException('Cash on delivery bookings need a PKR order');
    // One seller on the order: the buyer pays the whole total (incl. shipping) at the door; otherwise only this store's items.
    // A multi-seller order stores each package's amount (items + its own shipping); older orders fall back to the subtotal.
    const codAmount = isCod
      ? Math.round(order.sellerOrders.length === 1 ? order.totalAmount : (so.codAmount > 0 ? so.codAmount : so.subtotal))
      : 0;
    let weight = Number(body.weightKg);
    if (!(Number.isFinite(weight) && weight > 0 && weight <= 100)) {
      // Seller left the weight blank: use the products' own weights (same rule checkout uses) before falling back to 0.5 kg.
      const ids = [...new Set((so.items ?? []).map((i: any) => String(i.variantId)).filter((v: string) => v && v !== 'null' && v !== 'undefined'))] as string[];
      const variants: any[] = ids.length ? await this.db.repositories.productVariantModel.find({ _id: { $in: ids } }).select('shippingWeight').lean() : [];
      const byId = new Map(variants.map((v) => [String(v._id), v]));
      const sum = (so.items ?? []).reduce((n: number, i: any) => n + (parseWeightKg(byId.get(String(i.variantId))?.shippingWeight) ?? 0) * (i.quantity || 1), 0);
      weight = sum > 0 ? Math.round(sum * 1000) / 1000 : 0;
    }
    const input: ShipmentInput = {
      orderRef: String(order.orderNumber ?? order._id),
      consignee: {
        name: a.recipientName,
        phone: a.phoneNumber,
        address: [a.addressLine1, a.addressLine2].filter(Boolean).join(', '),
        city: a.city,
      },
      pieces: Math.max(1, so.items.reduce((n: number, i: any) => n + (i.quantity || 1), 0)),
      weightKg: weight > 0 ? weight : 0.5,
      codAmount,
      description: so.items.map((i: any) => i.name).join(', ').slice(0, 150),
      remarks: `Edudeen order ${order.orderNumber ?? ''}`.trim(),
    };

    const res = await adapter.createShipment(input);
    if (!res.ok || !res.trackingNumber) {
      this.logger.warn(`Courier booking failed (${adapter.id}) for order ${orderId}: ${res.error}`);
      throw new BadRequestException(`${adapter.label} could not book this shipment: ${res.error ?? 'unknown error'}`);
    }

    const trackingUrl = res.trackingUrl ?? adapter.trackingUrl(res.trackingNumber);
    await this.db.repositories.orderModel.updateOne(
      { _id: orderId },
      {
        $set: {
          [`sellerOrders.${idx}.shipment`]: { courier: adapter.id, trackingNumber: res.trackingNumber, labelUrl: res.labelUrl ?? null, bookedAt: new Date() },
          [`sellerOrders.${idx}.tracking`]: { carrier: adapter.label, trackingNumber: res.trackingNumber, trackingUrl },
        },
        $push: { [`sellerOrders.${idx}.trackingEvents`]: { status: 'booked', description: `Booked with ${adapter.label}`, location: null, at: new Date(), source: 'seller' } },
      },
    );
    return { success: true, data: { courier: adapter.id, carrier: adapter.label, trackingNumber: res.trackingNumber, trackingUrl, labelUrl: res.labelUrl ?? null, codAmount } };
  }

  async getLabel(sellerId: string, storeId: string, orderId: string) {
    const { so } = await this.loadSellerOrder(sellerId, storeId, orderId);
    if (!so.shipment?.trackingNumber) throw new NotFoundException('No courier shipment for this order');
    return { success: true, data: { trackingNumber: so.shipment.trackingNumber, courier: so.shipment.courier, labelUrl: so.shipment.labelUrl ?? null } };
  }

  /** Courier status webhook. Authenticated by a per-courier shared secret; with no secret configured it is refused. */
  async handleWebhook(courierId: string, presentedSecret: string | undefined, body: any) {
    const adapter = this.adapter(courierId);
    const secret = adapter?.webhookSecret();
    if (!adapter || !secret) throw new NotFoundException('Webhook not enabled');
    if (!presentedSecret || !safeEqual(presentedSecret, secret)) throw new ForbiddenException('Invalid webhook secret');

    const { orderModel } = this.db.repositories;
    let applied = 0;
    for (const ev of adapter.parseWebhook(body)) {
      const order: any = await orderModel.findOne({ 'sellerOrders.shipment.trackingNumber': ev.trackingNumber, isDelete: false });
      if (!order) continue;
      const idx = order.sellerOrders.findIndex((s: any) => s.shipment?.trackingNumber === ev.trackingNumber);
      const so = order.sellerOrders[idx];
      const dup = (so.trackingEvents ?? []).some((e: any) => e.status === ev.status && new Date(e.at).getTime() === ev.at.getTime());
      if (dup) continue;

      await orderModel.updateOne(
        { _id: order._id },
        { $push: { [`sellerOrders.${idx}.trackingEvents`]: { status: ev.status, description: ev.description, location: ev.location, at: ev.at, source: adapter.id } } },
      );
      applied++;

      // Move the order forward through the normal path (notifications, activity log, ledger rules).
      try {
        const base = { orderId: String(order._id), storeId: so.storeId };
        const early = ['pending', 'processing'].includes(so.status);
        if (['picked_up', 'in_transit', 'out_for_delivery', 'delivered'].includes(ev.status) && early) {
          await this.ordersService.updateSellerOrderStatus(so.sellerId, { ...base, status: 'shipped', tracking: so.tracking ?? { carrier: adapter.label, trackingNumber: ev.trackingNumber } });
        }
        if (ev.status === 'delivered' && ['pending', 'processing', 'shipped'].includes(so.status)) {
          await this.ordersService.updateSellerOrderStatus(so.sellerId, { ...base, status: 'delivered' });
        }
      } catch (e: any) {
        this.logger.warn(`Courier status could not advance order ${order._id}: ${e?.message}`);
      }
    }
    return { success: true, data: { applied } };
  }
}
