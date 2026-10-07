/* eslint-disable prettier/prettier */
import { isValidObjectId } from 'mongoose';
import { sanitizeDigitalForPublicView } from 'src/products/product-public-view.util';
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
import { AddToCartDto, MAX_CART_LINE_QUANTITY } from './dto/add-to-cart.dto';

/** Per-user cap so a wishlist can't grow without bound. */
const MAX_WISHLIST_ITEMS = 200;

@Injectable()
export class CartService {
  constructor(private readonly databaseService: DatabaseService) {}

  async addToCart(userId: string, requestedStoreId: string | undefined, dto: AddToCartDto) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;
      const productModel = this.databaseService.repositories.productModel;
      const variantModel =
        this.databaseService.repositories.productVariantModel;

      // 1️⃣ Get product
      const product = await productModel.findById(dto.productId).lean();
      if (!product || product.isDelete || product.status !== 'active') {
        throw new BadRequestException('Product not found');
      }

      // The cart always belongs to the product's own store — a storefront
      // may only add its own products, and the main marketplace site
      // (no storeId) files each item under whichever store sells it.
      const storeId = product.storeId;
      if (requestedStoreId && requestedStoreId !== storeId) {
        throw new BadRequestException('This product is not sold by this store');
      }
      // Items of a pending/suspended store can't be added (checkout refuses them anyway, but they used to sit in carts).
      const storeLive = await this.databaseService.repositories.storeModel.exists({ _id: storeId, status: 'active', isDelete: false });
      if (!storeLive) throw new BadRequestException('Product not found');

      // 2️⃣ Get variant
      const variant = await variantModel.findById(dto.productVariantId).lean();
      if (!variant || variant.isDelete || variant.status !== 'active' || variant.productId !== dto.productId) {
        throw new BadRequestException('Product variant not found');
      }

      // 3️⃣ find cart — scoped to this store, so the same buyer's cart on a
      // different store's subdomain is a separate document
      let cart = await cartModel.findOne({ userId, storeId, isDelete: false });

      // 4️⃣ prepare cart item
      // Variant images are optional overrides — most variants have none, so
      // fall back to the product's images or the cart renders imageless items.
      const itemImages =
        variant.images && variant.images.length > 0
          ? variant.images
          : product.images || [];

      // Service-level guard as well as the DTO: a zero, negative or
      // fractional quantity would flow straight into checkout totals.
      const quantity = dto.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CART_LINE_QUANTITY) {
        throw new BadRequestException(`Quantity must be a whole number between 1 and ${MAX_CART_LINE_QUANTITY}`);
      }

      const newItem = {
        productId: dto.productId,
        productVariantId: dto.productVariantId,
        name: product.name,
        quantity,
        price: variant.price,
        currency: variant.currency ?? null,
        images: itemImages,
        options: variant.options ?? [],
      };

      // 5️⃣ create cart if not exists
      if (!cart) {
        cart = await cartModel.create({
          userId,
          storeId,
          items: [newItem],
        });

        return {
          message: 'Cart created and item added successfully',
          data: cart,
        };
      }

      // 6️⃣ check existing item
      const existingIndex = cart.items.findIndex(
        (item) =>
          item.productId === dto.productId &&
          item.productVariantId === dto.productVariantId,
      );

      if (existingIndex > -1) {
        const merged = cart.items[existingIndex].quantity + quantity;
        if (merged > MAX_CART_LINE_QUANTITY) {
          throw new BadRequestException(`Quantity cannot exceed ${MAX_CART_LINE_QUANTITY}`);
        }
        cart.items[existingIndex].quantity = merged;
      } else {
        cart.items.push(newItem as any);
      }

      // 7️⃣ save cart
      await cart.save();

      return {
        message: 'Product added to cart successfully',
        data: cart,
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to add product to cart',
      );
    }
  }

  async updateCartQuantity(userId: string, storeId: string, requestBody: any) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;

      const { productId, productVariantId, action } = requestBody;

      const cart = await cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      if (!cart) {
        throw new BadRequestException('Cart not found');
      }

      const itemIndex = cart.items.findIndex(
        (item) =>
          item.productId === productId &&
          item.productVariantId === productVariantId,
      );

      if (itemIndex === -1) {
        throw new BadRequestException('Item not found in cart');
      }

      // 1️⃣ update quantity
      if (action === 'increase') {
        if (cart.items[itemIndex].quantity >= MAX_CART_LINE_QUANTITY) {
          throw new BadRequestException(`Quantity cannot exceed ${MAX_CART_LINE_QUANTITY}`);
        }
        cart.items[itemIndex].quantity += 1;
      } else if (action === 'decrease') {
        if (cart.items[itemIndex].quantity <= 1) {
          throw new BadRequestException('Quantity cannot be less than 1');
        }
        cart.items[itemIndex].quantity -= 1;
      } else {
        throw new BadRequestException('Invalid action');
      }

      await cart.save();

      // 2️⃣ sirf updated item return karo
      const updatedItem = cart.items[itemIndex];

      return {
        message: 'Cart quantity updated successfully',
        data: updatedItem,
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to update quantity',
      );
    }
  }
  async getCart(userId: string, storeId: string) {
    try {
      // User ka cart find karo (is store ke liye)
      const cart = await this.databaseService.repositories.cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      // Agar cart nahi mila
      if (!cart) {
        return {
          message: 'Cart is empty',
          data: {
            userId,
            storeId,
            items: [],
            totalItems: 0,
            totalPrice: 0,
          },
        };
      }

      let totalItems = 0;
      let totalPrice = 0;

      // Cart items only snapshot name/price/images — sellerId isn't stored on
      // the item, so every item's product doc is batch-fetched (also backfills
      // `images` for items stored before the add-to-cart image fallback existed).
      const productIds = [
        ...new Set(cart.items.map((item: any) => item.productId)),
      ];
      const products = productIds.length
        ? await this.databaseService.repositories.productModel
            .find({ _id: { $in: productIds } })
            .select('images sellerId status isDelete')
            .lean()
        : [];
      const productById = new Map(
        (products as any[]).map((p) => [p._id.toString(), p]),
      );

      const sellerIds = [
        ...new Set(
          (products as any[]).map((p) => p.sellerId).filter(Boolean),
        ),
      ];
      const sellers = sellerIds.length
        ? await this.databaseService.repositories.sellerModel
            .find({ _id: { $in: sellerIds } })
            .select('name isVerified')
            .lean()
        : [];
      const sellerMap = new Map(
        sellers.map((s: any) => [s._id.toString(), s]),
      );

      // A listing an admin removed (or that is no longer active) must not stay in the cart, priced and counted.
      const liveItems = cart.items.filter((item: any) => {
        const p = productById.get(item.productId);
        return !!p && !p.isDelete && p.status === 'active';
      });

      // Cart items map karo
      const items = liveItems.map((item) => {
        // Ek item ka total
        const itemTotal = item.price * item.quantity;

        // Overall totals me add karo
        totalItems += item.quantity;
        totalPrice += itemTotal;

        const product = productById.get(item.productId);
        const seller = product
          ? sellerMap.get(product.sellerId?.toString())
          : undefined;

        const images =
          item.images && item.images.length > 0
            ? item.images
            : product?.images || [];

        return {
          productId: item.productId,
          productVariantId: item.productVariantId,

          name: item.name,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,

          image: images,
          options: (item as any).options ?? [],

          unitPrice: item.price, // single product price
          quantity: item.quantity, // quantity
          itemTotal: itemTotal, // quantity × price
        };
      });

      // Final response
      return {
        message: 'Cart fetched successfully',
        data: {
          userId,
          storeId,
          items,
          totalItems,
          totalPrice,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch cart');
    }
  }

  /** Every non-empty cart the buyer has, one per store — the main
   *  marketplace site shows them together and checks out one store at a
   *  time (checkout is per store). */
  async getMyCarts(userId: string) {
    const carts = await this.databaseService.repositories.cartModel
      .find({ userId, isDelete: false, 'items.0': { $exists: true } })
      .select('storeId')
      .sort({ updatedAt: -1 })
      .lean();
    const storeIds = [...new Set((carts as any[]).map((c) => c.storeId).filter(Boolean))];
    if (storeIds.length === 0) return { message: 'Cart is empty', data: [] };

    const stores = await this.databaseService.repositories.storeModel
      .find({ _id: { $in: storeIds }, isDelete: false })
      .select('name slug logo status')
      .lean();
    const storeById = new Map((stores as any[]).map((s) => [s._id.toString(), s]));

    const data: any[] = [];
    for (const storeId of storeIds) {
      const store = storeById.get(storeId);
      if (!store) continue;
      const { data: cart } = await this.getCart(userId, storeId);
      data.push({
        ...cart,
        store: { storeId, name: store.name, slug: store.slug, logo: store.logo ?? null, isActive: store.status === 'active' },
      });
    }
    return { message: 'Carts fetched successfully', data };
  }

  async removeCartItem(userId: string, storeId: string, requestBody: any) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;

      const { productId, productVariantId } = requestBody;

      const cart = await cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      if (!cart) {
        throw new BadRequestException('Cart not found');
      }

      // 1️⃣ find item index
      const itemIndex = cart.items.findIndex(
        (item) =>
          item.productId === productId &&
          item.productVariantId === productVariantId,
      );

      if (itemIndex === -1) {
        throw new BadRequestException('Item not found in cart');
      }

      // 2️⃣ remove item
      cart.items.splice(itemIndex, 1);

      // 3️⃣ save cart
      await cart.save();

      return {
        message: 'Item removed from cart successfully',
        data: cart.items, // sirf updated cart items return
      };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to remove item');
    }
  }

  async clearCart(userId: string, storeId: string) {
    try {
      const cartModel = this.databaseService.repositories.cartModel;

      const cart = await cartModel.findOne({
        userId,
        storeId,
        isDelete: false,
      });

      if (!cart) {
        throw new BadRequestException('Cart not found');
      }

      // 🗑️ sare cart items remove
      cart.items = [];

      await cart.save();

      return {
        message: 'Cart cleared successfully',
        data: cart.items,
      };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to clear cart');
    }
  }

  /** The product exactly as a public browser may see it: live product, live store, no private digital data.
   *  (The wishlist used to return raw `findById` documents — file manifests and delivery messages included —
   *  for drafts, deleted and admin-removed products alike.) */
  private async loadViewableProduct(productId: string) {
    if (typeof productId !== 'string' || !isValidObjectId(productId)) return null;
    const { productModel, storeModel } = this.databaseService.repositories;
    const product = await productModel.findOne({ _id: productId, status: 'active', isDelete: false }).lean();
    if (!product) return null;
    const live = await storeModel.exists({ _id: product.storeId, status: 'active', isDelete: false });
    return live ? sanitizeDigitalForPublicView(product) : null;
  }

  private async loadVariantLean(variantId: string) {
    if (typeof variantId !== 'string' || !isValidObjectId(variantId)) return null;
    return this.databaseService.repositories.productVariantModel.findOne({ _id: variantId, isDelete: false }).lean();
  }

  // Wishlist is saved per store (the item's own store), but the buyer's
  // main-site wishlist spans every store — so storeId is taken from the
  // product when adding, and optional (= all stores) when reading/removing.
  async addToWishlist(userId: string, storeId: string | undefined, body: any) {
    try {
      const { productId, productVariantId } = body ?? {};

      // Validate what is being wishlisted: a real, live product; a variant OF that product; and the store is
      // taken from the product (a mismatched client storeId used to slip past the unique index and inflate
      // wishlistCount on any product). Capped per user.
      const product = await this.loadViewableProduct(productId);
      if (!product) throw new BadRequestException('Product not found');
      if (storeId && storeId !== product.storeId) throw new BadRequestException('This product is not sold by this store');
      const variant = await this.loadVariantLean(productVariantId);
      if (!variant || variant.productId !== productId || variant.status !== 'active') {
        throw new BadRequestException('Product variant not found');
      }
      storeId = product.storeId;

      const { wishListModel, productModel } = this.databaseService.repositories;
      const view = () => ({ product, variant });

      const wishlistItem = await wishListModel.findOne({ userId, storeId, productId, productVariantId });
      if (wishlistItem) {
        return { message: 'Product already in wishlist', data: { wishlist: wishlistItem, ...view() } };
      }
      if ((await wishListModel.countDocuments({ userId })) >= MAX_WISHLIST_ITEMS) {
        throw new BadRequestException(`Your wishlist is full (${MAX_WISHLIST_ITEMS} items) — remove something first`);
      }

      // Guarded by a unique index on {userId, storeId, productId, productVariantId} for the race window
      // between the findOne above and this create() (e.g. a double-tap).
      let newItem;
      try {
        newItem = await wishListModel.create({ userId, storeId, productId, productVariantId });
      } catch (err: any) {
        if (err?.code === 11000) {
          const existing = await wishListModel.findOne({ userId, storeId, productId, productVariantId });
          return { message: 'Product already in wishlist', data: { wishlist: existing, ...view() } };
        }
        throw err;
      }

      await productModel.findByIdAndUpdate(productId, { $inc: { wishlistCount: 1 }, lastWishlistedAt: new Date() });

      return { message: 'Product added to wishlist successfully', data: { wishlist: newItem, ...view() } };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to add to wishlist');
    }
  }

  async getWishlist(userId: string, storeId?: string) {
    try {
      // User wishlist — one store, or every store on the main site.
      const wishlist = await this.databaseService.repositories.wishListModel
        .find({ userId, ...(storeId ? { storeId } : {}) })
        .sort({ createdAt: -1 })
        .limit(MAX_WISHLIST_ITEMS);

      const groupedWishlist: any[] = [];
      for (const item of wishlist) {
        // Removed / draft / suspended-store products silently drop out instead of being served.
        const product = await this.loadViewableProduct(item.productId);
        if (!product) continue;
        const variant = await this.loadVariantLean(item.productVariantId);

        const existingProduct = groupedWishlist.find((data) => data.product._id.toString() === product._id.toString());
        if (existingProduct) {
          if (variant) existingProduct.variants.push(variant);
        } else {
          groupedWishlist.push({ product, variants: variant ? [variant] : [] });
        }
      }

      return { message: 'Wishlist fetched successfully', data: groupedWishlist };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch wishlist');
    }
  }

  async getWishlistItem(userId: string, storeId: string | undefined, query: any) {
    try {
      const productId = typeof query?.productId === 'string' ? query.productId : undefined;
      const productVariantId = typeof query?.productVariantId === 'string' ? query.productVariantId : undefined;
      if (!productId || !productVariantId) throw new BadRequestException('productId and productVariantId are required');

      const wishlistItem = await this.databaseService.repositories.wishListModel.findOne({
        userId, ...(storeId ? { storeId } : {}), productId, productVariantId,
      });
      if (!wishlistItem) return { message: 'Wishlist item not found', data: null };

      const product = await this.loadViewableProduct(productId);
      const variant = await this.loadVariantLean(productVariantId);
      return { message: 'Wishlist item fetched successfully', data: { wishlist: wishlistItem, product, variant } };
    } catch (error: any) {
      throw new BadRequestException(error.message || 'Failed to fetch wishlist item');
    }
  }

  async removeFromWishlist(userId: string, storeId: string | undefined, wishlistId: string) {
    try {
      // 1. find wishlist item
      const wishlistItem =
        await this.databaseService.repositories.wishListModel.findById(
          wishlistId,
        );

      if (!wishlistItem) {
        throw new BadRequestException('Wishlist item not found');
      }
      if (wishlistItem.userId !== userId || (storeId && wishlistItem.storeId !== storeId)) {
        throw new ForbiddenException('Access denied');
      }

      // 2. delete wishlist item
      await this.databaseService.repositories.wishListModel.findByIdAndDelete(
        wishlistId,
      );

      // 3. decrease wishlist count in product
      await this.databaseService.repositories.productModel.findByIdAndUpdate(
        wishlistItem.productId,
        {
          $inc: { wishlistCount: -1 },
        },
      );

      return {
        message: 'Product removed from wishlist successfully',
        data: {
          removedWishlistId: wishlistId,
          productId: wishlistItem.productId,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to remove from wishlist',
      );
    }
  }

  async clearWishlist(userId: string, storeId?: string) {
    try {
      const wishlistModel = this.databaseService.repositories.wishListModel;
      const scope = { userId, ...(storeId ? { storeId } : {}) };

      // 🔍 check if user has any wishlist items (in this store, or anywhere)
      const wishlistItems = await wishlistModel.find(scope);

      if (!wishlistItems.length) {
        throw new BadRequestException('Wishlist is already empty');
      }

      // 🗑️ delete all wishlist items of this user (in this store, or anywhere)
      await wishlistModel.deleteMany(scope);

      // 📉 update wishlist count in all related products
      const productModel = this.databaseService.repositories.productModel;

      for (const item of wishlistItems) {
        await productModel.findByIdAndUpdate(item.productId, {
          $inc: { wishlistCount: -1 },
        });
      }

      return {
        message: 'Wishlist cleared successfully',
        data: {
          deletedCount: wishlistItems.length,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to clear wishlist',
      );
    }
  }
}
