/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/**
 * App backend gap #1: a malformed refund-request / order / store id is a 400
 * ("Invalid id") and an unknown well-formed id is a 404 - never a 500/502.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RefundRequestController } from './refund-request.controller';
import { RefundRequestService } from './refund-request.service';
import { bootController, OID } from '../common/testing/http-harness.helper-spec';
import { DatabaseService } from '../database/databaseservice';

describe('refund-request routes: bad and unknown ids', () => {
  let app: INestApplication;
  const nullQuery = () => ({ lean: jest.fn().mockResolvedValue(null), select: jest.fn().mockReturnThis() });
  const repos: any = {
    orderModel: { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })) },
    storeModel: { findById: jest.fn(() => nullQuery()), findOne: jest.fn(() => nullQuery()) },
  };
  repos.refundRequestModel = { findOne: jest.fn(() => nullQuery()) };
  const db: any = { repositories: repos };
  const svc = new RefundRequestService(db, {} as any, {} as any, {} as any, { log: jest.fn() } as any);

  beforeAll(async () => {
    app = await bootController(RefundRequestController, [
      { provide: RefundRequestService, useValue: svc },
      { provide: DatabaseService, useValue: db },
    ]);
  });
  afterAll(() => app.close());

  const seller = { 'x-test-user': `${OID}:seller` };
  const buyer = { 'x-test-user': `${OID}:user` };

  it.each([
    ['patch', '/api/refund-request/not-an-id/approve', seller, undefined],
    ['patch', '/api/refund-request/123/reject', seller, { notes: 'Item was used and damaged' }],
    ['patch', '/api/refund-request/zz/follow-up', seller, { step: 'item_received' }],
    ['get', '/api/refund-request/order/xyz', buyer, undefined],
    ['get', '/api/refund-request/seller/bad-store', seller, undefined],
  ])('%s %s -> 400 Invalid id', async (method, url, headers, body) => {
    const res = await (request(app.getHttpServer()) as any)[method](url).set(headers).send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid id');
  });

  it('unknown refund-request id -> 404 on approve and reject', async () => {
    const a = await request(app.getHttpServer()).patch(`/api/refund-request/${OID}/approve`).set(seller);
    expect(a.status).toBe(404);
    expect(a.body.message).toBe('Refund request not found');
    const r = await request(app.getHttpServer())
      .patch(`/api/refund-request/${OID}/reject`).set(seller).send({ notes: 'Item was used and damaged' });
    expect(r.status).toBe(404);
  });

  it('unknown order id -> 404 on the buyer list', async () => {
    const res = await request(app.getHttpServer()).get(`/api/refund-request/order/${OID}`).set(buyer);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Order not found');
  });
});
