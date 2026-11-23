/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/** App backend gap #10: DELETE /api/upload/private-file - owner-scoped, unused files only, audit-logged. */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { UploadedAssetsService } from './uploaded-assets.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { bootController } from '../common/testing/http-harness.helper-spec';

const OWNER = '0123456789abcdef0123aaaa';
const OTHER = '0123456789abcdef0123bbbb';
const PID = 'r2/private/digital-products/1111-test.pdf';

describe('DELETE /api/upload/private-file', () => {
  let app: INestApplication;
  let rows: Map<string, any>;
  let productRef = false;
  let courseRef = false;
  const repos: any = {
    uploadedAssetModel: {
      findOne: jest.fn((q: any) => ({ lean: () => Promise.resolve(rows.get(q.publicId) ?? null) })),
      deleteOne: jest.fn(async (q: any) => { rows.delete(q.publicId); return {}; }),
      updateOne: jest.fn(async (q: any, u: any) => { if (!rows.has(q.publicId)) rows.set(q.publicId, { ...u.$setOnInsert, publicId: q.publicId }); return {}; }),
    },
    productModel: { exists: jest.fn(async () => (productRef ? { _id: 'p' } : null)) },
    courseModel: { exists: jest.fn(async () => (courseRef ? { _id: 'c' } : null)) },
    storeModel: { findOne: jest.fn(() => ({ select: () => ({ lean: () => ({ catch: () => Promise.resolve({ _id: 'store-1' }) }) }) })) },
  };
  const db: any = { repositories: repos };
  const storage = { deletePrivateFile: jest.fn().mockResolvedValue(undefined) };
  const activity = { log: jest.fn().mockResolvedValue(true) };

  beforeAll(async () => {
    app = await bootController(UploadController, [
      { provide: UploadService, useValue: storage },
      { provide: UploadedAssetsService, useValue: new UploadedAssetsService(db) },
      { provide: ActivityLogService, useValue: activity },
      { provide: DatabaseService, useValue: db },
    ]);
  });
  afterAll(() => app.close());
  beforeEach(() => {
    rows = new Map([[PID, { _id: 'a1', publicId: PID, ownerId: OWNER, ownerRole: 'seller', kind: 'digital_product', resourceType: 'raw', fileName: 'test.pdf', fileSize: 10 }]]);
    productRef = false; courseRef = false;
    storage.deletePrivateFile.mockReset().mockResolvedValue(undefined);
    activity.log.mockClear();
  });
  const del = (who: string, publicId?: string) =>
    request(app.getHttpServer()).delete('/api/upload/private-file').query(publicId === undefined ? {} : { publicId }).set({ 'x-test-user': who });

  it('the owner deletes an unused file: storage + record removed, audit entry written', async () => {
    const res = await del(`${OWNER}:seller`, PID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'File deleted', data: { publicId: PID } });
    expect(storage.deletePrivateFile).toHaveBeenCalledWith(PID, 'raw');
    expect(rows.has(PID)).toBe(false);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'private_file_deleted', targetId: PID, actorId: OWNER, storeId: 'store-1' }));
  });

  it("someone else's file and an unknown file both answer 404; nothing is deleted", async () => {
    expect((await del(`${OTHER}:seller`, PID)).status).toBe(404);
    expect((await del(`${OWNER}:seller`, 'r2/private/digital-products/nope.pdf')).status).toBe(404);
    expect(storage.deletePrivateFile).not.toHaveBeenCalled();
    expect(rows.has(PID)).toBe(true);
  });

  it('a file used by a product or a course lesson is 409 and kept', async () => {
    productRef = true;
    expect((await del(`${OWNER}:seller`, PID)).status).toBe(409);
    productRef = false; courseRef = true;
    const res = await del(`${OWNER}:seller`, PID);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This file is used by a product or course. Remove it there first.');
    expect(storage.deletePrivateFile).not.toHaveBeenCalled();
    expect(rows.has(PID)).toBe(true);
  });

  it('storage refusing puts the record back (409, retry later)', async () => {
    storage.deletePrivateFile.mockRejectedValue(new Error('boom'));
    expect((await del(`${OWNER}:seller`, PID)).status).toBe(409);
    expect(rows.get(PID)).toMatchObject({ ownerId: OWNER, kind: 'digital_product' });
    expect(activity.log).not.toHaveBeenCalled();
  });

  it('verification documents cannot be deleted here; publicId is required; sellers only', async () => {
    rows.set('private/kyc-documents/x', { publicId: 'private/kyc-documents/x', ownerId: OWNER, kind: 'kyc_document', resourceType: 'raw' });
    expect((await del(`${OWNER}:seller`, 'private/kyc-documents/x')).status).toBe(400);
    expect((await del(`${OWNER}:seller`)).status).toBe(400);
    expect((await del(`${OWNER}:user`, PID)).status).toBe(403);
  });
});
