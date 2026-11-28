import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateHomeCardDto, UpdateHomeCardDto } from './dto/home-card.dto';

const errorsOf = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((e) =>
    JSON.stringify(e.constraints ?? e.children),
  );

describe('home card DTO image URLs', () => {
  it('accepts empty picture fields (tiles without a picture, grid card with no big image)', async () => {
    const body = {
      title: 'Shop by class',
      layout: 'grid4',
      imageUrl: '',
      tiles: [{ label: 'O Level', imageUrl: '', link: '/?class=o-level' }],
    };
    expect(await errorsOf(CreateHomeCardDto, body)).toEqual([]);
    expect(await errorsOf(UpdateHomeCardDto, body)).toEqual([]);
  });

  it('accepts https pictures and still rejects non-https ones', async () => {
    expect(
      await errorsOf(CreateHomeCardDto, {
        title: 'x',
        imageUrl: 'https://res.cloudinary.com/a.jpg',
      }),
    ).toEqual([]);
    expect(
      (
        await errorsOf(CreateHomeCardDto, {
          title: 'x',
          imageUrl: 'http://a.com/a.jpg',
        })
      ).join(),
    ).toContain('https URL');
    expect(
      (
        await errorsOf(UpdateHomeCardDto, {
          tiles: [{ imageUrl: 'javascript:alert(1)' }],
        })
      ).length,
    ).toBe(1);
  });
});
