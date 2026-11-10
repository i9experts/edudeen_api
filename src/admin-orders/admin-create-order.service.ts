/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AddressService } from '../address/address.service';
import { CheckoutService } from '../checkout/checkout.service';
import { PaymentService } from '../payment/payment.service';
import { escapeRegex } from '../common/query-safety.util';
import { CreateManualOrderDto } from './dto/manual-order.dto';

/**
 * Lets an admin place an order on a buyer's behalf (a phone/WhatsApp order, an
 * offline sale being recorded, a goodwill replacement) without the buyer going
 * through checkout themselves. Deliberately thin: it drives the SAME
 * `createCheckout` -> `codPayment`/`freeCheckout` pipeline a real buyer's
 * checkout uses (same pricing, stock, coupon/gift-card, commission and
 * notification side effects) rather than writing an Order document directly —
 * `CheckoutService`/`PaymentService`/`AddressService` take a plain `userId`
 * already, so the admin simply calls them with the chosen buyer's id.
 *
 * v1 scope: one existing buyer account, one product/variant line (via
 * `buyNow`, so the buyer's own cart is never touched), Cash on Delivery or a
 * genuinely free ($0) item. A priced digital item has no "already paid"
 * path yet (no Stripe/manual-transfer collection from here) — see the error
 * thrown below.
 */
@Injectable()
export class AdminCreateOrderService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly addressService: AddressService,
    private readonly checkoutService: CheckoutService,
    private readonly paymentService: PaymentService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Active products (any store) matching `q` by name, with their active, in-stock-eligible variants. */
  async searchProducts(q?: string) {
    const query = (q ?? '').trim();
    if (query.length < 2) return { success: true, data: { items: [] } };

    const { productModel, productVariantModel, storeModel } = this.r;
    const rx = new RegExp(escapeRegex(query), 'i');
    const products = await productModel
      .find({ status: 'active', isDelete: false, name: rx })
      .select('name images type storeId')
      .limit(20)
      .lean();
    if (!products.length) return { success: true, data: { items: [] } };

    const storeIds = [...new Set(products.map((p: any) => String(p.storeId)))];
    const productIds = products.map((p: any) => String(p._id));
    const [stores, variants] = await Promise.all([
      storeModel.find({ _id: { $in: storeIds }, status: 'active', isDelete: false }).select('name').lean(),
      productVariantModel
        .find({ productId: { $in: productIds }, status: 'active', isDelete: false })
        .select('productId price currency stock unlimitedStock options sku isDefault')
        .lean(),
    ]);
    const storeById = new Map(stores.map((s: any) => [String(s._id), s]));
    const variantsByProduct = new Map<string, any[]>();
    for (const v of variants as any[]) {
      const key = String(v.productId);
      if (!variantsByProduct.has(key)) variantsByProduct.set(key, []);
      variantsByProduct.get(key)!.push(v);
    }

    const items = products
      .filter((p: any) => storeById.has(String(p.storeId)))
      .map((p: any) => ({
        id: String(p._id),
        name: p.name,
        image: p.images?.[0] ?? null,
        type: p.type as 'physical' | 'digital',
        storeId: String(p.storeId),
        storeName: (storeById.get(String(p.storeId)) as any)?.name ?? 'Unknown store',
        variants: (variantsByProduct.get(String(p._id)) ?? []).map((v: any) => ({
          id: String(v._id),
          price: v.price,
          currency: v.currency ?? 'PKR',
          stock: v.stock,
          unlimitedStock: !!v.unlimitedStock,
          options: v.options ?? [],
          sku: v.sku ?? null,
          isDefault: !!v.isDefault,
        })),
      }))
      .filter((p) => p.variants.length > 0);

    return { success: true, data: { items } };
  }

  async create(adminId: string, dto: CreateManualOrderDto) {
    const { userModel, productModel, productVariantModel } = this.r;

    const buyer = await userModel.findOne({ _id: dto.buyerId, isDelete: { $ne: true } }).select('name email').lean();
    if (!buyer) throw new NotFoundException('Buyer account not found');

    const product = await productModel.findOne({ _id: dto.productId, status: 'active', isDelete: false }).select('name type storeId').lean();
    if (!product) throw new NotFoundException('Product not found or not published');
    const variant = await productVariantModel
      .findOne({ _id: dto.variantId, productId: dto.productId, status: 'active', isDelete: false })
      .select('_id')
      .lean();
    if (!variant) throw new NotFoundException('Variant not found on this product');

    if ((product as any).type === 'physical' && !dto.address) {
      throw new BadRequestException('A shipping address is required for a physical product');
    }

    let addressId: string | undefined;
    if (dto.address) {
      const added = await this.addressService.addAddress(dto.buyerId, dto.address);
      addressId = String((added.data as any)._id);
    }

    const checkoutRes = await this.checkoutService.createCheckout(dto.buyerId, {
      buyNow: { productId: dto.productId, variantId: dto.variantId, quantity: dto.quantity },
      ...(addressId ? { addressId } : {}),
      ...(dto.shippingZoneId ? { shippingZoneId: dto.shippingZoneId } : {}),
    });
    const checkoutId = String((checkoutRes.data.checkout as any)._id);
    const total = checkoutRes.data.summary.totalAmount as number;

    let placeRes: any;
    if (total === 0) {
      placeRes = await this.paymentService.freeCheckout(dto.buyerId, { checkoutId });
    } else if ((product as any).type === 'physical') {
      placeRes = await this.paymentService.codPayment(dto.buyerId, { checkoutId });
    } else {
      throw new BadRequestException(
        "This digital item isn't free, and manual orders can't collect a card or bank-transfer payment yet — only a free digital item or a priced physical item (Cash on Delivery) can be placed this way. Ask the buyer to check out normally for a paid digital item.",
      );
    }

    const order = placeRes.data.orders[0];
    await this.activityLogService.log({
      storeId: (product as any).storeId,
      category: 'orders',
      action: 'manual_order_created',
      description: `Manual order #${order.orderNumber} created for ${(buyer as any).name} — ${dto.reason}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: String(order.orderId),
      targetType: 'order',
    });

    return { success: true, message: placeRes.message, data: { orderId: String(order.orderId), orderNumber: order.orderNumber } };
  }
}
