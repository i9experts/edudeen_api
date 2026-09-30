/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- mock-heavy tests */
import { CategoriesController } from './categories.controller';

describe('CategoriesController — admin routes pass the actor to the service', () => {
  const req: any = { user: { userId: 'admin-1' }, ip: '9.9.9.9', headers: { 'user-agent': 'jest' } };
  const meta = { adminId: 'admin-1', ip: '9.9.9.9', userAgent: 'jest' };
  const service: any = {
    updateCategory: jest.fn().mockResolvedValue('u'),
    reorderCategories: jest.fn().mockResolvedValue('r'),
    deleteCategory: jest.fn().mockResolvedValue('d'),
  };
  const controller = new CategoriesController(service);

  it('update / reorder / delete forward the admin id, ip and user agent', async () => {
    await controller.update(req, 'c1', { name: 'x' });
    expect(service.updateCategory).toHaveBeenCalledWith('c1', { name: 'x' }, meta);
    await controller.reorder(req, { items: [] });
    expect(service.reorderCategories).toHaveBeenCalledWith({ items: [] }, meta);
    await controller.remove(req, 'c1', 'c2');
    expect(service.deleteCategory).toHaveBeenCalledWith('c1', 'c2', meta);
  });
});
