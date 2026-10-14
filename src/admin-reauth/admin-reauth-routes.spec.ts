import 'reflect-metadata';
import { AdminReauthGuard } from './admin-reauth.guard';
import { AdminConfigController } from '../admin-config/admin-config.controller';
import { CategoriesController } from '../categories/categories.controller';
import { FaqController } from '../faqs/faq.controller';
import { AdminMarketingController } from '../admin-marketing/admin-marketing.controller';

/** Guards live on the method or the class (Nest stores them under '__guards__'). */
function guardsFor(ctrl: any, method: string): unknown[] {
  return [
    ...(Reflect.getMetadata('__guards__', ctrl.prototype[method]) ?? []),
    ...(Reflect.getMetadata('__guards__', ctrl) ?? []),
  ];
}

describe('inline-edit write routes carry AdminReauthGuard', () => {
  const cases: [string, any, string[]][] = [
    ['AdminConfigController', AdminConfigController, ['updateHomeContent', 'updateSellerPage', 'updateSocialLinks', 'updateChatbot']],
    ['CategoriesController', CategoriesController, ['addCategory', 'reorder', 'update', 'remove']],
    ['AdminMarketingController', AdminMarketingController, ['updateCampaign', 'setCampaignStatus']],
    ['FaqController', FaqController, ['create', 'update', 'toggle', 'remove']],
  ];
  for (const [name, ctrl, methods] of cases) {
    for (const m of methods) {
      it(`${name}.${m}`, () => {
        expect(guardsFor(ctrl, m)).toContain(AdminReauthGuard);
      });
    }
  }
});
