/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock-heavy tests */
/**
 * App backend gap #2: course builder / roster routes answer 400 on a bad id
 * (never 500), and titles over the limit are a 400 instead of being cut.
 */
import { BadRequestException, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CoursesController } from './classroom.controllers';
import { CoursesService } from './courses.service';
import { cleanCourseInput } from './course.util';
import { COURSE_LIMITS } from './schemas/course.schema';
import { bootController, OID } from '../common/testing/http-harness.helper-spec';

describe('course builder / roster routes: bad ids', () => {
  let app: INestApplication;
  const svc: any = {
    getForSeller: jest.fn().mockResolvedValue({ success: true, data: {} }),
    studentsForSeller: jest.fn().mockResolvedValue({ success: true, data: {} }),
    saveForSeller: jest.fn().mockResolvedValue({ success: true, data: {} }),
    voiceForSeller: jest.fn(),
    rosterForSeller: jest.fn().mockResolvedValue({ success: true, data: {} }),
    rosterStudentDetail: jest.fn().mockResolvedValue({ success: true, data: {} }),
  };
  beforeAll(async () => {
    app = await bootController(CoursesController, [{ provide: CoursesService, useValue: svc }]);
  });
  afterAll(() => app.close());
  const seller = { 'x-test-user': `${OID}:seller` };

  it.each([
    ['get', '/api/courses/seller/product/' + OID],
    ['get', `/api/courses/seller/${OID}/not-a-product`],
    ['get', '/api/courses/seller/students/' + OID],
    ['get', `/api/courses/seller/${OID}/xyz/students`],
    ['get', `/api/courses/seller/bad/${OID}/lessons/aaaaaaaaaaaa/voice`],
    ['put', `/api/courses/seller/bad/${OID}`],
    ['get', '/api/courses/seller/bad/roster'],
    ['get', `/api/courses/seller/${OID}/roster/student/nope`],
  ])('%s %s -> 400 Invalid id', async (method, url) => {
    const res = await (request(app.getHttpServer()) as any)[method](url).set(seller).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid id');
  });

  it('valid ids reach the service', async () => {
    const res = await request(app.getHttpServer()).get(`/api/courses/seller/${OID}/${OID}`).set(seller);
    expect(res.status).toBe(200);
    expect(svc.getForSeller).toHaveBeenCalledWith(OID, OID, OID);
  });
});

describe('course titles over the limit', () => {
  const lesson = (title: string) => ({ title, type: 'text', text: 'Hello' });
  it('a section title over 120 characters is a 400 with a message (not cut)', () => {
    const long = 'S'.repeat(COURSE_LIMITS.sectionTitle + 1);
    expect(() => cleanCourseInput({ sections: [{ title: long, lessons: [lesson('L1')] }] })).toThrow(
      new BadRequestException('Section 1 title must be at most 120 characters'),
    );
  });
  it('a lesson title over 150 characters is a 400 with a message (not cut)', () => {
    const long = 'L'.repeat(COURSE_LIMITS.lessonTitle + 1);
    expect(() => cleanCourseInput({ sections: [{ title: 'Week 1', lessons: [lesson(long)] }] })).toThrow(
      new BadRequestException('Lesson 1 in "Week 1" title must be at most 150 characters'),
    );
  });
  it('titles exactly at the limit are kept whole', () => {
    const s = 'S'.repeat(120);
    const l = 'L'.repeat(150);
    const out = cleanCourseInput({ sections: [{ title: s, lessons: [lesson(l)] }] });
    expect(out.sections[0].title).toBe(s);
    expect(out.sections[0].lessons[0].title).toBe(l);
  });
});
