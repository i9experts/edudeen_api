/** App backend gap #9: every route under /api/seller/manual-payments answers 410 Gone with one clear message. */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SELLER_MANUAL_PAYMENTS_GONE, SellerManualPaymentsController } from './seller-manual-payments.controller';
import { bootController, OID } from '../common/testing/http-harness.helper-spec';

describe('retired seller manual-payments routes', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await bootController(SellerManualPaymentsController, []); });
  afterAll(() => app.close());

  it.each([
    ['get', `/api/seller/manual-payments/${OID}/settings`],
    ['put', `/api/seller/manual-payments/${OID}/settings`],
    ['get', `/api/seller/manual-payments/${OID}/proofs`],
    ['get', `/api/seller/manual-payments/${OID}/proofs/${OID}/proof-url`],
    ['patch', `/api/seller/manual-payments/${OID}/proofs/${OID}/approve`],
    ['patch', `/api/seller/manual-payments/${OID}/proofs/${OID}/reject`],
    ['post', '/api/seller/manual-payments/bad-id/anything'],
    ['get', '/api/seller/manual-payments'],
  ])('%s %s -> 410 with the retirement message (no auth, no body checks)', async (method, url) => {
    const res = await (request(app.getHttpServer()) as any)[method](url).send({ junk: true });
    expect(res.status).toBe(410);
    expect(res.body.message).toBe(SELLER_MANUAL_PAYMENTS_GONE);
  });
});
