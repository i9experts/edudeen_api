import { IsOptional, IsString, IsNumber, IsNotEmpty } from 'class-validator';

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
  @IsNumber()
  quantity?: number;
}
