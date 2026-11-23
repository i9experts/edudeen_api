/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- mock-heavy tests */
/** App backend gap #8: GET /api/cart/buy-now is buyer-only (role 'user'), like create-checkout. */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { bootController, OID } from '../common/testing/http-harness.helper-spec';

describe('GET /api/cart/buy-now roles', () => {
  let app: INestApplication;
  const cart = { getBuyNowCart: jest.fn().mockResolvedValue({ success: true, data: [] }) };
  beforeAll(async () => {
    app = await bootController(CartController, [{ provide: CartService, useValue: cart }]);
  });
  afterAll(() => app.close());
  const get = (role?: string) => {
    const r = request(app.getHttpServer()).get(`/api/cart/buy-now?productId=${OID}&variantId=${OID}`);
    return role ? r.set({ 'x-test-user': `${OID}:${role}` }) : r;
  };

  it('buyer -> 200', async () => {
    expect((await get('user')).status).toBe(200);
    expect(cart.getBuyNowCart).toHaveBeenCalledWith(OID, OID, OID, undefined);
  });
  it('seller and admin -> 403, nobody -> 401', async () => {
    cart.getBuyNowCart.mockClear();
    expect((await get('seller')).status).toBe(403);
    expect((await get('admin')).status).toBe(403);
    expect((await get()).status).toBe(401);
    expect(cart.getBuyNowCart).not.toHaveBeenCalled();
  });
});
