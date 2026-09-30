import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';

const errors = async (cls: any, body: object) => (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe('variant DTO bounds', () => {
  it('rejects absurd or non-finite prices (the variants module had no ceiling; products cap at 1,000,000)', async () => {
    expect(await errors(CreateVariantDto, { price: 1e300 })).toContain('price');
    expect(await errors(CreateVariantDto, { price: Infinity })).toContain('price');
    expect(await errors(CreateVariantDto, { price: 10, compareAtPrice: 2_000_000 })).toContain('compareAtPrice');
    expect(await errors(UpdateVariantDto, { price: 1e12 })).toContain('price');
    expect(await errors(CreateVariantDto, { price: 1_000_000 })).not.toContain('price');
  });

  it('stock must be a whole, bounded number (0.5 and 1e9 used to be accepted)', async () => {
    expect(await errors(CreateVariantDto, { price: 1, stock: 0.5 })).toContain('stock');
    expect(await errors(CreateVariantDto, { price: 1, stock: 1_000_001 })).toContain('stock');
    expect(await errors(UpdateVariantDto, { stock: -1 })).toContain('stock');
    expect(await errors(UpdateVariantDto, { stock: 25 })).not.toContain('stock');
  });

  it('sku and images are bounded', async () => {
    expect(await errors(CreateVariantDto, { price: 1, sku: 'x'.repeat(65) })).toContain('sku');
    expect(await errors(CreateVariantDto, { price: 1, images: Array.from({ length: 21 }, () => 'https://x/y.png') })).toContain('images');
  });
});
