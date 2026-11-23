/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/** App backend gap #6: POST /api/rating/:reviewId/report-by-buyer (buyer review report) + GET report-reasons. */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RatingController } from './rating.controller';
import { RatingService } from './rating.service';
import { RatingSellerService } from './rating-seller.service';
import { ReportSchema } from '../messaging/schemas/report.schema';
import { bootController, OID } from '../common/testing/http-harness.helper-spec';

const BUYER = '0123456789abcdef0123aaaa';
const AUTHOR = '0123456789abcdef0123bbbb';

function makeRepos(opts: { review?: any; existing?: boolean; today?: number; dup?: boolean } = {}) {
  const review = opts.review === undefined ? { _id: OID, userId: AUTHOR, storeId: 'store-1' } : opts.review;
  return {
    ratingModel: { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(review) }) })) },
    reportModel: {
      exists: jest.fn().mockResolvedValue(opts.existing ? { _id: 'r' } : null),
      countDocuments: jest.fn().mockResolvedValue(opts.today ?? 0),
      create: jest.fn(async (doc: any) => {
        if (opts.dup) throw Object.assign(new Error('dup'), { code: 11000 });
        return { _id: 'rep-1', ...doc };
      }),
    },
  } as any;
}

describe('buyer review report', () => {
  let app: INestApplication;
  let repos: any;
  const activity = { log: jest.fn() };
  const tools = new RatingSellerService({ get repositories() { return repos; } } as any, undefined, activity as any);

  beforeAll(async () => {
    app = await bootController(RatingController, [
      { provide: RatingService, useValue: {} },
      { provide: RatingSellerService, useValue: tools },
    ]);
  });
  afterAll(() => app.close());
  beforeEach(() => { repos = makeRepos(); activity.log.mockClear(); });
  const post = (id: string, who: string, body: any) =>
    request(app.getHttpServer()).post(`/api/rating/${id}/report-by-buyer`).set({ 'x-test-user': who }).send(body);

  it('a buyer reports a review: 201, report row in the moderation queue, audit entry', async () => {
    const res = await post(OID, `${BUYER}:user`, { reasonCode: 'spam' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, data: { status: 'pending' } });
    expect(repos.reportModel.create).toHaveBeenCalledWith(expect.objectContaining({
      reporterId: BUYER, reporterRole: 'user', targetType: 'review', targetId: OID, reason: 'Spam', details: null,
    }));
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'review_reported_by_buyer', actorRole: 'user' }));
  });

  it('only buyers: a seller gets 403, no token 401', async () => {
    expect((await post(OID, `${BUYER}:seller`, { reasonCode: 'spam' })).status).toBe(403);
    expect((await request(app.getHttpServer()).post(`/api/rating/${OID}/report-by-buyer`).send({ reasonCode: 'spam' })).status).toBe(401);
  });

  it('validation: bad id 400, unknown reason 400, "other" needs text, own review 400, unknown review 404', async () => {
    expect((await post('nope', `${BUYER}:user`, { reasonCode: 'spam' })).status).toBe(400);
    expect((await post(OID, `${BUYER}:user`, { reasonCode: 'boring' })).body.message).toBe('Choose a valid reason');
    expect((await post(OID, `${BUYER}:user`, { reasonCode: 'other' })).status).toBe(400);
    expect((await post(OID, `${AUTHOR}:user`, { reasonCode: 'spam' })).body.message).toBe('You cannot report your own review');
    repos = makeRepos({ review: null });
    expect((await post(OID, `${BUYER}:user`, { reasonCode: 'spam' })).status).toBe(404);
  });

  it('one report per buyer per review (409), also when two taps race into the unique index', async () => {
    repos = makeRepos({ existing: true });
    const a = await post(OID, `${BUYER}:user`, { reasonCode: 'spam' });
    expect(a.status).toBe(409);
    expect(a.body.message).toBe('You already reported this review');
    repos = makeRepos({ dup: true });
    expect((await post(OID, `${BUYER}:user`, { reasonCode: 'spam' })).status).toBe(409);
  });

  it('daily cap: the 21st report in 24 h is 429', async () => {
    repos = makeRepos({ today: 20 });
    expect((await post(OID, `${BUYER}:user`, { reasonCode: 'spam' })).status).toBe(429);
  });

  it('GET report-reasons lists the reason codes', async () => {
    const res = await request(app.getHttpServer()).get('/api/rating/report-reasons');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining([{ code: 'spam', label: 'Spam', needsText: false }, { code: 'other', label: 'Other', needsText: true }]));
  });

  it('the Report schema has the partial unique index (one buyer report per review)', () => {
    const idx = ReportSchema.indexes().find(([, o]: any) => o?.name === 'one_buyer_report_per_review');
    expect(idx).toBeDefined();
    expect(idx![1]).toMatchObject({ unique: true, partialFilterExpression: { reporterRole: 'user', targetType: 'review' } });
  });
});
