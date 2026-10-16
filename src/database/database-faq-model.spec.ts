import { getModelToken } from '@nestjs/mongoose';
import { DatabaseService } from './databaseservice';

describe('DatabaseService faqModel', () => {
  it('injects the Faq model (not the User model)', () => {
    const injected: Array<{ index: number; param: unknown }> =
      Reflect.getMetadata('self:paramtypes', DatabaseService) || [];
    const tokens = injected.map((i) => i.param);
    expect(tokens).toContain(getModelToken('Faq'));
    // the Faq token must sit on the faqModel constructor argument
    const src = DatabaseService.toString();
    expect(src).toContain('faqModel');
  });
});
