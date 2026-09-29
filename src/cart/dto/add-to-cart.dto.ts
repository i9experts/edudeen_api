import { IsOptional, IsString, IsInt, Min, Max, IsNotEmpty } from 'class-validator';

export const MAX_CART_LINE_QUANTITY = 1000;

export class AddToCartDto {
  // Which store's cart this goes into — a buyer's cart is scoped per store.
  // Optional: the main marketplace site omits it and the product's own
  // store is used; a store subdomain passes its storeId, which must match.
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  productVariantId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CART_LINE_QUANTITY)
  quantity?: number;
}
