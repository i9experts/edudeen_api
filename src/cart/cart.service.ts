import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
import { AddToCartDto } from './dto/add-to-cart.dto';

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

      // 2️⃣ Get variant
      const variant = await variantModel.findById(dto.productVariantId).lean();
      if (!variant || variant.isDelete || variant.productId !== dto.productId) {
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

      const newItem = {
        productId: dto.productId,
        productVariantId: dto.productVariantId,
        name: product.name,
        quantity: dto.quantity || 1,
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
        cart.items[existingIndex].quantity += dto.quantity || 1;
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
        cart.items[itemIndex].quantity += 1;
      } else if (action === 'decrease') {
        if (cart.items[itemIndex].quantity === 1) {
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
            .select('images sellerId')
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

      // Cart items map karo
      const items = cart.items.map((item) => {
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

  // Wishlist is saved per store (the item's own store), but the buyer's
  // main-site wishlist spans every store — so storeId is derived from the
  // product when adding, and optional (= all stores) when reading/removing.
  async addToWishlist(userId: string, requestedStoreId: string | undefined, body: any) {
    try {
      const { productId, productVariantId } = body;
      if (!productId || !productVariantId) {
        throw new BadRequestException('productId and productVariantId are required');
      }
      const productDoc = await this.databaseService.repositories.productModel
        .findById(productId).select('storeId isDelete').lean();
      if (!productDoc || (productDoc as any).isDelete) throw new BadRequestException('Product not found');
      const storeId = (productDoc as any).storeId as string;
      if (requestedStoreId && requestedStoreId !== storeId) {
        throw new BadRequestException('This product is not sold by this store');
      }
      const variantDoc = await this.databaseService.repositories.productVariantModel
        .findById(productVariantId).select('productId').lean();
      if (!variantDoc || (variantDoc as any).productId !== productId) {
        throw new BadRequestException('Product variant not found');
      }

      // 1. check duplicate
      const wishlistItem =
        await this.databaseService.repositories.wishListModel.findOne({
          userId,
          storeId,
          productId,
          productVariantId,
        });

      if (wishlistItem) {
        // 👉 product + variant fetch
        const product =
          await this.databaseService.repositories.productModel.findById(
            productId,
          );
        const variant =
          await this.databaseService.repositories.productVariantModel.findById(
            productVariantId,
          );

        return {
          message: 'Product already in wishlist',
          data: {
            wishlist: wishlistItem,
            product,
            variant,
          },
        };
      }

      // 2. create wishlist — guarded by a unique index on
      // {userId, storeId, productId, productVariantId} for the race window
      // between the findOne check above and this create() (e.g. a
      // double-tap firing two near-simultaneous requests)
      let newItem;
      try {
        newItem = await this.databaseService.repositories.wishListModel.create(
          { userId, storeId, productId, productVariantId },
        );
      } catch (err: any) {
        if (err?.code === 11000) {
          const existing =
            await this.databaseService.repositories.wishListModel.findOne({
              userId,
              storeId,
              productId,
              productVariantId,
            });
          const product =
            await this.databaseService.repositories.productModel.findById(
              productId,
            );
          const variant =
            await this.databaseService.repositories.productVariantModel.findById(
              productVariantId,
            );
          return {
            message: 'Product already in wishlist',
            data: { wishlist: existing, product, variant },
          };
        }
        throw err;
      }

      await this.databaseService.repositories.productModel.findByIdAndUpdate(
        productId,
        {
          $inc: { wishlistCount: 1 },
          lastWishlistedAt: new Date(),
        },
      );

      // 3. fetch product + variant
      const product =
        await this.databaseService.repositories.productModel.findById(
          productId,
        );
      const variant =
        await this.databaseService.repositories.productVariantModel.findById(
          productVariantId,
        );

      // 4. final response
      return {
        message: 'Product added to wishlist successfully',
        data: {
          wishlist: newItem,
          product,
          variant,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to add to wishlist',
      );
    }
  }

  async getWishlist(userId: string, storeId?: string) {
    try {
      // 1️⃣ User wishlist lao (one store, or every store on the main site)
      const wishlist = await this.databaseService.repositories.wishListModel
        .find({
          userId: userId,
          ...(storeId ? { storeId } : {}),
        })
        .sort({ createdAt: -1 });

      // Final grouped array
      const groupedWishlist: any[] = [];

      // 2️⃣ Loop chalao
      for (const item of wishlist) {
        // Product find karo
        const product =
          await this.databaseService.repositories.productModel.findById(
            item.productId,
          );

        // Variant find karo
        const variant =
          await this.databaseService.repositories.productVariantModel.findById(
            item.productVariantId,
          );

        // Agar product nahi mila
        if (!product) {
          continue;
        }

        // 3️⃣ Check karo product pehle se groupedWishlist me hai ya nahi
        const existingProduct = groupedWishlist.find(
          (data) => data.product._id.toString() === product._id.toString(),
        );

        // 4️⃣ Agar product already mojood hai
        if (existingProduct) {
          // Variant push karo
          if (variant) {
            existingProduct.variants.push(variant);
          }
        } else {
          // 5️⃣ Naya product add karo
          groupedWishlist.push({
            product: product,
            variants: variant ? [variant] : [],
          });
        }
      }

      return {
        message: 'Wishlist fetched successfully',
        data: groupedWishlist,
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to fetch wishlist',
      );
    }
  }

  async getWishlistItem(userId: string, storeId: string | undefined, query: any) {
    try {
      const { productId, productVariantId } = query;

      // 1. wishlist document find
      const wishlistItem =
        await this.databaseService.repositories.wishListModel.findOne({
          userId,
          ...(storeId ? { storeId } : {}),
          productId,
          productVariantId,
        });

      if (!wishlistItem) {
        return {
          message: 'Wishlist item not found',
          data: null,
        };
      }

      // 2. product fetch
      const product =
        await this.databaseService.repositories.productModel.findById(
          productId,
        );

      // 3. variant fetch
      const variant =
        await this.databaseService.repositories.productVariantModel.findById(
          productVariantId,
        );

      return {
        message: 'Wishlist item fetched successfully',
        data: {
          wishlist: wishlistItem,
          product,
          variant,
        },
      };
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Failed to fetch wishlist item',
      );
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
